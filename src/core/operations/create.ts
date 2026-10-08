import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { LoadedBoard } from '../board/load.js';
import { DEFAULT_CAPACITY } from '../board/load.js';
import { BoardError } from '../errors.js';
import type { Issue, ParamDefs, Period, Resource, Squad, Template } from '../model/types.js';
import { hasPeriods, hasResources, hasSquads, isFolderTemplate } from '../model/types.js';
import { nowIso } from '../storage/document.js';
import { gitIdentity } from '../storage/git.js';
import { collectionDir, documentFileName } from '../storage/paths.js';
import { writeBoardIndex } from './board-index.js';
import { propagateStatus } from './rollup.js';
import {
  allocateFor,
  boardWrite,
  buildAttributes,
  normalizeFileRefs,
  prepareFolder,
  requireCapacity,
  requireDates,
  requirePeriod,
  requireResource,
  requireStatus,
  resolveCoverTargets,
  resolveLinkTargets,
  resolveParentFor,
  resolveTemplateLinkTargets,
  typeDefOf,
  writeDocument,
} from './shared.js';

export interface NewIssueInput {
  type: string;
  title: string;
  status?: string;
  /** Parent issue id; omit to create at the board root. */
  parentId?: string;
  /** Period to schedule the issue in. */
  period?: string;
  /** Resource to assign the issue to — a person or a pool, by id or name. */
  assignee?: string;
  dependsOn?: string[];
  relatesTo?: string[];
  /** Files this issue is about: the requirement, the source that has to change. */
  relatedFiles?: string[];
  attributes?: Record<string, unknown>;
  author?: string;
}

export function createIssue(board: LoadedBoard, input: NewIssueInput): Issue {
  // Locked for the id as much as for the document: `allocateFor` reads the
  // counter, bumps it and writes it back, so two processes creating an issue
  // at the same moment would otherwise both be handed the same id.
  return boardWrite(board, 'create an issue', () => createIssueUnderLock(board, input));
}

function createIssueUnderLock(board: LoadedBoard, input: NewIssueInput): Issue {
  const typeDef = typeDefOf(board, 'issue', input.type);
  const title = input.title.trim();
  if (!title) throw new BoardError('Issue title cannot be empty');

  const parent = resolveParentFor(board, 'issue', input.type, input.parentId);
  const status = input.status ?? board.config.default_status;
  requireStatus(board, status);

  if (input.period) requirePeriod(board, input.period);
  const assignee = input.assignee ? requireResource(board, input.assignee).id : null;
  const dependsOn = resolveLinkTargets(board, input.dependsOn ?? []);
  const relatesTo = resolveLinkTargets(board, input.relatesTo ?? []);

  const attributes = buildAttributes(typeDef, input.type, input.attributes);
  const id = allocateFor(board, 'issue');
  const dir = prepareFolder(board, parent ? parent.dir : board.paths.boardDir, id);
  const timestamp = nowIso();

  const issue: Issue = {
    kind: 'issue',
    id,
    type: input.type,
    title,
    status,
    assignee,
    period: input.period ?? null,
    // A new issue is never flagged: nobody has started it yet.
    flag: null,
    depends_on: dependsOn,
    relates_to: relatesTo,
    related_files: normalizeFileRefs(input.relatedFiles ?? []),
    created: timestamp,
    updated: timestamp,
    author: input.author ?? gitIdentity(board.paths.lpmDir),
    attributes,
    body: typeDef.body,
    dir,
    file: path.join(dir, documentFileName('issue')),
    parentId: parent ? parent.id : null,
    depth: parent ? parent.depth + 1 : 0,
  };

  writeDocument(board, issue);
  writeBoardIndex(board, { node: issue });
  // Open work inside a container that claimed to be finished reopens it — the
  // same rule `moveNode` applies, since adding a story is one more way for a
  // closed feature to stop being true. It writes nothing when the parent is
  // open, which is every ordinary create. @see src/shared/rollup.ts
  propagateStatus(board, issue, issue.status);
  return issue;
}

export interface NewPeriodInput {
  type: string;
  title: string;
  starts: string;
  ends: string;
  /** Parent period id; omit to create at the top of the timeline. */
  parentId?: string;
  /** The switch over the dates. Omit — the normal case — to let them decide. */
  active?: boolean;
  /** Id of the squad that owns this period. */
  squad?: string;
  attributes?: Record<string, unknown>;
  author?: string;
}

export function createPeriod(board: LoadedBoard, input: NewPeriodInput): Period {
  // Locked for the id as much as for the document: `allocateFor` reads the
  // counter, bumps it and writes it back, so two processes creating a period
  // at the same moment would otherwise both be handed the same id.
  return boardWrite(board, 'create a period', () => createPeriodUnderLock(board, input));
}

function createPeriodUnderLock(board: LoadedBoard, input: NewPeriodInput): Period {
  if (!hasPeriods(board.config)) {
    throw new BoardError('This board has no time hierarchy', [
      'Add period_types, period_hierarchy and period_prefix to .lpm/config.yml.',
    ]);
  }
  const typeDef = typeDefOf(board, 'period', input.type);
  const title = input.title.trim();
  if (!title) throw new BoardError('Period title cannot be empty');
  requireDates(input.starts, input.ends);

  const parent = resolveParentFor(board, 'period', input.type, input.parentId) as Period | null;
  if (parent && parent.starts && parent.ends) {
    if (input.starts < parent.starts || input.ends > parent.ends) {
      throw new BoardError(
        `${input.starts}..${input.ends} falls outside ${parent.id} (${parent.starts}..${parent.ends})`,
        ['A period must fit inside its parent period.'],
      );
    }
  }

  const attributes = buildAttributes(typeDef, input.type, input.attributes);
  const id = allocateFor(board, 'period');
  const parentDir = parent ? parent.dir : collectionDir(board.paths, 'period');
  mkdirSync(parentDir, { recursive: true });
  const dir = prepareFolder(board, parentDir, id);
  const timestamp = nowIso();

  // Validate squad if given
  let squad: string | null = null;
  if (input.squad) {
    if (!board.squadsById.get(input.squad)) {
      throw new BoardError(`No squad with id "${input.squad}"`, [
        board.squads.length
          ? `Available squads: ${board.squads.map((s) => `${s.id} (${s.title})`).join(', ')}`
          : 'This board has no squads. Create one with `lpm new squad -t "..."`.',
      ]);
    }
    squad = input.squad;
  }

  const period: Period = {
    kind: 'period',
    id,
    type: input.type,
    title,
    starts: input.starts,
    ends: input.ends,
    active: input.active,
    squad,
    created: timestamp,
    updated: timestamp,
    author: input.author ?? gitIdentity(board.paths.lpmDir),
    attributes,
    body: typeDef.body,
    dir,
    file: path.join(dir, documentFileName('period')),
    parentId: parent ? parent.id : null,
    depth: parent ? parent.depth + 1 : 0,
  };

  writeDocument(board, period);
  writeBoardIndex(board, { node: period });
  return period;
}

export interface NewResourceInput {
  type: string;
  title: string;
  /** Full-time equivalents. Defaults to 1: one person at full time. */
  capacity?: number;
  /** Generic resources this one can be drawn from. */
  covers?: string[];
  /** Parent resource id; omit to create at the top of the roster. */
  parentId?: string;
  attributes?: Record<string, unknown>;
  author?: string;
}

export function createResource(board: LoadedBoard, input: NewResourceInput): Resource {
  // Locked for the id as much as for the document: `allocateFor` reads the
  // counter, bumps it and writes it back, so two processes creating a resource
  // at the same moment would otherwise both be handed the same id.
  return boardWrite(board, 'create a resource', () => createResourceUnderLock(board, input));
}

function createResourceUnderLock(board: LoadedBoard, input: NewResourceInput): Resource {
  if (!hasResources(board.config)) {
    throw new BoardError('This board has no team roster', [
      'Add resource_types, resource_hierarchy and resource_prefix to .lpm/config.yml.',
    ]);
  }
  const typeDef = typeDefOf(board, 'resource', input.type);
  const title = input.title.trim();
  if (!title) throw new BoardError('Resource title cannot be empty');

  const capacity = input.capacity ?? DEFAULT_CAPACITY;
  requireCapacity(capacity);
  const covers = resolveCoverTargets(board, input.covers ?? []);

  const parent = resolveParentFor(board, 'resource', input.type, input.parentId);
  const attributes = buildAttributes(typeDef, input.type, input.attributes);
  const id = allocateFor(board, 'resource');
  const parentDir = parent ? parent.dir : collectionDir(board.paths, 'resource');
  mkdirSync(parentDir, { recursive: true });
  const dir = prepareFolder(board, parentDir, id);
  const timestamp = nowIso();

  const resource: Resource = {
    kind: 'resource',
    id,
    type: input.type,
    title,
    capacity,
    covers,
    created: timestamp,
    updated: timestamp,
    author: input.author ?? gitIdentity(board.paths.lpmDir),
    attributes,
    body: typeDef.body,
    dir,
    file: path.join(dir, documentFileName('resource')),
    parentId: parent ? parent.id : null,
    depth: parent ? parent.depth + 1 : 0,
  };

  writeDocument(board, resource);
  writeBoardIndex(board, { node: resource });
  return resource;
}

export interface NewTemplateInput {
  /** An issue type, or `folder` for a container. */
  type: string;
  title: string;
  /** What this template is for. Shown in the registry listing. */
  description?: string;
  /** Parent template id; omit to create at the top of the registry. */
  parentId?: string;
  /** What this template asks for. Roots only — see `Template.params`. */
  params?: ParamDefs;
  dependsOn?: string[];
  relatesTo?: string[];
  relatedFiles?: string[];
  attributes?: Record<string, unknown>;
  author?: string;
}

/**
 * Add a document to the template registry.
 *
 * A template is written in the board's own issue types, so this reads like
 * `createIssue` with the scheduling taken out: nothing here has a status, an
 * assignee or a period, because none of that is decided until the template is
 * instantiated. @see planInstantiate
 */
export function createTemplate(board: LoadedBoard, input: NewTemplateInput): Template {
  // Locked for the id as much as for the document: `allocateFor` reads the
  // counter, bumps it and writes it back, so two processes creating a template
  // at the same moment would otherwise both be handed the same id.
  return boardWrite(board, 'create a template', () => createTemplateUnderLock(board, input));
}

function createTemplateUnderLock(board: LoadedBoard, input: NewTemplateInput): Template {
  const typeDef = typeDefOf(board, 'template', input.type);
  const title = input.title.trim();
  if (!title) throw new BoardError('Template title cannot be empty');

  const parent = resolveParentFor(board, 'template', input.type, input.parentId);
  const dependsOn = resolveTemplateLinkTargets(board, input.dependsOn ?? []);
  const relatesTo = resolveTemplateLinkTargets(board, input.relatesTo ?? []);

  // Only a root asks for anything: it is what somebody instantiates, and its
  // children take the answers it was given. `check` reports a document that
  // declares parameters anywhere else, and refusing to write one in the first
  // place is the same rule one step earlier.
  const params = input.params ?? {};
  if (Object.keys(params).length) {
    if (isFolderTemplate({ type: input.type })) {
      throw new BoardError('A folder cannot declare parameters', [
        'Parameters belong on the template somebody instantiates, not on the folder holding it.',
      ]);
    }
    if (parent && !isFolderTemplate(parent)) {
      throw new BoardError('Only a root declares parameters', [
        `This would sit inside the template ${parent.id}, so it is part of one.`,
        `Put the parameters on ${parent.id}, or on whatever root holds it.`,
      ]);
    }
  }

  const attributes = buildAttributes(typeDef, input.type, input.attributes, true);
  const id = allocateFor(board, 'template');
  const parentDir = parent ? parent.dir : collectionDir(board.paths, 'template');
  mkdirSync(parentDir, { recursive: true });
  const dir = prepareFolder(board, parentDir, id);
  const timestamp = nowIso();

  const template: Template = {
    kind: 'template',
    id,
    type: input.type,
    title,
    description: input.description?.trim() ?? '',
    params,
    depends_on: dependsOn,
    relates_to: relatesTo,
    related_files: normalizeFileRefs(input.relatedFiles ?? []),
    created: timestamp,
    updated: timestamp,
    author: input.author ?? gitIdentity(board.paths.lpmDir),
    attributes,
    // A folder carries no scaffolding; a template of a type starts from the
    // same body a new issue of that type would, which is the point of it.
    body: typeDef.body,
    dir,
    file: path.join(dir, documentFileName('template')),
    parentId: parent ? parent.id : null,
    depth: parent ? parent.depth + 1 : 0,
  };

  writeDocument(board, template);
  writeBoardIndex(board, { node: template });
  return template;
}

export interface NewSquadInput {
  type: string;
  title: string;
  /** Resource ids that belong to this squad. */
  members?: string[];
  attributes?: Record<string, unknown>;
  author?: string;
}

export function createSquad(board: LoadedBoard, input: NewSquadInput): Squad {
  // Locked for the id as much as for the document: `allocateFor` reads the
  // counter, bumps it and writes it back, so two processes creating a squad
  // at the same moment would otherwise both be handed the same id.
  return boardWrite(board, 'create a squad', () => createSquadUnderLock(board, input));
}

function createSquadUnderLock(board: LoadedBoard, input: NewSquadInput): Squad {
  if (!hasSquads(board.config)) {
    throw new BoardError('This board has no squad types', [
      'Add squad_types, squad_hierarchy and squad_prefix to .lpm/config.yml.',
    ]);
  }
  const typeDef = typeDefOf(board, 'squad', input.type);
  const title = input.title.trim();
  if (!title) throw new BoardError('Squad title cannot be empty');

  const resolvedMembers: string[] = [];
  if (input.members) {
    for (const raw of input.members) {
      const id = raw.trim();
      if (!id) continue;
      const resource = board.resourcesById.get(id);
      if (!resource) throw new BoardError(`No resource with id "${id}"`);
      if (!resolvedMembers.includes(resource.id)) resolvedMembers.push(resource.id);
    }
  }

  const parent = resolveParentFor(board, 'squad', input.type, undefined);
  const attributes = buildAttributes(typeDef, input.type, input.attributes);
  const id = allocateFor(board, 'squad');
  const parentDir = collectionDir(board.paths, 'squad');
  mkdirSync(parentDir, { recursive: true });
  const dir = prepareFolder(board, parentDir, id);
  const timestamp = nowIso();

  const squad: Squad = {
    kind: 'squad',
    id,
    type: input.type,
    title,
    members: resolvedMembers,
    created: timestamp,
    updated: timestamp,
    author: input.author ?? gitIdentity(board.paths.lpmDir),
    attributes,
    body: typeDef.body,
    dir,
    file: path.join(dir, documentFileName('squad')),
    parentId: parent ? parent.id : null,
    depth: parent ? parent.depth + 1 : 0,
  };

  writeDocument(board, squad);
  writeBoardIndex(board, { node: squad });
  return squad;
}
