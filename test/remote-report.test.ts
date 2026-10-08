import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createIssue, createResource, loadConfig } from '../src/core/index.js';
import type { BoardPaths } from '../src/core/storage/paths.js';
import { PARENT_FIELD } from '../src/remote/hierarchy.js';
import { renderManagedBlock } from '../src/remote/managed-block.js';
import { computeRemoteStatus } from '../src/remote/report.js';
import { saveLinkStore, type LinkEntry, type LinkStore } from '../src/remote/links.js';
import { emptyJsonStore, writeJsonStore, type JsonIssue } from '../src/remote/providers/jsonfile/store.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * The drift report's remote half.
 *
 * This is the suite that did not exist, and its absence is exactly why the two
 * defects it now pins reached a working board: `computeRemoteStatus` was
 * covered only by `remote-live.test.ts`, which is opt-in, needs a credential
 * and is skipped on every ordinary `npm test`. So nothing offline ever observed
 * that the remote half read one twin at a time, and nothing observed that a
 * remote issue nobody had pulled was missing from every bucket.
 *
 * `jsonfile` is the vehicle rather than a stubbed `fetch`: its connector reads
 * a real file with `node:fs`, so the report runs end to end — `openRemote`,
 * `buildConnector`, the provider's own `list`, its `describe`, its pull seams
 * and `planStatus` — with no transport double in the middle. A fake connector
 * would have let the old per-twin loop pass a "counts the requests" test by
 * counting the wrong thing.
 */

const TRACKER = '.lpm/remotes/upstream/tracker.json';

/**
 * A board mirroring onto one jsonfile remote.
 *
 * `scope` names which document the remote owns by *role* rather than by id,
 * because the ids are allocated in here.
 */
function board(options: { scope?: 'program' | 'feature' } = {}): {
  paths: BoardPaths;
  program: string;
  feature: string;
} {
  const paths = makeBoard('scrum', 'LP');
  const program = createIssue(reload(paths), { type: 'program', title: 'Platform' });
  const epic = createIssue(reload(paths), {
    type: 'epic',
    title: 'Board loading and queries',
    parentId: program.id,
  });
  const feature = createIssue(reload(paths), {
    type: 'feature',
    title: 'Queries',
    parentId: epic.id,
  });

  const scopeId =
    options.scope === 'program' ? program.id : options.scope === 'feature' ? feature.id : undefined;
  const text = `
remotes:
  upstream:
    provider: jsonfile
    on_delete: unlink
    conflict: manual
${scopeId !== undefined ? `    scope: ${scopeId}\n` : ''}    connection:
      file: ${TRACKER}
    mapping:
      statuses:
        backlog: Backlog
        ready: Ready
        in_progress: In Progress
        in_review: In Review
        done: { remote: Done, closed: true }
`;
  writeFileSync(paths.configPath, `${readFileSync(paths.configPath, 'utf8')}${text}`, 'utf8');
  loadConfig(paths); // fail here rather than inside the report if the block is wrong
  return { paths, program: program.id, feature: feature.id };
}

/** One issue in the tracker file. `parent` rides the managed block, as jsonfile's does. */
function issue(number: number, title: string, parentRemoteId?: string): JsonIssue {
  const block =
    parentRemoteId === undefined
      ? ''
      : `\n\n${renderManagedBlock([{ name: PARENT_FIELD, kind: 'id', value: parentRemoteId }])}`;
  return {
    number,
    title,
    body: `Prose.${block}`,
    status: 'Backlog',
    type: 'feature',
    labels: [],
    assignee: null,
    depends_on: [],
    comments: [],
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
  };
}

/** Write the tracker file the connector will read. */
function tracker(paths: BoardPaths, issues: JsonIssue[]): void {
  writeJsonStore(`${paths.root}/${TRACKER}`, {
    ...emptyJsonStore(),
    issues,
    next_number: Math.max(0, ...issues.map((entry) => entry.number)) + 1,
  });
}

/** A link entry for a twin, with a base that agrees with the tracker. */
function twin(remoteId: string, base?: Record<string, unknown>): LinkEntry {
  return {
    remoteId,
    remoteKey: `#${remoteId}`,
    remoteUrl: `file://tracker#${remoteId}`,
    syncedAt: '2026-09-01T10:00:00Z',
    remoteRev: '2026-09-01T10:00:00Z',
    ...(base !== undefined ? { base } : {}),
  };
}

function store(entries: Record<string, LinkEntry>, cursor: string | null = null): LinkStore {
  const links = new Map(Object.entries(entries));
  const byRemote = new Map([...links].map(([localId, link]) => [link.remoteId, localId]));
  return { version: 1, cursor, links, byRemote, tombstones: new Map(), hierarchy: undefined };
}

// ---------------------------------------------------------------------------
// The bucket that was missing
// ---------------------------------------------------------------------------

describe('incoming — a remote issue the board has never seen', () => {
  it('reports a story added upstream under a mirrored parent', async () => {
    const { paths, feature } = board();
    tracker(paths, [issue(1, 'Queries'), issue(2, 'Paginate the query API', '1')]);
    saveLinkStore(paths, 'upstream', store({ [feature]: twin('1') }));

    const report = await computeRemoteStatus(reload(paths), 'upstream');

    // The whole point: five buckets keyed on local ids could not name this.
    expect(report.incoming).toEqual([
      {
        remoteId: '2',
        remoteKey: '#2',
        remoteUrl: expect.stringContaining('#2'),
        title: 'Paginate the query API',
        parentLocalId: feature,
      },
    ]);
    // And it is drift, so a CI run notices.
    expect(report.behind).toEqual([]);
  });

  it('says nothing is incoming when every remote issue has a twin', async () => {
    const { paths, feature } = board();
    tracker(paths, [issue(1, 'Queries')]);
    saveLinkStore(paths, 'upstream', store({ [feature]: twin('1') }));

    const report = await computeRemoteStatus(reload(paths), 'upstream');

    expect(report.incoming).toEqual([]);
  });

  it('files an unparented remote issue as incoming with no parent', async () => {
    const { paths, feature } = board();
    tracker(paths, [issue(1, 'Queries'), issue(2, 'Filed at the root')]);
    saveLinkStore(paths, 'upstream', store({ [feature]: twin('1') }));

    const report = await computeRemoteStatus(reload(paths), 'upstream');

    expect(report.incoming).toHaveLength(1);
    expect(report.incoming[0]!.parentLocalId).toBeUndefined();
  });

  it('leaves incoming empty when the remote half was not read', async () => {
    const { paths, feature } = board();
    tracker(paths, [issue(1, 'Queries'), issue(2, 'Added upstream', '1')]);
    saveLinkStore(paths, 'upstream', store({ [feature]: twin('1') }));

    const report = await computeRemoteStatus(reload(paths), 'upstream', { local: true });

    // "Nobody looked" and "nothing arrived" are told apart by remoteMissing,
    // never by an empty list.
    expect(report.incoming).toEqual([]);
    expect(report.remoteMissing).toContain('not read');
    expect(report.remoteRead).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe('incoming respects the remote scope', () => {
  it('ignores a remote issue anchored outside the scope', async () => {
    // A remote mirroring one feature has no business reporting the rest of
    // somebody's tracker as work to import: #9 is anchored nowhere the scope
    // reaches, so it is not offered.
    const { paths, feature } = board({ scope: 'feature' });
    tracker(paths, [issue(1, 'Queries'), issue(9, 'Something else in the tracker')]);
    saveLinkStore(paths, 'upstream', store({ [feature]: twin('1') }));

    const report = await computeRemoteStatus(reload(paths), 'upstream');

    expect(report.incoming).toEqual([]);
  });

  it('keeps a remote issue anchored inside the scope', async () => {
    const { paths, feature } = board({ scope: 'feature' });
    tracker(paths, [issue(1, 'Queries'), issue(2, 'Inside the scope', '1')]);
    saveLinkStore(paths, 'upstream', store({ [feature]: twin('1') }));

    const report = await computeRemoteStatus(reload(paths), 'upstream');

    expect(report.incoming.map((entry) => entry.remoteId)).toEqual(['2']);
  });
});

// ---------------------------------------------------------------------------
// What the remote half costs
// ---------------------------------------------------------------------------

describe('the remote half is one listing, not one request per twin', () => {
  it('reads many twins in a single request and says so', async () => {
    const { paths, feature } = board();
    const issues = Array.from({ length: 30 }, (_, index) => issue(index + 1, `Issue ${index + 1}`));
    tracker(paths, issues);
    // Every remote issue is a twin of something, so there is nothing incoming
    // and nothing unreadable — only the cost is under test.
    const entries: Record<string, LinkEntry> = { [feature]: twin('1') };
    saveLinkStore(paths, 'upstream', store(entries));

    const pages: Array<{ page: number; records: number }> = [];
    const report = await computeRemoteStatus(reload(paths), 'upstream', {
      onProgress: (progress) => pages.push(progress),
    });

    // The remote half read all 30 in one listing. What this pins is the *shape*:
    // one `list` call, whose internal pages are reported through `onPage`. The
    // old code called `get` once per link entry, which is where the 537 requests
    // came from; the guard that keeps it from coming back is that `list` is
    // called once and its cursor is never treated as a continuation token.
    expect(report.remoteRead).toBe(30);
    expect(pages).toEqual([{ page: 1, records: 30 }]);
  });

  it('reports a twin absent from a full listing as unreadable', async () => {
    const { paths, feature, program } = board();
    tracker(paths, [issue(1, 'Queries')]);
    saveLinkStore(paths, 'upstream', store({ [feature]: twin('1'), [program]: twin('404') }));

    const report = await computeRemoteStatus(reload(paths), 'upstream');

    expect(report.unreadable).toEqual([{ localId: program, remoteId: '404' }]);
  });
});

// ---------------------------------------------------------------------------
// Nothing mirrored
// ---------------------------------------------------------------------------

describe('a board with nothing mirrored reads no tracker', () => {
  it('is in sync without a request, and reports no incoming work', async () => {
    const { paths } = board();
    // A tracker full of issues, and not one twin on this board.
    tracker(paths, [issue(1, 'Something'), issue(2, 'Something else')]);
    saveLinkStore(paths, 'upstream', store({}));

    const pages: unknown[] = [];
    const report = await computeRemoteStatus(reload(paths), 'upstream', {
      onProgress: (progress) => pages.push(progress),
    });

    // Every remote issue anchors nowhere, so a listing could only report the
    // tracker's whole contents as work to import — true, and nothing anybody
    // can act on. `lpm remote pull` is what adopts a tracker onto a fresh board.
    expect(pages).toEqual([]);
    expect(report.remoteRead).toBe(0);
    expect(report.incoming).toEqual([]);
    // And it is still a *read*, not a missing remote half, so the report can
    // say "in sync" about a board with nothing to sync.
    expect(report.remoteMissing).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The incremental gear, and why absence stands down for it
// ---------------------------------------------------------------------------

describe('an incremental listing proves nothing by absence', () => {
  it('suppresses unreadable and incoming, and says it was incremental', async () => {
    const { paths, feature, program } = board();
    // The listing will hold only what the cursor lets through; whatever it
    // holds, an unchanged twin missing from it is not a deleted twin, and an
    // untwinned remote issue missing from it is not one the board already has.
    tracker(paths, [issue(1, 'Queries'), issue(2, 'Added upstream', '1')]);
    saveLinkStore(
      paths,
      'upstream',
      store({ [feature]: twin('1'), [program]: twin('404') }, '2026-09-10T00:00:00Z'),
    );

    const report = await computeRemoteStatus(reload(paths), 'upstream', { changed: true });

    expect(report.incremental).toBe(true);
    expect(report.unreadable).toEqual([]);
    expect(report.incoming).toEqual([]);
  });

  it('is a full listing when the store has no cursor to be incremental about', async () => {
    const { paths, feature } = board();
    tracker(paths, [issue(1, 'Queries'), issue(2, 'Added upstream', '1')]);
    saveLinkStore(paths, 'upstream', store({ [feature]: twin('1') }));

    const report = await computeRemoteStatus(reload(paths), 'upstream', { changed: true });

    // `--changed` on a store that never synced degrades to the full listing
    // rather than erroring — and the report says which it was.
    expect(report.incremental).toBeUndefined();
    expect(report.incoming.map((entry) => entry.remoteId)).toEqual(['2']);
  });
});

// ---------------------------------------------------------------------------
// What a blocked edit needs from a person
// ---------------------------------------------------------------------------

/**
 * A reason tells somebody they have a problem; a remedy tells them what to do.
 *
 * "Web Developer cannot be assigned on this remote" is true and leaves the
 * question *so what?* — which is exactly what a reader asked on seeing it. The
 * causes want different answers, and they are derived from the roster and the
 * mapping rather than by matching the reason text, which is the provider's to
 * word and would break the first time anybody rephrased one.
 *
 * The remote here is **github**, not the `jsonfile` the rest of this file uses,
 * for one reason: the file provider declares no `accounts` mapping at all, so
 * `assignee` is never a tracked field there and can never be blocked. Reading
 * the *local* half builds no connector, so this still runs offline with no
 * credential — and the local half is the comparison the panel paints first.
 */
describe('a blocked field says what would unblock it', () => {
  /** A board whose one issue is assigned to a person or a pool, mirrored to github. */
  function assignedBoard(options: {
    type: 'person' | 'role';
    attributes?: Record<string, unknown>;
    accounts?: boolean;
    /** `github` writes labels; `jira` does not. A pool rides a label. */
    provider?: 'github' | 'jira';
  }) {
    const paths = makeBoard('scrum', 'LP');
    const person = createResource(reload(paths), {
      type: options.type,
      title: options.type === 'role' ? 'Engine Developer' : 'Ada',
      ...(options.attributes !== undefined ? { attributes: options.attributes } : {}),
    });
    const story = createIssue(reload(paths), {
      type: 'program',
      title: 'Work',
      assignee: person.id,
    });

    const accounts = options.accounts === false ? '' : '      accounts:\n        via: email\n';
    const jira = options.provider === 'jira';
    const connection = jira
      ? '      site: https://acme.atlassian.net\n      project: PAY'
      : '      repo: acme/payments';
    const types = jira ? '      types:\n        program: Task\n' : '';
    const carrier = jira ? 'sprint' : 'milestones';
    const text = `
remotes:
  upstream:
    provider: ${options.provider ?? 'github'}
    on_delete: unlink
    conflict: manual
    connection:
${connection}
    mapping:
${types}${accounts}      statuses:
        backlog: Backlog
        ready: Ready
        in_progress: In Progress
        in_review: In Review
        done: { remote: Done, closed: true }
      periods:
        container: sprint
        carrier: ${carrier}
`;
    writeFileSync(paths.configPath, `${readFileSync(paths.configPath, 'utf8')}${text}`, 'utf8');
    // A base recording the assignee as unset and nothing else: only fields the
    // base carries are tracked, so the document is ahead on exactly one field —
    // which is what `blocked` means, ahead *only* on what cannot be written.
    saveLinkStore(paths, 'upstream', store({ [story.id]: twin('1', { assignee: null }) }));
    return { paths, story: story.id, person: person.id };
  }

  it('tells you which attribute to set when a person has no account value', async () => {
    const { paths, story, person } = assignedBoard({ type: 'person', attributes: { email: null } });

    const report = await computeRemoteStatus(reload(paths), 'upstream', { local: true });

    const entry = report.blocked.find((blocked) => blocked.localId === story);
    expect(entry?.fields[0]?.reason).toContain('"email"');
    // The fix is one edit, and the message names the document to make it on.
    expect(entry?.fields[0]?.remedy).toContain(`Set "email" on ${person}`);
  });

  it('says a pool is not a person, where the remote cannot carry one', async () => {
    // Jira writes no labels, so a generic pool has nowhere to go at all.
    const { paths, story } = assignedBoard({ type: 'role', provider: 'jira' });

    const report = await computeRemoteStatus(reload(paths), 'upstream', { local: true });

    const entry = report.blocked.find((blocked) => blocked.localId === story);
    expect(entry?.fields[0]?.reason).toContain('pool');
    // Two real answers, and neither of them is "sync again".
    expect(entry?.fields[0]?.remedy).toContain('named person');
    expect(entry?.fields[0]?.remedy).toContain('accounts');
  });

  it('does not call a pool blocked where the remote carries it as a label', async () => {
    // GitHub encodes an unassignable pool as a `pool:` label, which a pull reads
    // back — so it *is* mirrored and nothing is blocked. This is the distinction
    // that makes "did the translator complain?" the wrong question and "would the
    // request carry the value?" the right one: a pool reports no gap either way.
    const { paths, story } = assignedBoard({ type: 'role', provider: 'github' });

    const report = await computeRemoteStatus(reload(paths), 'upstream', { local: true });

    expect(report.blocked.find((blocked) => blocked.localId === story)).toBeUndefined();
  });

  it('does not call an assignee blocked when the remote does not mirror assignees', async () => {
    // No `accounts` mapping means `assignee` is not a tracked field at all, so
    // the two sides never disagree about it. "Not mirrored" and "mirrored but
    // unwritable" are different situations, and only the second is worth a
    // reader's attention.
    const { paths, story } = assignedBoard({
      type: 'person',
      attributes: { email: 'ada@example.com' },
      accounts: false,
    });

    const report = await computeRemoteStatus(reload(paths), 'upstream', { local: true });

    expect(report.blocked.find((blocked) => blocked.localId === story)).toBeUndefined();
  });

  it('reports nothing blocked when the assignee can be written', async () => {
    const { paths, story } = assignedBoard({
      type: 'person',
      attributes: { email: 'ada@example.com' },
    });

    const report = await computeRemoteStatus(reload(paths), 'upstream', { local: true });

    // Ahead, yes — the value has not been pushed. Blocked, no: it can be.
    expect(report.ahead).toContain(story);
    expect(report.blocked).toEqual([]);
  });
});
