import { describe, expect, it } from 'vitest';
import { setLink, type LinkEntry, type LinkStore } from '../src/remote/links.js';
import { mapTypeFromRemote, type TypeMappings } from '../src/remote/mapping.js';
import type { RemoteSnapshot } from '../src/remote/plan.js';
import type { RemoteRecord } from '../src/remote/provider.js';
import {
  resolveShapeDivergence,
  type ShapeDivergenceEntry,
  type ShapeDivergenceReport,
} from '../src/remote/shape.js';
import type { BoardTypeResolution } from '../src/remote/mapping.js';
import type { ConfigDto, IssueDto, NodeDto, TypeDto } from '../src/shared/model.js';
import type { BoardView } from '../src/shared/plans/reading.js';

/**
 * LP-368 — `resolveShapeDivergence` reports a remote reparent or retype of a
 * linked document instead of silently reshaping the local tree. Pure: board,
 * links and a fetched remote snapshot in, a report out — no fixtures, no disk,
 * no network.
 */

// -- the board vocabulary ---------------------------------------------------

const HIERARCHY = [
  ['program'],
  ['epic'],
  ['feature'],
  ['user_story', 'bug'],
  ['sub_task'],
] as string[][];

function typeDef(name: string, depth: number): TypeDto {
  return {
    name,
    kind: 'issue',
    label: name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    depth,
    attributes: [],
    generic: false,
    atomic: false,
  };
}

const config: ConfigDto = {
  boardName: 'test',
  statuses: [],
  defaultStatus: 'backlog',
  types: {
    program: typeDef('program', 0),
    epic: typeDef('epic', 1),
    feature: typeDef('feature', 2),
    user_story: typeDef('user_story', 3),
    bug: typeDef('bug', 3),
    sub_task: typeDef('sub_task', 4),
  },
  hierarchy: {
    issue: HIERARCHY,
    period: [],
    resource: [],
    squad: [],
    template: [],
  },
  hasPeriods: false,
  hasResources: false,
  hasSquads: false,
  priorityAttribute: '',
  effortAttribute: '',
  planning: 'periods',
};

function issue(
  id: string,
  type: string,
  parentId: string | null = null,
  depth = 0,
): IssueDto {
  return {
    kind: 'issue',
    id,
    type,
    title: `Issue ${id}`,
    body: '',
    parentId,
    depth,
    attributes: {},
    status: 'backlog',
    assignee: null,
    period: null,
    flag: null,
    dependsOn: [],
    relatesTo: [],
    relatedFiles: [],
  };
}

function view(nodes: IssueDto[]): BoardView {
  const byId: Record<string, NodeDto> = {};
  for (const node of nodes) byId[node.id] = node;
  return { config, nodes: byId };
}

/**
 * The standard board tree: program LP-1 → epic LP-2 → features LP-3, LP-6 →
 * stories/bugs. `LP-6` is the feature a document can legally be reparented
 * under; `LP-7` is a sub-task of LP-4 (used to build a reparent cycle).
 */
function boardTree(): BoardView {
  return view([
    issue('LP-1', 'program', null, 0),
    issue('LP-2', 'epic', 'LP-1', 1),
    issue('LP-3', 'feature', 'LP-2', 2),
    issue('LP-4', 'user_story', 'LP-3', 3),
    issue('LP-5', 'bug', 'LP-3', 3),
    issue('LP-6', 'feature', 'LP-2', 2),
    issue('LP-7', 'sub_task', 'LP-4', 4),
  ]);
}

function twin(remoteId: string, base?: Record<string, unknown>): LinkEntry {
  return {
    remoteId,
    remoteKey: `acme/repo#${remoteId}`,
    remoteUrl: `https://github.com/acme/repo/issues/${remoteId}`,
    syncedAt: '2026-09-04T11:19:58Z',
    remoteRev: '2026-09-04T11:19:57Z',
    ...(base !== undefined ? { base } : {}),
  };
}

function store(links: Record<string, LinkEntry> = {}): LinkStore {
  const s: LinkStore = {
    version: 1,
    cursor: null,
    links: new Map(),
    byRemote: new Map(),
    tombstones: new Map(),
  };
  for (const [id, entry] of Object.entries(links)) setLink(s, id, entry);
  return s;
}

function snapshot(
  issues: Record<string, RemoteRecord> = {},
  opts: { direction?: RemoteSnapshot['direction']; scope?: string } = {},
): RemoteSnapshot {
  return {
    direction: opts.direction ?? 'both',
    issues: new Map(Object.entries(issues)),
    ...(opts.scope ? { scope: opts.scope } : {}),
  };
}

/** The provider seam for a remote with a native hierarchy (record.parent). */
const parentIdOf = (record: RemoteRecord): string | undefined =>
  record['parent'] as string | undefined;

/** The provider seam for a remote with native types (record.remoteType). */
const MAPPINGS: TypeMappings = {
  program: { remote: 'Program' },
  epic: { remote: 'Epic' },
  feature: { remote: 'Feature' },
  user_story: { remote: 'Story' },
  bug: { remote: 'Bug' },
  sub_task: { remote: 'Sub-task' },
};

function typeOf(record: RemoteRecord, depth: number): BoardTypeResolution {
  return mapTypeFromRemote(
    MAPPINGS,
    HIERARCHY,
    { remoteType: record['remoteType'] as string | undefined, labels: [] },
    { depth },
  );
}

/** The entries for one local id, collapsed to the axes that diverged. */
function entryOf(
  report: ShapeDivergenceReport,
  localId: string,
): ShapeDivergenceEntry | undefined {
  return report.entries.find((entry) => entry.localId === localId);
}

// -- no divergence ----------------------------------------------------------

describe('agreement', () => {
  it('reports nothing when parent and type both agree', () => {
    const links = store({
      'LP-4': twin('R4', { parent: 'LP-3', type: 'user_story' }),
      'LP-3': twin('R3', { parent: 'LP-2', type: 'feature' }),
      'LP-2': twin('R2', { parent: 'LP-1', type: 'epic' }),
    });
    const remote = snapshot({
      R4: { parent: 'R3', remoteType: 'Story' },
      R3: { parent: 'R2', remoteType: 'Feature' },
    });

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf,
    });

    expect(report.entries).toEqual([]);
  });

  it('reports nothing for a push-only remote', () => {
    const links = store({ 'LP-4': twin('R4', { parent: 'LP-3', type: 'user_story' }) });
    const remote = snapshot({}, { direction: 'push' });

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf,
    });

    expect(report.entries).toEqual([]);
  });

  it('skips a vanished twin — absence is the lifecycle resolver, not shape', () => {
    const links = store({ 'LP-4': twin('R4', { parent: 'LP-3', type: 'user_story' }) });
    const remote = snapshot({}); // R4 is absent

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf,
    });

    expect(report.entries).toEqual([]);
  });

  it('skips a document outside the remote scope', () => {
    const links = store({ 'LP-4': twin('R4', { parent: 'LP-3', type: 'user_story' }) });
    const remote = snapshot({ R4: { parent: 'R9', remoteType: 'Story' } }, { scope: 'LP-6' });

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf,
    });

    expect(report.entries).toEqual([]);
  });
});

// -- parent divergence ------------------------------------------------------

describe('remote reparent', () => {
  it('reports both shapes and never modifies the local tree', () => {
    const board = boardTree();
    const links = store({
      'LP-5': twin('R5', { parent: 'LP-3', type: 'bug' }),
      'LP-6': twin('R6', { parent: 'LP-2', type: 'feature' }),
    });
    // The remote moved the bug under feature LP-6.
    const remote = snapshot({
      R5: { parent: 'R6', remoteType: 'Bug' },
      R6: { parent: 'R2', remoteType: 'Feature' },
    });

    const report = resolveShapeDivergence(board, links, remote, {
      parentIdOf,
      typeOf,
    });

    const entry = entryOf(report, 'LP-5')!;
    expect(entry.parent).toMatchObject({ local: 'LP-3', remote: 'LP-6' });
    // The report is read-only: the local tree is untouched.
    expect(board.nodes['LP-5']!.parentId).toBe('LP-3');
  });

  it('offers a legal reparent as an applicable move, planned through planReparent', () => {
    const links = store({
      'LP-5': twin('R5', { parent: 'LP-3', type: 'bug' }),
      'LP-6': twin('R6', { parent: 'LP-2', type: 'feature' }),
    });
    // The remote moved the bug under feature LP-6 — legal at depth 3.
    const remote = snapshot({
      R5: { parent: 'R6', remoteType: 'Bug' },
      R6: { parent: 'R2', remoteType: 'Feature' },
    });

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf,
    });

    const entry = entryOf(report, 'LP-5')!;
    expect(entry.parent).toMatchObject({
      local: 'LP-3',
      remote: 'LP-6',
      verdict: 'applicable',
    });
    // The offer is an existing move op — a parentId update, never a folder write.
    expect(entry.parent!.plan).toEqual([
      { kind: 'update', id: 'LP-5', nodeKind: 'issue', patch: { parentId: 'LP-6' } },
    ]);
  });

  it('names the wrong-depth rule when no level exists at the remote parent', () => {
    const links = store({
      'LP-5': twin('R5', { parent: 'LP-3', type: 'bug' }),
      'LP-7': twin('R7', { parent: 'LP-4', type: 'sub_task' }),
    });
    // The remote moved the bug under a sub-task — depth 5, past the hierarchy.
    const remote = snapshot({
      R5: { parent: 'R7', remoteType: 'Bug' },
      R7: { parent: 'R4', remoteType: 'Sub-task' },
    });

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf,
    });

    const entry = entryOf(report, 'LP-5')!;
    expect(entry.parent).toMatchObject({ verdict: 'unapplicable' });
    expect(entry.parent!.plan).toBeUndefined();
    expect(entry.parent!.reason).toContain('cannot sit under');
  });

  it('names the rule when a descendant would have no level to sit at', () => {
    const links = store({
      'LP-3': twin('R3', { parent: 'LP-2', type: 'feature' }),
      'LP-1': twin('R1', { parent: null, type: 'program' }),
    });
    // The remote moved feature LP-3 (whose child LP-4 is a user_story) under
    // the program — LP-4 would land at depth 2, where user_story is not legal.
    const remote = snapshot({
      R3: { parent: 'R1', remoteType: 'Feature' },
      R1: { remoteType: 'Program' },
    });

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf,
    });

    const entry = entryOf(report, 'LP-3')!;
    expect(entry.parent).toMatchObject({ verdict: 'unapplicable' });
    expect(entry.parent!.plan).toBeUndefined();
    expect(entry.parent!.reason).toContain('would have nowhere to sit');
  });

  it('names the rule when the remote parent would form a cycle', () => {
    const links = store({
      'LP-4': twin('R4', { parent: 'LP-3', type: 'user_story' }),
      'LP-7': twin('R7', { parent: 'LP-4', type: 'sub_task' }),
    });
    // The remote moved LP-4 under its own sub-task — a cycle.
    const remote = snapshot({
      R4: { parent: 'R7', remoteType: 'Story' },
      R7: { parent: 'R4', remoteType: 'Sub-task' },
    });

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf,
    });

    const entry = entryOf(report, 'LP-4')!;
    expect(entry.parent).toMatchObject({ verdict: 'unapplicable' });
    expect(entry.parent!.reason).toContain('descendant');
  });

  it('reports a scope exit — an unmappable remote parent — never as a deletion', () => {
    const links = store({ 'LP-4': twin('R4', { parent: 'LP-3', type: 'user_story' }) });
    // R4 is present but points at a parent with no local twin (moved project).
    const remote = snapshot({ R4: { parent: 'R-other', remoteType: 'Story' } });

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf,
    });

    const entry = entryOf(report, 'LP-4')!;
    expect(entry.parent).toMatchObject({
      local: 'LP-3',
      remote: undefined,
      verdict: 'unapplicable',
    });
    expect(entry.parent!.reason).toContain("left the remote's scope");
    // Still a present twin — not orphaned, not deleted, not unlinked.
    expect(report.entries).toHaveLength(1);
  });
});

// -- type divergence --------------------------------------------------------

describe('remote retype', () => {
  it('maps a remote type change back and offers a convert when it differs', () => {
    const links = store({ 'LP-4': twin('R4', { parent: 'LP-3', type: 'user_story' }) });
    // The remote converted the story into a bug.
    const remote = snapshot({ R4: { parent: 'R3', remoteType: 'Bug' } });

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf,
    });

    const entry = entryOf(report, 'LP-4')!;
    expect(entry.type).toMatchObject({
      local: 'user_story',
      remote: 'bug',
      verdict: 'applicable',
    });
    expect(entry.type!.plan).toEqual([
      { kind: 'update', id: 'LP-4', nodeKind: 'issue', patch: { type: 'bug' } },
    ]);
  });

  it('reports a remote type with no board counterpart, never defaulting it', () => {
    const links = store({ 'LP-4': twin('R4', { parent: 'LP-3', type: 'user_story' }) });
    // "Task" is not a type any mapping claims.
    const remote = snapshot({ R4: { parent: 'R3', remoteType: 'Task' } });

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf,
    });

    const entry = entryOf(report, 'LP-4')!;
    expect(entry.type).toMatchObject({
      local: 'user_story',
      unresolved: 'unmapped',
      candidates: [],
      verdict: 'unapplicable',
    });
    expect(entry.type!.remote).toBeUndefined(); // nothing invented
    expect(entry.type!.reason).toContain('no board counterpart');
  });

  it('reports an ambiguous remote type rather than guessing', () => {
    const links = store({ 'LP-4': twin('R4', { parent: 'LP-3', type: 'user_story' }) });
    // Two depth-legal board types share one remote carrier — a mapping that
    // cannot be read back to a single type.
    const ambiguous = (record: RemoteRecord, depth: number): BoardTypeResolution =>
      mapTypeFromRemote(
        { user_story: { remote: 'Story' }, bug: { remote: 'Story' } },
        HIERARCHY,
        { remoteType: 'Story', labels: [] },
        { depth },
      );
    const remote = snapshot({ R4: { parent: 'R3', remoteType: 'Story' } });

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf: ambiguous,
    });

    const entry = entryOf(report, 'LP-4')!;
    expect(entry.type).toMatchObject({
      unresolved: 'ambiguous',
      verdict: 'unapplicable',
    });
    expect(entry.type!.candidates.sort()).toEqual(['bug', 'user_story']);
  });
});

// -- both sides moved -------------------------------------------------------

describe('conflicted', () => {
  it('reports `conflicted` when local and remote both reparented, and moves neither', () => {
    const links = store({
      // The agreed parent was LP-3.
      'LP-4': twin('R4', { parent: 'LP-3', type: 'user_story' }),
      'LP-6': twin('R6', { parent: 'LP-2', type: 'feature' }),
      'LP-2': twin('R2', { parent: 'LP-1', type: 'epic' }),
    });
    // Locally LP-4 moved under LP-6; remotely it moved under the epic.
    const board = view([
      issue('LP-1', 'program', null, 0),
      issue('LP-2', 'epic', 'LP-1', 1),
      issue('LP-3', 'feature', 'LP-2', 2),
      issue('LP-4', 'user_story', 'LP-6', 3), // ← local moved
      issue('LP-6', 'feature', 'LP-2', 2),
    ]);
    const remote = snapshot({
      R4: { parent: 'R2', remoteType: 'Story' },
      R2: { parent: 'R1', remoteType: 'Epic' },
      R6: { parent: 'R2', remoteType: 'Feature' },
    });

    const report = resolveShapeDivergence(board, links, remote, {
      parentIdOf,
      typeOf,
    });

    const entry = entryOf(report, 'LP-4')!;
    expect(entry.parent).toMatchObject({
      local: 'LP-6',
      remote: 'LP-2',
      base: 'LP-3',
      verdict: 'conflicted',
    });
    expect(entry.parent!.plan).toBeUndefined(); // neither side moves
  });

  it('does not call a remote reparent `conflicted` when only the remote side moved', () => {
    const links = store({
      'LP-5': twin('R5', { parent: 'LP-3', type: 'bug' }),
      'LP-6': twin('R6', { parent: 'LP-2', type: 'feature' }),
    });
    const remote = snapshot({
      R5: { parent: 'R6', remoteType: 'Bug' },
      R6: { parent: 'R2', remoteType: 'Feature' },
    });

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf,
    });

    expect(entryOf(report, 'LP-5')!.parent!.verdict).toBe('applicable');
  });

  it('treats a base without a recorded shape as "no agreed shape", never conflicted', () => {
    const links = store({
      'LP-5': twin('R5'), // no base at all
      'LP-6': twin('R6', { parent: 'LP-2', type: 'feature' }),
    });
    const remote = snapshot({
      R5: { parent: 'R6', remoteType: 'Bug' },
      R6: { parent: 'R2', remoteType: 'Feature' },
    });

    const report = resolveShapeDivergence(boardTree(), links, remote, {
      parentIdOf,
      typeOf,
    });

    expect(entryOf(report, 'LP-5')!.parent!.verdict).toBe('applicable');
  });
});
