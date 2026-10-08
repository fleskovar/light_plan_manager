import { describe, expect, it } from 'vitest';
import { planStatus } from '../src/remote/status.js';
import { trackedFields, type ConflictOptions } from '../src/remote/conflicts.js';
import type { LinkStore } from '../src/remote/links.js';
import type { BoardFieldsPatch } from '../src/remote/provider.js';
import type { IssueDto } from '../src/shared/model.js';
import type { BoardView } from '../src/shared/plans/reading.js';
import { pendingAhead, remoteStatusExitCode, syncBadgeOf } from '../src/shared/remote-status.js';
import type { ResolutionStore } from '../src/remote/resolutions.js';

function emptyResolutions(): ResolutionStore {
  return { version: 1, resolutions: new Map() };
}

/**
 * LP-342 — the drift report: the pure classification over the three-way
 * merge.  No board on disk, no network — the remote side arrives as
 * already-translated patches, or as null for the no-credentials half.
 */

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function issue(id: string, over: Partial<IssueDto> = {}): IssueDto {
  return {
    kind: 'issue',
    id,
    type: 'user_story',
    title: over.title ?? id,
    body: over.body ?? '',
    parentId: over.parentId ?? null,
    depth: 0,
    attributes: over.attributes ?? {},
    status: over.status ?? 'in_progress',
    assignee: over.assignee ?? null,
    period: over.period ?? null,
    flag: null,
    dependsOn: [],
    relatesTo: [],
    relatedFiles: [],
  };
}

function viewOf(issues: IssueDto[]): BoardView {
  const nodes = Object.fromEntries(issues.map((node) => [node.id, node]));
  return { config: {} as BoardView['config'], nodes };
}

function linkStore(
  entries: Record<string, { remoteId: string; base?: Record<string, unknown> }>,
  tombstones: Record<string, { remoteKey: string; reason: string; at: string }> = {},
): LinkStore {
  const links = new Map(
    Object.entries(entries).map(([localId, entry]) => [
      localId,
      {
        remoteId: entry.remoteId,
        remoteKey: entry.remoteId,
        remoteUrl: '',
        syncedAt: '2026-09-04T11:19:58Z',
        remoteRev: '2026-09-04T11:19:57Z',
        ...(entry.base ? { base: entry.base } : {}),
      },
    ]),
  );
  const byRemote = new Map<string, string>();
  for (const [localId, entry] of links) byRemote.set(entry.remoteId, localId);
  return {
    version: 1,
    cursor: null,
    links,
    byRemote,
    tombstones: new Map(Object.entries(tombstones)),
  };
}

const MAPPING = {
  statuses: {
    in_progress: { remote: ['In Progress'] },
    done: { remote: ['Done'] },
  },
  attributes: { story_points: 'Points' },
  accounts: { via: 'github' },
  periods: { container: 'sprint' },
};

function manual(): ConflictOptions {
  return { conflict: 'manual', overrides: {}, resolutions: emptyResolutions() };
}

function fields(): ReadonlySet<string> {
  return trackedFields(MAPPING);
}

function header() {
  return {
    name: 'upstream',
    provider: 'github',
    target: 'acme/payments',
    scope: null,
    lastSync: '2026-09-04T11:19:58Z',
  };
}

/** Plan a report for a handful of issues and patches. */
function plan(
  issues: IssueDto[],
  entries: Record<string, { remoteId: string; base?: Record<string, unknown> }>,
  patches: ReadonlyMap<string, BoardFieldsPatch> | null,
  opts: {
    tombstones?: Record<string, { remoteKey: string; reason: string; at: string }>;
    remoteMissing?: string;
    verbose?: boolean;
  } = {},
) {
  return planStatus({
    board: viewOf(issues),
    store: linkStore(entries, opts.tombstones),
    options: manual(),
    fields: fields(),
    patches,
    remoteMissing: opts.remoteMissing,
    remote: header(),
    verbose: opts.verbose,
  });
}

// ---------------------------------------------------------------------------
// The five buckets
// ---------------------------------------------------------------------------

describe('planStatus — the five buckets', () => {
  it('classifies a local-only edit as ahead', () => {
    const report = plan(
      [issue('LP-1', { title: 'new title' })],
      { 'LP-1': { remoteId: 'R1', base: { title: 'old title', status: 'in_progress' } } },
      new Map([['LP-1', { title: 'old title', status: 'in_progress' }]]),
    );
    expect(report.ahead).toEqual(['LP-1']);
    expect(report.behind).toEqual([]);
    expect(report.conflicted).toEqual([]);
    expect(remoteStatusExitCode(report)).toBe(1);
  });

  it('classifies a remote-only edit as behind', () => {
    const report = plan(
      [issue('LP-1', { title: 't', status: 'in_progress' })],
      { 'LP-1': { remoteId: 'R1', base: { title: 't', status: 'in_progress' } } },
      new Map([['LP-1', { title: 't', status: 'done' }]]),
    );
    expect(report.behind).toEqual(['LP-1']);
    expect(report.ahead).toEqual([]);
    expect(report.conflicted).toEqual([]);
    expect(remoteStatusExitCode(report)).toBe(1);
  });

  it('classifies a both-sides edit as conflicted and exits 2', () => {
    const report = plan(
      [issue('LP-1', { title: 'local title', status: 'in_progress' })],
      { 'LP-1': { remoteId: 'R1', base: { title: 'base title', status: 'in_progress' } } },
      new Map([['LP-1', { title: 'remote title', status: 'in_progress' }]]),
    );
    expect(report.conflicted).toEqual(['LP-1']);
    expect(report.ahead).toEqual([]);
    expect(report.behind).toEqual([]);
    expect(remoteStatusExitCode(report)).toBe(2);
  });

  it('a document can be ahead and behind at once on different fields', () => {
    const report = plan(
      [issue('LP-1', { title: 'local title', status: 'in_progress' })],
      { 'LP-1': { remoteId: 'R1', base: { title: 'old title', status: 'in_progress' } } },
      new Map([['LP-1', { title: 'old title', status: 'done' }]]),
    );
    expect(report.ahead).toEqual(['LP-1']);
    expect(report.behind).toEqual(['LP-1']);
    expect(report.conflicted).toEqual([]);
    expect(remoteStatusExitCode(report)).toBe(1);
  });

  it('a conflict outranks a simultaneous push for the exit code', () => {
    const report = plan(
      [issue('LP-1', { title: 'local title', status: 'in_progress' })],
      {
        'LP-1': {
          remoteId: 'R1',
          base: { title: 'base title', status: 'in_progress' },
        },
      },
      new Map([['LP-1', { title: 'remote title', status: 'done' }]]),
    );
    // title: both changed (conflict); status: remote-only (behind).
    expect(report.conflicted).toEqual(['LP-1']);
    expect(report.behind).toEqual(['LP-1']);
    expect(remoteStatusExitCode(report)).toBe(2);
  });

  it('reports unlinked, orphaned and decoupled alongside the merge buckets', () => {
    const report = plan(
      [issue('LP-1'), issue('LP-2')], // LP-3 is the orphaned link, LP-4 the tombstone
      {
        'LP-1': { remoteId: 'R1', base: { title: 't', status: 'in_progress' } },
        'LP-3': { remoteId: 'R3', base: {} },
      },
      new Map([['LP-1', { title: 't', status: 'in_progress' }]]),
      { tombstones: { 'LP-4': { remoteKey: 'acme/payments#4', reason: 'manual', at: '2026-09-04T11:19:58Z' } } },
    );
    expect(report.unlinked).toEqual(['LP-2']);
    expect(report.orphaned).toEqual(['LP-3']);
    expect(report.decoupled).toEqual([{ localId: 'LP-4', reason: 'manual', remoteKey: 'acme/payments#4' }]);
  });
});

// ---------------------------------------------------------------------------
// --verbose field detail
// ---------------------------------------------------------------------------

describe('planStatus — field detail', () => {
  it('records local, remote and base for every differing field when verbose', () => {
    const report = plan(
      [issue('LP-1', { title: 'local title', status: 'in_progress' })],
      { 'LP-1': { remoteId: 'R1', base: { title: 'base title', status: 'in_progress' } } },
      new Map([['LP-1', { title: 'remote title', status: 'in_progress' }]]),
      { verbose: true },
    );
    const detail = report.fields!['LP-1']!;
    expect(detail).toEqual([
      { field: 'title', local: 'local title', remote: 'remote title', base: 'base title', outcome: 'conflict' },
    ]);
  });

  it('omits fields unless --verbose', () => {
    const report = plan(
      [issue('LP-1', { title: 'local title', status: 'in_progress' })],
      { 'LP-1': { remoteId: 'R1', base: { title: 'base title', status: 'in_progress' } } },
      new Map([['LP-1', { title: 'remote title', status: 'in_progress' }]]),
    );
    expect(report.conflicted).toEqual(['LP-1']);
    expect(report.fields).toBeUndefined();
  });

  it('omits fields the two sides agree on, even when verbose', () => {
    const report = plan(
      [issue('LP-1', { title: 'same', status: 'in_progress' })],
      { 'LP-1': { remoteId: 'R1', base: { title: 'base', status: 'in_progress' } } },
      new Map([['LP-1', { title: 'same', status: 'in_progress' }]]),
      { verbose: true },
    );
    expect(report.fields).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No credentials — the local half
// ---------------------------------------------------------------------------

describe('planStatus — no remote side', () => {
  it('reports ahead offline from local-vs-base, and says the remote half is missing', () => {
    const report = plan(
      [issue('LP-1', { title: 'new title' }), issue('LP-2', { title: 'same' })],
      {
        'LP-1': { remoteId: 'R1', base: { title: 'old title', status: 'in_progress' } },
        'LP-2': { remoteId: 'R2', base: { title: 'same', status: 'in_progress' } },
      },
      null,
      { remoteMissing: 'No credential for remote "upstream"' },
    );
    expect(report.remoteMissing).toBe('No credential for remote "upstream"');
    expect(report.ahead).toEqual(['LP-1']);
    expect(report.behind).toEqual([]);
    expect(report.conflicted).toEqual([]);
    expect(report.unlinked).toEqual([]);
    expect(remoteStatusExitCode(report)).toBe(1);
  });

  it('a document with no base counts as ahead offline', () => {
    const report = plan(
      [issue('LP-1', { title: 'anything' })],
      { 'LP-1': { remoteId: 'R1' } }, // no base
      null,
      { remoteMissing: 'No credential' },
    );
    expect(report.ahead).toEqual(['LP-1']);
  });

  it('exits 0 only when everything is in sync and the remote was read', () => {
    const report = plan(
      [issue('LP-1', { title: 'same', status: 'in_progress' })],
      { 'LP-1': { remoteId: 'R1', base: { title: 'same', status: 'in_progress' } } },
      new Map([['LP-1', { title: 'same', status: 'in_progress' }]]),
    );
    expect(report.ahead).toEqual([]);
    expect(report.behind).toEqual([]);
    expect(report.conflicted).toEqual([]);
    expect(report.unlinked).toEqual([]);
    expect(remoteStatusExitCode(report)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The per-node badge
// ---------------------------------------------------------------------------

describe('syncBadgeOf — one mark per document', () => {
  const emptyReport = () => ({
    remote: {
      name: 'upstream',
      provider: 'github',
      target: 'acme/payments',
      scope: null,
      inScope: 0,
      mirrored: 0,
      lastSync: null,
    },
    ahead: [] as string[],
    blocked: [],
    behind: [] as string[],
    conflicted: [] as string[],
    unlinked: [] as string[],
    incoming: [],
    orphaned: [] as string[],
    decoupled: [],
    unreadable: [],
    failed: [],
  });

  it('returns in-sync for a document no bucket names', () => {
    expect(syncBadgeOf(emptyReport(), 'LP-9')).toBe('in-sync');
  });

  it('picks each of the four drift states', () => {
    expect(syncBadgeOf({ ...emptyReport(), ahead: ['LP-1'] }, 'LP-1')).toBe('ahead');
    expect(syncBadgeOf({ ...emptyReport(), behind: ['LP-1'] }, 'LP-1')).toBe('behind');
    expect(syncBadgeOf({ ...emptyReport(), conflicted: ['LP-1'] }, 'LP-1')).toBe('conflicted');
    expect(syncBadgeOf({ ...emptyReport(), unlinked: ['LP-1'] }, 'LP-1')).toBe('unlinked');
  });

  it('conflicted wins over everything else', () => {
    const report = {
      ...emptyReport(),
      ahead: ['LP-1'],
      behind: ['LP-1'],
      conflicted: ['LP-1'],
    };
    expect(syncBadgeOf(report, 'LP-1')).toBe('conflicted');
  });

  it('ahead wins over behind when a document is both', () => {
    const report = { ...emptyReport(), ahead: ['LP-1'], behind: ['LP-1'] };
    expect(syncBadgeOf(report, 'LP-1')).toBe('ahead');
  });
});

// ---------------------------------------------------------------------------
// The denominator every count is read against
// ---------------------------------------------------------------------------

/**
 * A count with no denominator is not a metric.
 *
 * "433 ahead" means one thing when the mirror holds a single epic and quite
 * another when it holds every document on the board — and on the board this came
 * from, those two readings were a factor of twelve apart while nothing on screen
 * said which one applied. A reader concluded, reasonably, that the report was
 * broken. It was not; it had simply never been asked to say what it was counting.
 */
describe('planStatus — what the remote owns, and how much of it is mirrored', () => {
  /** Plan against a scope, which the `plan` helper above deliberately does not take. */
  function planScoped(
    issues: IssueDto[],
    entries: Record<string, { remoteId: string; base?: Record<string, unknown> }>,
    scope?: string,
  ) {
    return planStatus({
      board: viewOf(issues),
      store: linkStore(entries),
      options: manual(),
      fields: fields(),
      patches: null,
      remote: { ...header(), ...(scope !== undefined ? { scope } : {}) },
      ...(scope !== undefined ? { scope } : {}),
    });
  }

  const tree = () => [
    issue('LP-1'),
    issue('LP-2', { parentId: 'LP-1' }),
    issue('LP-3', { parentId: 'LP-2' }),
    issue('LP-9'), // a sibling subtree, outside any scope rooted at LP-1
  ];

  it('counts the whole board when no scope is declared', () => {
    const report = planScoped(tree(), { 'LP-2': { remoteId: '2' } });

    expect(report.remote.scope).toBeNull();
    expect(report.remote.inScope).toBe(4);
    expect(report.remote.mirrored).toBe(1);
  });

  it('counts only the subtree when a scope is declared', () => {
    const report = planScoped(tree(), { 'LP-2': { remoteId: '2' } }, 'LP-1');

    // LP-1, LP-2, LP-3 — not LP-9, which is somebody else's part of the board.
    expect(report.remote.scope).toBe('LP-1');
    expect(report.remote.inScope).toBe(3);
    expect(report.remote.mirrored).toBe(1);
  });

  it('never counts a mirrored document that is out of scope', () => {
    // A twin recorded before the scope was narrowed. It is not in scope, so it
    // is not part of the denominator *or* the numerator — otherwise the panel
    // would report more mirrored documents than the remote admits to owning.
    const report = planScoped(
      tree(),
      { 'LP-2': { remoteId: '2' }, 'LP-9': { remoteId: '9' } },
      'LP-1',
    );

    expect(report.remote.inScope).toBe(3);
    expect(report.remote.mirrored).toBe(1);
    expect(report.remote.mirrored).toBeLessThanOrEqual(report.remote.inScope);
  });

  it('agrees with the buckets it is shown beside', () => {
    // The point of computing both in `planStatus`: the denominator comes from the
    // same scope set that filters the buckets, so "N of M" and the bucket counts
    // can never tell different stories about one board.
    const report = planScoped(tree(), {}, 'LP-1');

    expect(report.unlinked).toEqual(['LP-1', 'LP-2', 'LP-3']);
    expect(report.unlinked.length).toBeLessThanOrEqual(report.remote.inScope);
    expect(report.remote.mirrored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ahead that can land, and ahead that never will
// ---------------------------------------------------------------------------

/**
 * The distinction that makes `ahead` readable.
 *
 * On the board this came from, **428 of 433** documents were ahead on an
 * `assignee` the tracker cannot hold — a generic pool, or a person with no
 * account. Every one of those is genuinely ahead and none of them will ever stop
 * being: the push tries, the remote refuses the field, the base records it unset,
 * and the next push tries again. Correct behaviour, and a headline number that
 * hid the five documents somebody could act on.
 */
describe('planStatus — blocked is the part of ahead that cannot land', () => {
  function planWith(
    issues: IssueDto[],
    entries: Record<string, { remoteId: string; base?: Record<string, unknown> }>,
    unwritable?: Map<string, Map<string, { reason: string; remedy?: string }>>,
  ) {
    return planStatus({
      board: viewOf(issues),
      store: linkStore(entries),
      options: manual(),
      fields: fields(),
      patches: null,
      remote: header(),
      ...(unwritable !== undefined ? { unwritable } : {}),
    });
  }

  const twin = { 'LP-1': { remoteId: '1', base: { title: 'LP-1', assignee: null } } };

  it('calls a document blocked when every field it is ahead on is unwritable', () => {
    const report = planWith(
      [issue('LP-1', { assignee: 'RS-9' })],
      twin,
      new Map([['LP-1', new Map([['assignee', { reason: 'Pool cannot be assigned' }]])]]),
    );

    expect(report.ahead).toEqual(['LP-1']);
    expect(report.blocked).toEqual([
      { localId: 'LP-1', fields: [{ field: 'assignee', reason: 'Pool cannot be assigned' }] },
    ]);
    // The honest total stays; the actionable part is what a headline shows.
    expect(pendingAhead(report)).toEqual([]);
  });

  it('does NOT call it blocked when something else is also ahead', () => {
    // "Only" is the whole test: this document's title is going to be written, so
    // it is ordinary pending work however unwritable its assignee is. Getting
    // this wrong would hide real edits behind a permanent one.
    const report = planWith(
      [issue('LP-1', { assignee: 'RS-9', title: 'A new title' })],
      twin,
      new Map([['LP-1', new Map([['assignee', { reason: 'Pool cannot be assigned' }]])]]),
    );

    expect(report.ahead).toEqual(['LP-1']);
    expect(report.blocked).toEqual([]);
    expect(pendingAhead(report)).toEqual(['LP-1']);
  });

  it('reports nothing blocked when the caller cannot say what is unwritable', () => {
    // No `unwritable` map means "nothing is known to be unwritable". It must not
    // guess that a change will land, so every ahead document stays actionable.
    const report = planWith([issue('LP-1', { assignee: 'RS-9' })], twin);

    expect(report.ahead).toEqual(['LP-1']);
    expect(report.blocked).toEqual([]);
    expect(pendingAhead(report)).toEqual(['LP-1']);
  });

  it('never reports a document as blocked that is not ahead at all', () => {
    // An unwritable field on a document that agrees with its base is not drift.
    const report = planWith(
      [issue('LP-1')],
      { 'LP-1': { remoteId: '1', base: { title: 'LP-1', assignee: null } } },
      new Map([['LP-1', new Map([['assignee', { reason: 'Pool cannot be assigned' }]])]]),
    );

    expect(report.ahead).toEqual([]);
    expect(report.blocked).toEqual([]);
  });

  it('pendingAhead is the honest complement of blocked', () => {
    const report = planWith(
      [issue('LP-1', { assignee: 'RS-9' }), issue('LP-2', { title: 'Edited' })],
      {
        'LP-1': { remoteId: '1', base: { title: 'LP-1', assignee: null } },
        'LP-2': { remoteId: '2', base: { title: 'LP-2', assignee: null } },
      },
      new Map([['LP-1', new Map([['assignee', { reason: 'Pool cannot be assigned' }]])]]),
    );

    expect(report.ahead.sort()).toEqual(['LP-1', 'LP-2']);
    expect(report.blocked.map((entry) => entry.localId)).toEqual(['LP-1']);
    expect(pendingAhead(report)).toEqual(['LP-2']);
    // The two halves account for all of it, always.
    expect(pendingAhead(report).length + report.blocked.length).toBe(report.ahead.length);
  });
});
