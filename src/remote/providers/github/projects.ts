/**
 * Projects v2 node-id resolution and caching (LP-310).
 *
 * Projects v2 is GraphQL-only and everything in it is a node id: the project,
 * every field, and every option of a single-select field. A config that names
 * a Project as `project: 7` or a title, and its fields in plain words, must
 * not have to carry a `PVT_...` identifier — and nobody should have to read
 * one. This module resolves those names to node ids once, caches the result
 * under `.lpm/remotes/<name>/github.json` (committed, so a teammate's first
 * sync is a read rather than a full re-resolution), and detects a field or
 * option renamed upstream — reported with both names, never treated as
 * "missing", which is exactly the mistake that would send `provision` off to
 * create a duplicate.
 *
 * ## Cache by name, verify by id
 *
 * The cache keys fields and options by *name*, because a name is the only key
 * a person writes. When the ids are re-resolved (a `--refresh`, or a cache
 * miss) the fresh ids are compared against the cached ones: a cached id that
 * survives under a new name is a rename, and is reported rather than dropped.
 *
 * ## Pure vs I/O
 *
 * The split mirrors `capabilities.ts`: `resolveProjectGraphql` is the network
 * half (no disk), `loadProjectCache` / `saveProjectCache` the disk half, and
 * `resolveProjectIds` the orchestrator that decides when a cache hit is good
 * enough and when a fresh resolution must run.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from '../../../core/errors.js';
import type { BoardPaths } from '../../../core/storage/paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One iteration of a Project's iteration field (LP-313). */
export interface ProjectIteration {
  /** The iteration's GraphQL node id. */
  id: string;
  /** The iteration title — the period's name on the wire. */
  title: string;
  /** `YYYY-MM-DD`, the iteration's start date. */
  startDate: string;
  /** The iteration's fixed length in days, set on the field. */
  duration: number;
}

/** One Project field's resolved ids: the field's node id and, for a single
 * select, each option's node id keyed by option name; for an iteration field,
 * each iteration keyed by title. */
export interface ProjectFieldIds {
  /** The field's GraphQL node id (`PVTF_...`). */
  id: string;
  /** The field's name, as the Project reports it today. */
  name: string;
  /** The ProjectV2FieldType — `TEXT`, `NUMBER`, `DATE`, `SINGLE_SELECT`, `ITERATION`, ... */
  type: string;
  /** Option name → node id. Present only on a single-select field. */
  options: Record<string, string>;
  /** The field's iterations, in order. Present only on an iteration field. */
  iterations?: ProjectIteration[];
}

/** One Project's resolved ids: the project node id plus every field. */
export interface ProjectIds {
  project: { id: string; number: number | null; title: string };
  /** Every field, keyed by field name. */
  fields: Record<string, ProjectFieldIds>;
}

/** What lives on disk inside `.lpm/remotes/<name>/github.json`. */
export interface ProjectCacheFile {
  version: 1;
  /** ISO timestamp of the resolution that produced this file. */
  resolvedAt: string;
  project: { id: string; number: number | null; title: string };
  fields: Record<string, ProjectFieldIds>;
}

/** A field the mapping names that no longer resolves as it did. */
export type FieldFinding =
  /** The field's id survives under a new name — a rename, reported with both. */
  | { kind: 'renamed'; name: string; id: string; newName: string }
  /** No field by that name, and no cached id survives — genuinely absent. */
  | { kind: 'missing'; name: string };

/** An option of a single-select field that no longer resolves as it did. */
export type OptionFinding =
  | { kind: 'renamed'; field: string; name: string; id: string; newName: string }
  | { kind: 'missing'; field: string; name: string };

/** The connector surface the resolver needs: a GraphQL entry point. */
export interface ProjectGraphqlConnector {
  readonly name: string;
  graphql?(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** The GitHub-specific slice the resolver reads: the repo, the Project
 * reference, and the field names the mapping declares. */
export interface GithubProjectInput {
  /** `owner/repo`, the repository whose Project holds the board's fields. */
  repo: string;
  /** `project: 7` or `project: "Payments Board"` — a number or a title. */
  project?: number | string;
  /** Board field → Project field name; the values are what gets resolved. */
  fields: Record<string, string>;
}

/** Options for `resolveProjectIds`. */
export interface ResolveProjectOptions {
  /** Re-resolve even when a cache exists. */
  refresh?: boolean;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** What `resolveProjectIds` returns. */
export interface ResolveProjectIdsResult {
  /** The resolved ids — fresh, or straight from the cache. */
  ids: ProjectIds;
  /** True when a network resolution ran (a cache miss or `--refresh`). */
  refreshed: boolean;
  /** Mapped fields that were renamed or are missing. */
  fieldFindings: FieldFinding[];
  /** Mapped single-select options that were renamed or are missing. */
  optionFindings: OptionFinding[];
}

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

/** Resolve a Project by its number: `projectV2(number:)` is the one exact read. */
const PROJECT_BY_NUMBER_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    projectV2(number: $number) {
      id
      number
      title
    }
  }
}
`;

/** Resolve a Project by its title: list the repo's projects and match the name. */
const PROJECTS_BY_TITLE_QUERY = `
query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    projectsV2(first: 100) {
      nodes {
        id
        number
        title
      }
    }
  }
}
`;

/** Resolve every field of a Project, with each single-select's options and
 * each iteration field's iterations. */
const FIELDS_QUERY = `
query($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      fields(first: 100) {
        nodes {
          id
          name
          ... on ProjectV2Field {
            dataType
          }
          ... on ProjectV2SingleSelectField {
            options(first: 50) {
              nodes {
                id
                name
              }
            }
          }
          ... on ProjectV2IterationField {
            configuration {
              iterations {
                id
                title
                startDate
                duration
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// The network half
// ---------------------------------------------------------------------------

/** Split `owner/repo` into its two parts. */
function repoParts(repo: string): { owner: string; name: string } {
  const slash = repo.indexOf('/');
  if (slash <= 0 || slash === repo.length - 1) {
    throw new BoardError(`Not an owner/repo: "${repo}"`, [
      'The GitHub connection.repo must be "owner/repo".',
    ]);
  }
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

/** The `graphql` entry point, or a `BoardError` when the connector has none. */
function graphqlOf(
  connector: ProjectGraphqlConnector,
): (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>> {
  if (typeof connector.graphql !== 'function') {
    throw new BoardError(`The ${connector.name} connector has no GraphQL API`, [
      'Projects v2 ids are GraphQL-only, so this provider must expose a GraphQL entry point to resolve them.',
    ]);
  }
  return connector.graphql.bind(connector);
}

/** Read `body.data` as a plain record, or throw when the platform answered
 * with errors (a missing repository, a permission loss). */
function dataOf(body: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (body && typeof body === 'object') {
    const errors = body['errors'];
    if (Array.isArray(errors) && errors.length > 0) {
      const first = (errors[0] as { message?: unknown } | undefined)?.message;
      throw new BoardError('GitHub GraphQL answered with errors', [
        typeof first === 'string' ? first : JSON.stringify(errors[0]),
      ]);
    }
    const data = body['data'];
    if (data && typeof data === 'object') return data as Record<string, unknown>;
  }
  return {};
}

/** Read a field's `dataType`, defaulting to a plain name when absent. */
function fieldTypeOf(node: Record<string, unknown>): string {
  const dataType = node['dataType'];
  return typeof dataType === 'string' ? dataType : '';
}

/** Read a single-select's options as a name → id map. */
function optionsOf(node: Record<string, unknown>): Record<string, string> {
  const options = node['options'];
  const out: Record<string, string> = {};
  if (!options || typeof options !== 'object') return out;
  const nodes = (options as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return out;
  for (const option of nodes) {
    if (!option || typeof option !== 'object') continue;
    const record = option as Record<string, unknown>;
    const id = record['id'];
    const name = record['name'];
    if (typeof id === 'string' && typeof name === 'string') out[name] = id;
  }
  return out;
}

/** Read an iteration field's iterations, in the field's own order. Returns
 * `undefined` for a field with no iteration configuration (every non-iteration
 * field), so the resolved ids stay free of empty keys a caller must ignore. */
function iterationsOf(node: Record<string, unknown>): ProjectIteration[] | undefined {
  const configuration = node['configuration'];
  if (!configuration || typeof configuration !== 'object') return undefined;
  const iterations = (configuration as { iterations?: unknown }).iterations;
  if (!Array.isArray(iterations)) return undefined;
  const out: ProjectIteration[] = [];
  for (const entry of iterations) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record['id'];
    const title = record['title'];
    const startDate = record['startDate'];
    const duration = record['duration'];
    if (typeof id === 'string' && typeof title === 'string') {
      out.push({
        id,
        title,
        startDate: typeof startDate === 'string' ? startDate : '',
        duration: typeof duration === 'number' ? duration : 0,
      });
    }
  }
  return out;
}

/**
 * Resolve one Project's ids over GraphQL: the project node, then every field
 * (and each single-select's options). Pure network — no disk.
 *
 * `input.project` is a number (resolve by `projectV2(number:)`) or a title
 * (resolve by name among the repository's projects). A title that matches
 * nothing, or a number naming no project, is a `BoardError` naming what was
 * asked for.
 */
export async function resolveProjectGraphql(
  connector: ProjectGraphqlConnector,
  input: GithubProjectInput,
): Promise<ProjectIds> {
  if (input.project === undefined) {
    throw new BoardError('No Project declared', [
      'Set mapping.project to a Project number or title before resolving its fields.',
    ]);
  }
  const graphql = graphqlOf(connector);
  const { owner, name } = repoParts(input.repo);

  let project: { id: string; number: number | null; title: string };

  if (typeof input.project === 'number') {
    const body = await graphql(PROJECT_BY_NUMBER_QUERY, { owner, name, number: input.project });
    const repository = (dataOf(body)['repository'] as Record<string, unknown> | null) ?? {};
    const node = (repository['projectV2'] as Record<string, unknown> | null) ?? {};
    const id = node['id'];
    const title = node['title'];
    if (typeof id !== 'string') {
      throw new BoardError(`No Project #${input.project} in ${input.repo}`, [
        'The repository has no Projects v2 project with that number, or the credential cannot see it.',
      ]);
    }
    project = {
      id,
      number: typeof node['number'] === 'number' ? node['number'] : input.project,
      title: typeof title === 'string' ? title : '',
    };
  } else {
    const body = await graphql(PROJECTS_BY_TITLE_QUERY, { owner, name });
    const repository = (dataOf(body)['repository'] as Record<string, unknown> | null) ?? {};
    const projects = (repository['projectsV2'] as { nodes?: unknown } | null) ?? {};
    const nodes = Array.isArray(projects.nodes) ? projects.nodes : [];
    const match = nodes.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      return (entry as Record<string, unknown>)['title'] === input.project;
    }) as Record<string, unknown> | undefined;
    if (!match || typeof match['id'] !== 'string') {
      throw new BoardError(`No Project named "${input.project}" in ${input.repo}`, [
        'The title must match a Projects v2 project in this repository exactly.',
      ]);
    }
    project = {
      id: match['id'],
      number: typeof match['number'] === 'number' ? match['number'] : null,
      title: input.project,
    };
  }

  const body = await graphql(FIELDS_QUERY, { projectId: project.id });
  const node = (dataOf(body)['node'] as Record<string, unknown> | null) ?? {};
  const fieldsConnection = (node['fields'] as { nodes?: unknown } | null) ?? {};
  const fields: Record<string, ProjectFieldIds> = {};
  const rawFields = Array.isArray(fieldsConnection.nodes) ? fieldsConnection.nodes : [];
  for (const entry of rawFields) {
    if (!entry || typeof entry !== 'object') continue;
    const field = entry as Record<string, unknown>;
    const id = field['id'];
    const fieldName = field['name'];
    if (typeof id !== 'string' || typeof fieldName !== 'string') continue;
    fields[fieldName] = {
      id,
      name: fieldName,
      type: fieldTypeOf(field),
      options: optionsOf(field),
      ...(iterationsOf(field) !== undefined ? { iterations: iterationsOf(field) } : {}),
    };
  }

  return { project, fields };
}

// ---------------------------------------------------------------------------
// The cache on disk
// ---------------------------------------------------------------------------

/** The path to one remote's Project ids cache. */
export function projectCachePath(paths: BoardPaths, remoteName: string): string {
  return path.join(paths.remotesDir, remoteName, 'github.json');
}

/** Sort an object's keys, for byte-stable cache writes. */
function sortedRecord<T>(value: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(value).sort()) out[key] = value[key]!;
  return out;
}

/**
 * Read the Project ids cache, or `undefined` when none has been recorded yet.
 * A file that exists but is malformed (or a newer version) is a `BoardError`
 * naming the path; delete it to re-resolve.
 */
export function loadProjectCache(
  paths: BoardPaths,
  remoteName: string,
): ProjectCacheFile | undefined {
  const file = projectCachePath(paths, remoteName);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BoardError(`Cannot parse Project cache: ${file}`, [
      (error as Error).message,
      'Delete it to re-resolve the Project ids, or repair the JSON.',
    ]);
  }

  const cache = parsed as Partial<ProjectCacheFile>;
  if (cache.version !== 1) {
    throw new BoardError(`Unsupported Project cache version in ${file}`, [
      `Found version ${JSON.stringify(cache.version)}; expected 1.`,
      'Delete it to re-resolve the Project ids.',
    ]);
  }
  const project = cache.project as Record<string, unknown> | undefined;
  if (!project || typeof project.id !== 'string') {
    throw new BoardError(`Invalid Project cache: ${file}`, [
      'The cache is missing a valid project id.',
      'Delete it to re-resolve the Project ids.',
    ]);
  }
  const fields = cache.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new BoardError(`Invalid Project cache: ${file}`, [
      'The cache is missing a valid fields object.',
      'Delete it to re-resolve the Project ids.',
    ]);
  }

  // A cache written before iterations were cached (LP-313) still loads — the
  // iteration list is absent, which a fresh resolution refills.
  const normalized: Record<string, ProjectFieldIds> = {};
  for (const [name, field] of Object.entries(fields as Record<string, ProjectFieldIds>)) {
    normalized[name] = {
      ...field,
      options: field.options ?? {},
      ...(field.iterations !== undefined ? { iterations: field.iterations } : {}),
    };
  }

  return {
    version: 1,
    resolvedAt: typeof cache.resolvedAt === 'string' ? cache.resolvedAt : '',
    project: {
      id: project.id,
      number: typeof project['number'] === 'number' ? project['number'] : null,
      title: typeof project['title'] === 'string' ? project['title'] : '',
    },
    fields: normalized,
  };
}

/**
 * Write the Project ids cache to disk, creating the per-remote folder if
 * needed. Field keys and option keys are written sorted so two teammates
 * resolving the same ids on different branches produce a non-overlapping diff.
 */
export function saveProjectCache(
  paths: BoardPaths,
  remoteName: string,
  cache: ProjectCacheFile,
): void {
  const file = projectCachePath(paths, remoteName);
  mkdirSync(path.dirname(file), { recursive: true });

  const fields: Record<string, ProjectFieldIds> = {};
  for (const [name, field] of Object.entries(sortedRecord(cache.fields))) {
    fields[name] = { ...field, options: sortedRecord(field.options) };
  }

  const onDisk: ProjectCacheFile = {
    version: 1,
    resolvedAt: cache.resolvedAt,
    project: cache.project,
    fields,
  };
  writeFileSync(file, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Mismatch detection
// ---------------------------------------------------------------------------

/** Index a field collection by id, so a rename can be traced from the id. */
function byId(fields: Record<string, ProjectFieldIds>): Map<string, ProjectFieldIds> {
  const out = new Map<string, ProjectFieldIds>();
  for (const field of Object.values(fields)) out.set(field.id, field);
  return out;
}

/**
 * Compare a fresh resolution against the previous cache, for the fields the
 * mapping names. A cached id that survives under a new name is a rename; a
 * name with no match and no surviving id is missing. Option names are checked
 * the same way, within the fields that still match by id.
 */
export function detectMismatches(
  previous: ProjectCacheFile | undefined,
  fresh: ProjectIds,
  mappedFields: Record<string, string>,
): { fieldFindings: FieldFinding[]; optionFindings: OptionFinding[] } {
  const fieldFindings: FieldFinding[] = [];
  const optionFindings: OptionFinding[] = [];
  const freshById = byId(fresh.fields);

  for (const name of new Set(Object.values(mappedFields))) {
    if (name === '') continue;
    const prev = previous?.fields[name];
    const current = fresh.fields[name];

    if (current !== undefined) {
      // The name resolves today. When it also resolved before, and to the same
      // id, its options are worth checking for renames.
      if (prev !== undefined && prev.id === current.id) {
        const optionById = new Map<string, string>(
          Object.entries(current.options).map(([optionName, optionId]) => [optionId, optionName]),
        );
        for (const [optionName, optionId] of Object.entries(prev.options)) {
          if (current.options[optionName] === optionId) continue;
          const renamed = optionById.get(optionId);
          if (renamed !== undefined) {
            optionFindings.push({
              kind: 'renamed',
              field: name,
              name: optionName,
              id: optionId,
              newName: renamed,
            });
          } else {
            optionFindings.push({ kind: 'missing', field: name, name: optionName });
          }
        }
      }
      continue;
    }

    // The name does not resolve. A previous id that still exists under another
    // name is a rename; otherwise the field is genuinely absent.
    if (prev !== undefined) {
      const renamed = freshById.get(prev.id);
      if (renamed !== undefined && renamed.name !== name) {
        fieldFindings.push({ kind: 'renamed', name, id: prev.id, newName: renamed.name });
      } else {
        fieldFindings.push({ kind: 'missing', name });
      }
    } else {
      fieldFindings.push({ kind: 'missing', name });
    }
  }

  return { fieldFindings, optionFindings };
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

/**
 * Resolve one Project's ids, reading the cache when it exists and re-resolving
 * on a cache miss or `refresh`.
 *
 * The cache is the committed `.lpm/remotes/<name>/github.json`, so a teammate
 * who pulls the board reads the ids instead of re-resolving them; only a cache
 * miss or an explicit `--refresh` reaches the network. When a resolution runs
 * against a previous cache, renamed fields and options are reported with both
 * names (never treated as missing), and the cache is rewritten.
 */
export async function resolveProjectIds(
  connector: ProjectGraphqlConnector,
  input: GithubProjectInput,
  paths: BoardPaths,
  remoteName: string,
  opts: ResolveProjectOptions = {},
): Promise<ResolveProjectIdsResult> {
  const previous = loadProjectCache(paths, remoteName);

  if (previous !== undefined && opts.refresh !== true) {
    return {
      ids: { project: previous.project, fields: previous.fields },
      refreshed: false,
      fieldFindings: [],
      optionFindings: [],
    };
  }

  const fresh = await resolveProjectGraphql(connector, input);
  const { fieldFindings, optionFindings } = detectMismatches(previous, fresh, input.fields);

  const cache: ProjectCacheFile = {
    version: 1,
    resolvedAt: new Date(opts.now ? opts.now() : Date.now()).toISOString(),
    project: fresh.project,
    fields: fresh.fields,
  };
  saveProjectCache(paths, remoteName, cache);

  return {
    ids: fresh,
    refreshed: true,
    fieldFindings,
    optionFindings,
  };
}
