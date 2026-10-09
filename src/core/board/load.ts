import { loadConfig } from '../config/schema.js';
import type { ConfigResult } from '../config/schema.js';
import { BoardError } from '../errors.js';
import type {
  BoardConfig,
  Issue,
  IssueNode,
  Period,
  PeriodNode,
  Problem,
  Resource,
  ResourceNode,
  Squad,
  SquadNode,
  Template,
  TemplateNode,
} from '../model/types.js';
import { owningSquad } from '../../shared/routing.js';
import type { DocStamp } from '../storage/atomic.js';
import { stampOf } from '../storage/atomic.js';
import type { BoardPaths } from '../storage/paths.js';
import { displayPath } from '../storage/paths.js';
import type { DocumentCache } from './load/cache.js';
export { DocumentCache } from './load/cache.js';
import {
  readBoolean,
  readDate,
  readIdList,
  readNumber,
  readParams,
  readString,
  readTextList,
} from './load/fields.js';
import type { LoadContext } from './load/scan.js';
import { specFor } from './load/scan.js';
import { buildTree, indexById, loadCollection } from './load/tree.js';

/**
 * Placeholder id for a document that has none yet (hand-created folder).
 * `check --fix` replaces these with allocated ids.
 */
export const UNASSIGNED_PREFIX = '#unassigned:';

export function isUnassigned(id: string): boolean {
  return id.startsWith(UNASSIGNED_PREFIX);
}

/** Full-time equivalents a resource supplies when it declares no `capacity`. */
export const DEFAULT_CAPACITY = 1;

export interface LoadedBoard {
  paths: BoardPaths;
  config: BoardConfig;

  issues: Issue[];
  roots: IssueNode[];
  byId: Map<string, Issue>;

  periods: Period[];
  periodRoots: PeriodNode[];
  periodsById: Map<string, Period>;

  resources: Resource[];
  resourceRoots: ResourceNode[];
  resourcesById: Map<string, Resource>;

  squads: Squad[];
  squadRoots: SquadNode[];
  squadsById: Map<string, Squad>;

  /** The template registry: reusable pieces of plan, in registry order. */
  templates: Template[];
  templateTree: TemplateNode[];
  templatesById: Map<string, Template>;

  /** id -> ids that declare a dependency on it (the inverse of `depends_on`). */
  dependents: Map<string, string[]>;
  /** Generic resource id -> ids that can cover it (the inverse of `covers`). */
  coveredBy: Map<string, string[]>;
  /** Resource id -> squad ids it belongs to (the inverse of `members`). */
  squadOf: Map<string, string[]>;
  /** Period id -> set of resource ids that can work in this period (pre-computed from squad). */
  periodSquadMembers: Map<string, Set<string>>;

  /** node.dir -> fields synthesized during load because they were missing on disk. */
  derived: Map<string, string[]>;
  /** node.dir -> frontmatter keys not declared for that node's type. */
  extras: Map<string, string[]>;
  /** Structural problems found while reading (unreadable or malformed files). */
  problems: Problem[];

  /**
   * node.file -> the identity of that file when this handle read it.
   *
   * What makes a stale write detectable. Core operations write straight to
   * disk, so every handle is a photograph of a moment; on a shared checkout
   * somebody else may have moved on since. `requireUnchanged` compares a stamp
   * with the file before writing, and `writeDocument` replaces it afterwards,
   * so the handle stays honest about what it has seen.
   * @see src/core/storage/atomic.ts
   */
  stamps: Map<string, DocStamp>;
  /**
   * The parse cache this board was loaded with, when it had one, so an
   * operation that has to re-read under the lock can do it cheaply.
   */
  cache?: DocumentCache;
}

export function buildBoard(paths: BoardPaths, config: BoardConfig, options?: { cache?: DocumentCache }): LoadedBoard {
  const ctx: LoadContext = {
    paths,
    config,
    problems: [],
    derived: new Map(),
    extras: new Map(),
    stamps: new Map(),
    cache: options?.cache,
  };

  // `load` never opens the index — it is derived, not truth — but it does need
  // to know which version of it this handle's contents correspond to, so an
  // incremental rewrite can tell that somebody else has moved it on.
  // @see src/core/operations/board-index.ts
  const indexStamp = stampOf(paths.indexPath);
  if (indexStamp) ctx.stamps.set(paths.indexPath, indexStamp);

  const issueSpec = specFor(paths, config, 'issue');
  const issueResult = loadCollection<Issue>(issueSpec, ctx, (base, raw, derived) => {
    let status = readString(raw.data, 'status');
    if (!status) {
      status = config.default_status;
      derived.push('status');
    }
    return {
      ...base,
      kind: 'issue',
      status,
      assignee: readString(raw.data, 'assignee'),
      period: readString(raw.data, 'period'),
      flag: readString(raw.data, 'flag'),
      depends_on: readIdList(raw.data, 'depends_on', raw, ctx),
      relates_to: readIdList(raw.data, 'relates_to', raw, ctx),
      related_files: readTextList(raw.data, 'related_files', raw, ctx, 'path'),
    };
  });

  const periodSpec = specFor(paths, config, 'period');
  const periodResult = loadCollection<Period>(periodSpec, ctx, (base, raw) => ({
    ...base,
    kind: 'period',
    starts: readDate(raw.data, 'starts'),
    ends: readDate(raw.data, 'ends'),
    active: readBoolean(raw.data, 'active', raw, ctx),
    squad: readString(raw.data, 'squad'),
  }));

  const resourceSpec = specFor(paths, config, 'resource');
  const resourceResult = loadCollection<Resource>(resourceSpec, ctx, (base, raw, derived) => {
    const capacity = readNumber(raw.data, 'capacity', raw, ctx);
    if (capacity === undefined) derived.push('capacity');
    return {
      ...base,
      kind: 'resource',
      capacity: capacity ?? DEFAULT_CAPACITY,
      covers: readIdList(raw.data, 'covers', raw, ctx),
    };
  });

  const templateSpec = specFor(paths, config, 'template');
  const templateResult = loadCollection<Template>(templateSpec, ctx, (base, raw) => {
    return {
      ...base,
      kind: 'template',
      // An empty description is not a derived field: nothing can invent one, so
      // `check` reports it on a root and `--fix` leaves it alone.
      description: readString(raw.data, 'description') ?? '',
      params: readParams(raw.data, 'params', raw, ctx),
      depends_on: readIdList(raw.data, 'depends_on', raw, ctx),
      relates_to: readIdList(raw.data, 'relates_to', raw, ctx),
      related_files: readTextList(raw.data, 'related_files', raw, ctx, 'path'),
    };
  });

  const squadSpec = specFor(paths, config, 'squad');
  const squadResult = loadCollection<Squad>(squadSpec, ctx, (base, raw) => ({
    ...base,
    kind: 'squad',
    members: readIdList(raw.data, 'members', raw, ctx),
  }));

  const issues = issueResult.nodes;
  const dependents = new Map<string, string[]>();
  const invert = (index: Map<string, string[]>, target: string, id: string): void => {
    const list = index.get(target);
    if (list) list.push(id);
    else index.set(target, [id]);
  };
  for (const issue of issues) {
    for (const target of issue.depends_on) invert(dependents, target, issue.id);
  }

  const coveredBy = new Map<string, string[]>();
  for (const resource of resourceResult.nodes) {
    for (const target of resource.covers) {
      const list = coveredBy.get(target);
      if (list) list.push(resource.id);
      else coveredBy.set(target, [resource.id]);
    }
  }

  const squadOf = new Map<string, string[]>();
  for (const squad of squadResult.nodes) {
    for (const member of squad.members) {
      const list = squadOf.get(member);
      if (list) list.push(squad.id);
      else squadOf.set(member, [squad.id]);
    }
  }

  const periodSquadMembers = new Map<string, Set<string>>();
  // Build a temporary id→period map so we can walk the parent chain for
  // squad inheritance before the board is assembled.
  const periodLookup = new Map(periodResult.nodes.map((p): [string, typeof p] => [p.id, p]));
  for (const period of periodResult.nodes) {
    // Walk up the parent chain: first squad we find wins. Shared with the
    // queue panel, which asks the same question of the working copy.
    const squadId = owningSquad(period.id, (id) => periodLookup.get(id));
    if (squadId) {
      const squad = squadResult.nodes.find((s) => s.id === squadId);
      if (squad) periodSquadMembers.set(period.id, new Set(squad.members));
    }
  }

  return {
    paths,
    config,
    issues,
    roots: buildTree<Issue, IssueNode>(issues, issueResult.raws),
    byId: indexById(issues),
    periods: periodResult.nodes,
    periodRoots: buildTree<Period, PeriodNode>(periodResult.nodes, periodResult.raws),
    periodsById: indexById(periodResult.nodes),
    resources: resourceResult.nodes,
    resourceRoots: buildTree<Resource, ResourceNode>(resourceResult.nodes, resourceResult.raws),
    resourcesById: indexById(resourceResult.nodes),
    squads: squadResult.nodes,
    squadRoots: buildTree<Squad, SquadNode>(squadResult.nodes, squadResult.raws),
    squadsById: indexById(squadResult.nodes),
    templates: templateResult.nodes,
    templateTree: buildTree<Template, TemplateNode>(templateResult.nodes, templateResult.raws),
    templatesById: indexById(templateResult.nodes),
    dependents,
    coveredBy,
    squadOf,
    periodSquadMembers,
    derived: ctx.derived,
    extras: ctx.extras,
    problems: ctx.problems,
    stamps: ctx.stamps,
    cache: options?.cache,
  };
}

export function loadBoard(paths: BoardPaths, options?: { cache?: DocumentCache }): LoadedBoard {
  const cache = options?.cache;
  let configResult;
  if (cache) {
    const cached = cache.get(paths.configPath);
    if (cached) {
      // Config cache stores parsed config in data._config — see the set path below.
      configResult = cached.data._config as ConfigResult;
    }
  }
  if (!configResult) {
    configResult = loadConfig(paths);
    if (cache && configResult.config) {
      // Wrap so cache.set deep-freezes it.
      cache.set(paths.configPath, { data: { _config: configResult } as unknown as Record<string, unknown>, body: '' });
    }
  }
  const { config, errors } = configResult;
  if (!config) {
    throw new BoardError(`Invalid board config (${displayPath(paths, paths.configPath)})`, errors);
  }
  return buildBoard(paths, config, options);
}
