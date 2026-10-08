import { afterAll, describe, expect, it } from 'vitest';
import { createIssue, type LoadedBoard } from '../src/core/index.js';
import { computeBase, type LinkEntry, type LinkStore } from '../src/remote/links.js';
import {
  planPull,
  planPush,
  renderPlan,
  type RemoteOp,
  type RemoteSnapshot,
} from '../src/remote/index.js';
import type { BoardFieldsPatch, RemoteRecord } from '../src/remote/provider.js';
import type { BoardView } from '../src/shared/index.js';
import { toSnapshot } from '../src/sync/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * LP-282 — `renderPlan` renders a plan as a diff, once for the CLI's
 * `--dry-run` text and once as structured data for the web preview. Built
 * against real boards (`makeBoard`) and the real planners — no fixtures.
 */

function view(board: LoadedBoard): BoardView {
  const snapshot = toSnapshot(board);
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources, ...snapshot.templates].map(
      (node) => [node.id, node],
    ),
  );
  return { config: snapshot.config, nodes };
}

function linkStore(entries: Record<string, LinkEntry>): LinkStore {
  const links = new Map(Object.entries(entries));
  const byRemote = new Map<string, string>();
  for (const [localId, entry] of links) byRemote.set(entry.remoteId, localId);
  return { version: 1, cursor: null, links, byRemote, tombstones: new Map() };
}

function twin(remoteId: string, base?: Record<string, unknown>): LinkEntry {
  return {
    remoteId,
    remoteKey: `acme/payments#${remoteId}`,
    remoteUrl: `https://github.com/acme/payments/issues/${remoteId}`,
    syncedAt: '2026-09-04T11:19:58Z',
    remoteRev: '2026-09-04T11:19:57Z',
    ...(base ? { base } : {}),
  };
}

function snapshot(direction: RemoteSnapshot['direction'] = 'both', scope?: string): RemoteSnapshot {
  return { direction, issues: new Map(), ...(scope ? { scope } : {}) };
}

function baseOf(board: LoadedBoard, id: string): Record<string, unknown> {
  const doc = toSnapshot(board).issues.find((issue) => issue.id === id)!;
  return computeBase(
    doc,
    new Set(['title', 'body', 'status', 'assignee', 'period', 'dependsOn']),
  );
}

/** The text line for a rendered field, so a test can assert it exactly once. */
function fieldLine(field: string, local: string, remote: string, outcome: string): string {
  const pad = (text: string, width: number): string =>
    text.length >= width ? `${text} ` : text + ' '.repeat(width - text.length);
  return `    ${pad(field, 16)} local: ${pad(local, 26)} remote: ${pad(remote, 26)} ${outcome}`;
}

describe('renderPlan — push', () => {
  it('groups by operation kind with counts first, then per-document detail', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });

    const ops = planPush(view(reload(paths)), linkStore({}), snapshot()).ops;
    const render = renderPlan({ direction: 'push', ops }, { board: view(reload(paths)) });

    // Grouped by kind: two creates, nothing else.
    expect(render.sections.map((section) => [section.kind, section.count])).toEqual([
      ['create', 2],
    ]);

    // Counts come before the per-document detail in the text.
    const countLine = render.text.indexOf('create');
    const detailLine = render.text.indexOf(programme.id);
    expect(countLine).toBeGreaterThanOrEqual(0);
    expect(detailLine).toBeGreaterThan(countLine);

    // Per-document detail: field, local value, remote value, outcome.
    const programmeDoc = render.sections[0]!.documents.find((doc) => doc.localId === programme.id)!;
    expect(programmeDoc.title).toBe('Programme');
    const byField = Object.fromEntries(programmeDoc.fields.map((field) => [field.field, field]));
    expect(byField.title).toEqual({ field: 'title', local: 'Programme', remote: null, outcome: 'created' });
    expect(byField.type).toEqual({ field: 'type', local: 'program', remote: null, outcome: 'created' });
    expect(byField.status).toEqual({ field: 'status', local: 'backlog', remote: null, outcome: 'created' });
    // Unset attributes are not shown as fields.
    expect(byField['attributes.owner']).toBeUndefined();
    expect(byField['attributes.labels']).toBeUndefined(); 

    expect(render.text).toContain('Sync plan — 2 operations');
    expect(render.text).toContain(`${programme.id} "Programme"`);
    expect(render.text).toContain(fieldLine('title', '"Programme"', '—', 'created'));
  });

  it('shows local and remote values side by side for an update', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic v2', parentId: programme.id });

    const board = reload(paths);
    // The base snapshot recorded the old title; the board now has a new one.
    const store = linkStore({
      [epic.id]: twin('419', { ...baseOf(board, epic.id), title: 'Epic' }),
    });

    const ops = planPush(view(board), store, snapshot()).ops;
    const render = renderPlan({ direction: 'push', ops }, { board: view(board), links: store });

    const update = render.sections.find((section) => section.kind === 'update')!;
    expect(update.count).toBe(1);
    expect(update.documents[0]!.fields).toEqual([
      { field: 'title', local: 'Epic v2', remote: 'Epic', outcome: 'updated' },
    ]);
    expect(render.text).toContain(fieldLine('title', '"Epic v2"', '"Epic"', 'updated'));
  });

  it('renders a transition and a close with the status on both sides', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });
    const moving = createIssue(reload(paths), {
      type: 'feature',
      title: 'Moving',
      parentId: epic.id,
      status: 'in_progress',
    });
    const finished = createIssue(reload(paths), {
      type: 'feature',
      title: 'Finished',
      parentId: epic.id,
      status: 'done',
    });

    const board = reload(paths);
    const store = linkStore({
      [moving.id]: twin('420', { ...baseOf(board, moving.id), status: 'backlog' }),
      [finished.id]: twin('421', { ...baseOf(board, finished.id), status: 'backlog' }),
    });

    const ops = planPush(view(board), store, snapshot()).ops;
    const render = renderPlan({ direction: 'push', ops }, { board: view(board), links: store });

    const transition = render.sections.find((section) => section.kind === 'transition')!;
    expect(transition.documents[0]!.fields).toEqual([
      { field: 'status', local: 'in_progress', remote: 'backlog', outcome: 'transition to in_progress' },
    ]);

    const close = render.sections.find((section) => section.kind === 'close')!;
    expect(close.documents[0]!.fields).toEqual([
      { field: 'status', local: 'done', remote: 'backlog', outcome: 'closed' },
    ]);
  });

  it('renders the exact plan the executor would run, op for op', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });
    const feature = createIssue(reload(paths), { type: 'feature', title: 'Feature', parentId: epic.id });
    createIssue(reload(paths), { type: 'user_story', title: 'Story', parentId: feature.id, dependsOn: [feature.id] });

    const ops = planPush(view(reload(paths)), linkStore({}), snapshot()).ops;
    const render = renderPlan({ direction: 'push', ops }, { board: view(reload(paths)) });

    // One document per op — the renderer reads the plan, it does not re-plan.
    expect(render.total).toBe(ops.length);
    const createOps = ops.filter((op): op is Extract<RemoteOp, { kind: 'create' }> => op.kind === 'create');
    const linkOps = ops.filter((op): op is Extract<RemoteOp, { kind: 'link' }> => op.kind === 'link');
    expect(render.sections.find((section) => section.kind === 'create')!.count).toBe(createOps.length);
    expect(render.sections.find((section) => section.kind === 'link')!.count).toBe(linkOps.length);
  });
});

describe('renderPlan — decoupled documents (LP-366)', () => {
  it('renders a decouple op with the remote id and the reason', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });

    const store = linkStore({ [programme.id]: twin('418') });
    const ops: RemoteOp[] = [{ kind: 'decouple', localId: programme.id, reason: 'out_of_scope' }];

    const render = renderPlan({ direction: 'push', ops }, { board: view(reload(paths)), links: store });

    const decouple = render.sections.find((section) => section.kind === 'decouple')!;
    expect(decouple.count).toBe(1);
    expect(decouple.documents[0]!.remoteId).toBe('418');
    expect(decouple.documents[0]!.fields[0]!.outcome).toBe('decoupled (out_of_scope) — remote left alone');
    expect(render.text).toContain('decoupled (out_of_scope)');
  });

  it('lists skipped decoupled documents in their own section, not silently', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });

    const render = renderPlan(
      {
        direction: 'push',
        ops: [],
        skipped: [{ localId: programme.id, reason: 'manual', remoteKey: 'acme/payments#9' }],
      },
      { board: view(reload(paths)) },
    );

    const skipped = render.sections.find((section) => section.kind === 'skipped')!;
    expect(skipped.count).toBe(1);
    expect(skipped.documents[0]!.fields[0]!.outcome).toBe('skipped — decoupled (manual)');
    expect(skipped.documents[0]!.fields[0]!.remote).toBe('acme/payments#9');
    expect(render.text).toContain('skipped');
  });
});

describe('renderPlan — gone-document resolutions (LP-351)', () => {
  it('renders a delete op with the remote id', () => {
    const paths = makeBoard('scrum', 'LP');
    const store = linkStore({ 'LP-404': twin('418') });
    const ops: RemoteOp[] = [
      { kind: 'delete', localId: 'LP-404', ref: { kind: 'linked', localId: 'LP-404', remoteId: '418' } },
    ];

    const render = renderPlan({ direction: 'push', ops }, { board: view(reload(paths)), links: store });

    const del = render.sections.find((section) => section.kind === 'delete')!;
    expect(del.count).toBe(1);
    expect(del.documents[0]!.remoteId).toBe('418');
    expect(del.documents[0]!.fields[0]!.outcome).toContain('deleted');
  });

  it('renders a policy close with its note', () => {
    const paths = makeBoard('scrum', 'LP');
    const store = linkStore({ 'LP-404': twin('418') });
    const ops: RemoteOp[] = [
      {
        kind: 'close',
        localId: 'LP-404',
        ref: { kind: 'linked', localId: 'LP-404', remoteId: '418' },
        note: 'Closed because deleted',
      },
    ];

    const render = renderPlan({ direction: 'push', ops }, { board: view(reload(paths)), links: store });

    const close = render.sections.find((section) => section.kind === 'close')!;
    expect(close.documents[0]!.fields).toEqual([
      { field: 'status', local: null, remote: null, outcome: 'closed' },
      {
        field: 'comment',
        local: 'Closed because deleted',
        remote: null,
        outcome: 'posted — closed by on_delete policy',
      },
    ]);
  });
});

describe('renderPlan — conflicts', () => {
  it('puts a conflicted document in its own section with both values and the policy', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Payments', parentId: programme.id });

    const render = renderPlan(
      { direction: 'push', ops: [] },
      {
        board: view(reload(paths)),
        conflicts: [
          { localId: epic.id, field: 'status', local: 'in_progress', remote: 'done', policy: 'remote' },
        ],
      },
    );

    expect(render.conflicts).toEqual([
      { localId: epic.id, title: 'Payments', field: 'status', local: 'in_progress', remote: 'done', policy: 'remote wins' },
    ]);

    // The conflict is not an operation: it is its own section, last in the text.
    expect(render.text).toContain('conflicts');
    expect(render.text).toContain('remote wins');
    expect(render.text).toContain(fieldLine('status', '"in_progress"', '"done"', 'remote wins'));
  });

  it('labels the three policies', () => {
    const render = (policy: 'manual' | 'local' | 'remote') =>
      renderPlan(
        { direction: 'push', ops: [] },
        { conflicts: [{ localId: 'LP-1', field: 'title', local: 'a', remote: 'b', policy }] },
      );

    expect(render('manual').conflicts[0]!.policy).toBe('manual');
    expect(render('local').conflicts[0]!.policy).toBe('local wins');
    expect(render('remote').conflicts[0]!.policy).toBe('remote wins');
  });
});

describe('renderPlan — redaction', () => {
  it('redacts a secret wherever it appears, in structure and in text', () => {
    const ops: RemoteOp[] = [
      {
        kind: 'comment',
        ref: { kind: 'linked', localId: 'LP-1', remoteId: '418' },
        index: 1,
        author: 'Ada',
        body: 'the token is ghp_SECRET123 — keep it safe',
      },
    ];

    const render = renderPlan({ direction: 'push', ops }, { secrets: ['ghp_SECRET123'] });

    const field = render.sections[0]!.documents[0]!.fields[0]!;
    expect(field.local).toBe('the token is *** — keep it safe');
    expect(render.text).not.toContain('ghp_SECRET123');
    expect(render.text).toContain('***');
  });

  it('redacts a secret nested inside a create field value', () => {
    const ops: RemoteOp[] = [
      {
        kind: 'create',
        placeholder: 'new:1',
        localId: 'LP-1',
        fields: { title: 'T', body: '', type: 'program', status: 'backlog', attributes: { note: 'ghp_SECRET123' } },
      },
    ];

    const render = renderPlan({ direction: 'push', ops }, { secrets: ['ghp_SECRET123'] });

    const note = render.sections[0]!.documents[0]!.fields.find((field) => field.field === 'attributes.note')!;
    expect(note.local).toBe('***');
    expect(render.text).not.toContain('ghp_SECRET123');
  });
});

describe('renderPlan — pull', () => {
  const pullPatch = (record: RemoteRecord): BoardFieldsPatch => {
    const patch: BoardFieldsPatch = {};
    if (typeof record.type === 'string') patch.type = record.type;
    if (typeof record.title === 'string') patch.title = record.title;
    if (typeof record.body === 'string') patch.body = record.body;
    if (typeof record.status === 'string') patch.status = record.status;
    return patch;
  };

  const pullSnapshot = (issues: Record<string, RemoteRecord>): RemoteSnapshot => ({
    direction: 'both',
    issues: new Map(Object.entries(issues)),
  });

  it('renders a pull create with the remote side carrying the patch', () => {
    const paths = makeBoard('scrum', 'LP');
    const board = reload(paths);
    const store = linkStore({});

    const plan = planPull(view(board), store, pullSnapshot({
      '101': { type: 'program', title: 'Remote programme', body: 'body', status: 'backlog' },
    }), { toPatch: pullPatch });

    const render = renderPlan({ direction: 'pull', plan }, { board: view(board), links: store });

    const create = render.sections.find((section) => section.kind === 'create')!;
    expect(create.count).toBe(1);
    expect(create.documents[0]!.fields).toEqual([
      { field: 'title', local: null, remote: 'Remote programme', outcome: 'created' },
      { field: 'body', local: null, remote: 'body', outcome: 'created' },
      { field: 'type', local: null, remote: 'program', outcome: 'created' },
      { field: 'status', local: null, remote: 'backlog', outcome: 'created' },
    ]);
  });

  it('renders a pull delete and an empty plan', () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const epic = createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: programme.id });
    const feature = createIssue(reload(paths), { type: 'feature', title: 'Feature', parentId: epic.id });
    const story = createIssue(reload(paths), { type: 'user_story', title: 'Story', parentId: feature.id });
    const board = reload(paths);
    const store = linkStore({ [story.id]: twin('300', {}) });

    const plan = planPull(view(board), store, pullSnapshot({}), {
      toPatch: pullPatch,
    });
    // on_delete defaults to unlink: the document is decoupled — the link is
    // dropped and a tombstone records the decision, so it is never re-filed.
    const render = renderPlan({ direction: 'pull', plan }, { board: view(board), links: store });
    const decouple = render.sections.find((section) => section.kind === 'decouple')!;
    expect(decouple.count).toBe(1);
    expect(decouple.documents[0]!.remoteId).toBe('300');

    // Nothing to render is explicit, not a blank line.
    expect(renderPlan({ direction: 'pull', plan: { changes: [], links: [] } }).text).toBe(
      'Nothing to do — the plan is empty.',
    );
  });
});
