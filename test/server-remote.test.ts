import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import type {
  RemoteCoverageReport,
  RemoteReadinessFixResultDto,
  RemoteReadinessReport,
  RemotePreviewDto,
  RemoteResolveResultDto,
  RemoteStatusReport,
  RemoteSummaryDto,
} from '../src/shared/index.js';
import { startBoardServer } from '../src/server/index.js';
import { remoteSyncGuard, resetRemoteSyncGuard, toPreviewDto } from '../src/server/routes/remotes.js';
import type { RunSyncResult } from '../src/remote/index.js';
import { cleanupBoards, makeBoard } from './helpers.js';

/**
 * LP-344 — the remote routes in the local server.  Everything here runs with
 * no credentials and no network: `status` reports the local half and says the
 * remote half is missing, `resolve` is offline by design, and the sync route's
 * guard, validation and the origin/Host posture are all reachable without a
 * connector ever dialling out.
 */

afterAll(cleanupBoards);

/** A GitHub remote declaration whose mapping totals the scrum template's statuses. */
const REMOTES = `
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      types:
        user_story: { labels: [story] }
      statuses:
        backlog: Backlog
        ready: Ready
        in_progress: In Progress
        in_review: In Review
        done: { remote: [Done], push: Done, closed: true }
      attributes:
        story_points: Points
      periods:
        container: sprint
`;

const LINKED_ISSUE = `---
id: LP-12
type: user_story
title: Login page
status: in_progress
---

Body.
`;

const LINKS = {
  version: 1,
  cursor: null,
  links: {
    'LP-12': {
      remoteId: 'I_1',
      remoteKey: 'acme/payments#1',
      remoteUrl: 'https://github.com/acme/payments/issues/1',
      syncedAt: '2026-08-15T00:00:00.000Z',
      remoteRev: 'r1',
      base: {
        title: 'Login page',
        body: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        status: 'in_progress',
        story_points: 5,
      },
    },
  },
};

/** A board with one GitHub remote, a linked issue and an unlinked one. */
const json = async <T>(base: string, path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${base}${path}`, init);
  return (await response.json()) as T;
};

const post = (path: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('remote routes', () => {
  let paths: BoardPaths;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    paths = makeBoard('scrum', 'LP');
    const config = readFileSync(paths.configPath, 'utf8');
    writeFileSync(paths.configPath, config + REMOTES);

    mkdirSync(`${paths.boardDir}/LP-12`, { recursive: true });
    writeFileSync(`${paths.boardDir}/LP-12/_issue.md`, LINKED_ISSUE);
    mkdirSync(`${paths.boardDir}/LP-13`, { recursive: true });
    writeFileSync(
      `${paths.boardDir}/LP-13/_issue.md`,
      LINKED_ISSUE.replace('id: LP-12', 'id: LP-13').replace('title: Login page', 'title: Signup page'),
    );

    mkdirSync(`${paths.remotesDir}/upstream`, { recursive: true });
    writeFileSync(`${paths.remotesDir}/upstream/links.json`, JSON.stringify(LINKS, null, 2));

    const running = await startBoardServer(paths, { port: 0, serveApp: false, experimental: true });
    server = running.server;
    base = running.url;
  });

  afterAll(() => {
    server.close();
    resetRemoteSyncGuard();
  });

  afterEach(() => {
    resetRemoteSyncGuard();
  });

  it('lists the configured remotes with their last-sync state', async () => {
    const remotes = await json<RemoteSummaryDto[]>(base, '/api/remotes');
    expect(remotes).toEqual([
      {
        name: 'upstream',
        provider: 'github',
        direction: 'both',
        target: 'acme/payments',
        lastSync: '2026-08-15T00:00:00.000Z',
      },
    ]);
  });

  it('reports the drift report; without credentials the remote half is missing', async () => {
    const report = await json<RemoteStatusReport>(base, '/api/remotes/upstream/status');
    expect(report.remote).toEqual({
      name: 'upstream',
      provider: 'github',
      target: 'acme/payments',
      // What the remote owns, and how much of it is mirrored — the denominator
      // every count below is read against. This remote declares no scope, so it
      // owns the whole board: two issues, one of them twinned.
      scope: null,
      inScope: 2,
      mirrored: 1,
      lastSync: '2026-08-15T00:00:00.000Z',
    });
    // The connector could not be built — no credential — so the local half is
    // still reported and the remote half names why it is missing.
    expect(report.remoteMissing).toBeDefined();
    expect(report.remoteMissing).toContain('No credential');
    expect(report.unlinked).toEqual(['LP-13']);
    expect(report.conflicted).toEqual([]);
    expect(report.orphaned).toEqual([]);
    // The remote twin travels with the report, so the panel can link to it.
    expect(report.links?.['LP-12']).toEqual({
      remoteId: 'I_1',
      remoteKey: 'acme/payments#1',
      remoteUrl: 'https://github.com/acme/payments/issues/1',
    });
  });

  it('answers the local half at once, saying why the remote columns are empty', async () => {
    // What a screen reads first: no connector is built and nothing is fetched,
    // so it needs no credential and cannot fail — which is what a tab opening a
    // board depends on. The remote half is one paginated listing (seconds, not
    // the two minutes one-request-per-twin cost), but it still needs a token.
    const report = await json<RemoteStatusReport>(base, '/api/remotes/upstream/status?local=1');
    expect(report.remoteMissing).toBe(
      'the remote was not read — this is the local half of the report',
    );
    expect(report.unlinked).toEqual(['LP-13']);
    expect(report.links?.['LP-12']?.remoteKey).toBe('acme/payments#1');
    expect(report.behind).toEqual([]);
    expect(report.conflicted).toEqual([]);
    // Incoming is remote-side, so the local half reports none of it — and the
    // field is always present, so a client never has to guess whether an older
    // server sent it.
    expect(report.incoming).toEqual([]);
  });

  it('accepts ?changed=1, the incremental read, and mirrors the CLI flag', async () => {
    // The same three gears `lpm remote status` has, over HTTP: the default full
    // listing, `?local=1` and `?changed=1`. Without a credential the remote half
    // is missing either way, which is what this can assert offline — what it
    // pins is that the route *takes* the option rather than 400-ing on it, so the
    // terminal and the browser are not two different reports.
    const report = await json<RemoteStatusReport>(
      base,
      '/api/remotes/upstream/status?changed=1',
    );
    expect(report.remoteMissing).toContain('No credential');
    // Nothing was read, so nothing claims to have been read incrementally.
    expect(report.incremental).toBeUndefined();
    expect(report.remoteRead).toBeUndefined();
    expect(report.incoming).toEqual([]);
  });

  it('resolves a conflict, recording the decision without making a request', async () => {
    const result = await json<RemoteResolveResultDto>(
      base,
      '/api/remotes/upstream/resolve',
      post('/api/remotes/upstream/resolve', { id: 'LP-12', default: 'local' }),
    );
    expect(result).toEqual({ remoteName: 'upstream', localId: 'LP-12', default: 'local', fields: {} });

    const onDisk = JSON.parse(
      readFileSync(`${paths.remotesDir}/upstream/resolutions.json`, 'utf8'),
    ) as { resolutions: Record<string, unknown> };
    expect(onDisk.resolutions['LP-12']).toEqual({ default: 'local' });
  });

  it('answers a conflict detail request with 404 for an unlinked document', async () => {
    const response = await fetch(`${base}/api/remotes/upstream/conflicts/LP-13`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toMatch(/has no open conflict/);
  });

  it('reports a conflict detail request for a linked document when the remote cannot be read', async () => {
    const response = await fetch(`${base}/api/remotes/upstream/conflicts/LP-12`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/credential/i);
  });

  it('resolves a single field', async () => {
    const result = await json<RemoteResolveResultDto>(
      base,
      '/api/remotes/upstream/resolve',
      post('/api/remotes/upstream/resolve', { id: 'LP-12', fields: { status: 'remote' } }),
    );
    expect(result.fields).toEqual({ status: 'remote' });
  });

  it('refuses a resolve naming an untracked field or an unlinked document', async () => {
    const untracked = await fetch(
      `${base}/api/remotes/upstream/resolve`,
      post('/api/remotes/upstream/resolve', { id: 'LP-12', fields: { bogus: 'local' } }),
    );
    expect(untracked.status).toBe(400);
    expect(((await untracked.json()) as { error: string }).error).toMatch(/not a field this remote tracks/);

    const unlinked = await fetch(
      `${base}/api/remotes/upstream/resolve`,
      post('/api/remotes/upstream/resolve', { id: 'LP-13', default: 'local' }),
    );
    expect(unlinked.status).toBe(400);
    expect(((await unlinked.json()) as { error: string }).error).toMatch(/is not linked/);
  });

  it('refuses an unknown remote and an unknown direction', async () => {
    const unknown = await fetch(
      `${base}/api/remotes/bogus/sync`,
      post('/api/remotes/bogus/sync', {}),
    );
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toMatch(/No remote named "bogus"/);

    const direction = await fetch(
      `${base}/api/remotes/upstream/sync`,
      post('/api/remotes/upstream/sync', { direction: 'sideways' }),
    );
    expect(direction.status).toBe(400);
    expect(((await direction.json()) as { error: string }).error).toMatch(/Unknown sync direction/);
  });

  it('refuses a second sync while one is in flight with a conflict status', async () => {
    remoteSyncGuard.inFlight = 'upstream';
    try {
      const response = await fetch(
        `${base}/api/remotes/upstream/sync`,
        post('/api/remotes/upstream/sync', {}),
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toMatch(/already running/);
    } finally {
      remoteSyncGuard.inFlight = null;
    }
  });

  it('refuses a cross-origin request and a non-loopback Host', async () => {
    const crossOrigin = await fetch(`${base}/api/remotes`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(crossOrigin.status).toBe(403);

    const port = new URL(base).port;
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: Number(port), path: '/api/board', headers: { Host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(hostStatus).toBe(403);
  });
});

/**
 * LP-345 — the preview wire shape: the dry-run's structured sections travel so
 * the web panel can render them grouped by operation kind rather than parsing
 * the CLI's text back out.
 */
/**
 * Selecting what a run acts on, over the offline provider.
 *
 * Its own board and server, for two reasons. A board may not declare two
 * remotes that both mirror the whole of it — the one-document-one-remote rule
 * is enforced in the config — so this cannot share the GitHub fixture above.
 * And a push *dry run* is not offline the way it looks: prerequisites ask the
 * tracker what it already has, so previewing against GitHub either fails on
 * the credential or, if one happens to be in the environment, makes a real
 * request from the unit suite. `jsonfile` needs neither.
 */
describe('narrowing a run to particular documents', () => {
  let paths: BoardPaths;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    paths = makeBoard('scrum', 'LP');
    writeFileSync(
      paths.configPath,
      readFileSync(paths.configPath, 'utf8') +
        `
remotes:
  local:
    provider: jsonfile
    on_delete: unlink
    conflict: manual
    connection:
      file: .lpm/remotes/local/tracker.json
    mapping:
      types:
        user_story: { remote: story }
      statuses:
        backlog: Backlog
        ready: Ready
        in_progress: In Progress
        in_review: In Review
        done: { remote: Done, closed: true }
`,
    );

    for (const [id, title] of [
      ['LP-12', 'Login page'],
      ['LP-13', 'Signup page'],
    ]) {
      mkdirSync(`${paths.boardDir}/${id}`, { recursive: true });
      writeFileSync(
        `${paths.boardDir}/${id}/_issue.md`,
        LINKED_ISSUE.replace('id: LP-12', `id: ${id}`).replace('title: Login page', `title: ${title}`),
      );
    }

    const running = await startBoardServer(paths, { port: 0, serveApp: false, experimental: true });
    server = running.server;
    base = running.url;
  });

  afterAll(() => {
    server.close();
    resetRemoteSyncGuard();
  });

  /** Every local id the preview's plan names. */
  const idsOf = (plan: RemotePreviewDto): Set<string> =>
    new Set(
      plan.renders.flatMap((render) =>
        render.sections.flatMap((section) => section.documents.map((document) => document.localId)),
      ),
    );

  const preview = async (body: Record<string, unknown>): Promise<RemotePreviewDto> => {
    const response = await fetch(`${base}/api/remotes/local/preview`, post('/api/remotes/local/preview', body));
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as RemotePreviewDto;
  };

  it('acts on exactly what `only` names, and leaves its siblings alone', async () => {
    // `only` and `scope` are not two spellings of the same thing: `only` acts
    // on exactly what it names, `scope` expands to everything under a root.
    // The side panel's Push and "Push subtree" buttons are the two callers, so
    // the route has to keep them apart all the way to `runSync`.
    const everything = idsOf(await preview({ direction: 'push' }));
    expect(everything.has('LP-12') && everything.has('LP-13')).toBe(true);

    const one = idsOf(await preview({ direction: 'push', only: ['LP-12'] }));
    expect(one.has('LP-12'), 'the document the run named').toBe(true);
    expect(one.has('LP-13'), 'a sibling the run did not name').toBe(false);
  });

  it('treats an empty `only` as no selection at all, not a selection of nothing', async () => {
    // Forwarded as a selection, an empty list would make a whole-board push
    // file nothing and report success.
    const everything = idsOf(await preview({ direction: 'push' }));
    expect(idsOf(await preview({ direction: 'push', only: [] }))).toEqual(everything);
  });
});

describe('toPreviewDto', () => {
  const renderOf = () => ({
    total: 2,
    sections: [
      {
        kind: 'create',
        label: 'create',
        count: 2,
        documents: [
          {
            localId: 'LP-1',
            title: 'Login page',
            kind: 'create',
            fields: [{ field: 'title', local: 'Login page', remote: null, outcome: 'created' }],
          },
        ],
      },
    ],
    conflicts: [],
    text: 'Sync plan — 2 operations',
  });

  const result = (over: Partial<RunSyncResult> = {}): RunSyncResult => ({
    remoteName: 'upstream',
    direction: 'push',
    dryRun: true,
    preflight: [],
    preflightBlocked: false,
    ...over,
  });

  it('carries total and the sections grouped by kind, not just the text', () => {
    const dto = toPreviewDto('upstream', result({ renders: [renderOf()] }));

    expect(dto.renders).toEqual([
      {
        direction: 'push',
        total: 2,
        sections: [
          {
            kind: 'create',
            label: 'create',
            count: 2,
            documents: [
              {
                localId: 'LP-1',
                title: 'Login page',
                kind: 'create',
                fields: [{ field: 'title', local: 'Login page', remote: null, outcome: 'created' }],
              },
            ],
          },
        ],
        text: 'Sync plan — 2 operations',
      },
    ]);
  });

  it('labels the first render pull and the second push on a both run', () => {
    const dto = toPreviewDto(
      'upstream',
      result({
        direction: 'both',
        pullPlan: { changes: [], links: [] },
        renders: [renderOf(), renderOf()],
      }),
    );

    expect(dto.renders.map((render) => render.direction)).toEqual(['pull', 'push']);
  });
});

describe('the coverage route', () => {
  let paths: BoardPaths;
  let server: Server;
  let base: string;

  /** Write one document at `dir`, creating the folder. */
  function write(dir: string, front: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${dir.includes('timeline') ? '_period' : '_issue'}.md`, `---\n${front}---\n\nBody.\n`);
  }

  beforeAll(async () => {
    paths = makeBoard('scrum', 'LP');
    writeFileSync(paths.configPath, readFileSync(paths.configPath, 'utf8') + REMOTES);

    // program › epic › feature › two stories, the feature scheduled into a
    // sprint. Only the feature is mirrored — the shape somebody gets after
    // `lpm remote push LP-3`.
    const program = `${paths.boardDir}/LP-1`;
    const epic = `${program}/LP-2`;
    const feature = `${epic}/LP-3`;
    write(program, 'id: LP-1\ntype: program\ntitle: Payments\nstatus: in_progress\n');
    write(epic, 'id: LP-2\ntype: epic\ntitle: Checkout\nstatus: in_progress\n');
    write(feature, 'id: LP-3\ntype: feature\ntitle: Card capture\nstatus: in_progress\nperiod: TL-2\n');
    write(`${feature}/LP-4`, 'id: LP-4\ntype: user_story\ntitle: Tokenize\nstatus: backlog\n');
    write(`${feature}/LP-5`, 'id: LP-5\ntype: user_story\ntitle: Retry\nstatus: backlog\n');

    const increment = `${paths.timelineDir}/TL-1`;
    write(increment, 'id: TL-1\ntype: increment\ntitle: PI 1\n');
    write(`${increment}/TL-2`, 'id: TL-2\ntype: sprint\ntitle: Sprint 3\n');

    mkdirSync(`${paths.remotesDir}/upstream`, { recursive: true });
    writeFileSync(
      `${paths.remotesDir}/upstream/links.json`,
      JSON.stringify(
        {
          version: 1,
          cursor: null,
          links: {
            'LP-3': {
              remoteId: 'I_3',
              remoteKey: 'acme/payments#3',
              remoteUrl: 'https://github.com/acme/payments/issues/3',
              syncedAt: '2026-08-15T00:00:00.000Z',
              remoteRev: 'r1',
            },
          },
        },
        null,
        2,
      ),
    );

    const running = await startBoardServer(paths, { port: 0, serveApp: false, experimental: true });
    server = running.server;
    base = running.url;
  });

  afterAll(() => {
    server.close();
  });

  it('reports what is missing around the one document that was pushed', async () => {
    // No credential, no network: coverage is the board and the link store.
    const report = await json<RemoteCoverageReport>(base, '/api/remotes/upstream/coverage');

    expect(report.remote).toEqual({ name: 'upstream', provider: 'github', target: 'acme/payments' });
    expect(report.mirrored).toBe(1);
    expect(Object.fromEntries(report.groups.map((group) => [group.relation, group.ids]))).toEqual({
      parent: ['LP-1', 'LP-2'],
      child: ['LP-4', 'LP-5'],
      period: ['TL-2'],
    });
    // Each gap says which mirrored document it is missing from.
    const sprint = report.gaps.find((gap) => gap.id === 'TL-2')!;
    expect(sprint.kind).toBe('period');
    expect(sprint.reasons).toEqual([{ relation: 'period', anchors: ['LP-3'], count: 1 }]);
    expect(report.filesPeriods).toBe(true);
  });

  it('refuses a remote nobody declared', async () => {
    const response = await fetch(`${base}/api/remotes/nope/coverage`);
    expect(response.status).toBe(400);
  });
});

/** The same remote, with an account mapping — this check is about assignees. */
const READINESS_REMOTES = REMOTES.replace(
  '      periods:',
  `      accounts:
        via: github
      periods:`,
);

describe('the readiness routes', () => {
  let paths: BoardPaths;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    paths = makeBoard('scrum', 'LP');
    // The shared fixture carries no `accounts` block; this check is about
    // assignees, so it needs one.
    writeFileSync(paths.configPath, readFileSync(paths.configPath, 'utf8') + READINESS_REMOTES);

    // One person with no GitHub handle, holding two stories: the ordinary
    // "this will file unassigned" case.
    mkdirSync(`${paths.teamDir}/RS-1`, { recursive: true });
    writeFileSync(
      `${paths.teamDir}/RS-1/_resource.md`,
      '---\nid: RS-1\ntype: person\ntitle: Ada Lovelace\n---\n\nBody.\n',
    );
    for (const id of ['LP-20', 'LP-21']) {
      mkdirSync(`${paths.boardDir}/${id}`, { recursive: true });
      writeFileSync(
        `${paths.boardDir}/${id}/_issue.md`,
        `---\nid: ${id}\ntype: user_story\ntitle: ${id}\nstatus: backlog\nassignee: RS-1\n---\n\nBody.\n`,
      );
    }

    const running = await startBoardServer(paths, { port: 0, serveApp: false, experimental: true });
    server = running.server;
    base = running.url;
  });

  afterAll(() => {
    server.close();
  });

  it('reports what will not land, without a credential to ask the remote with', async () => {
    const report = await json<RemoteReadinessReport>(
      base,
      '/api/remotes/upstream/readiness',
      post('/api/remotes/upstream/readiness', {}),
    );

    const finding = report.findings.find((entry) => entry.key === 'assignee:RS-1')!;
    expect(finding.code).toBe('assignee_no_account');
    expect(finding.count).toBe(2);
    expect(finding.documents).toEqual(['LP-20', 'LP-21']);
    // The remote could not be asked, and the report says so rather than
    // implying everything upstream checked out.
    expect(report.unreachable).toBeDefined();
    expect(report.askedUsers).toBe(false);
    expect(report.blocked).toBe(false);
  });

  it('applies a chosen fix through the engine, and the next check is clear', async () => {
    const result = await json<RemoteReadinessFixResultDto>(
      base,
      '/api/remotes/upstream/readiness/fix',
      post('/api/remotes/upstream/readiness/fix', {
        fixes: [{ kind: 'link_account', resourceId: 'RS-1', via: 'github', value: 'ada' }],
      }),
    );
    expect(result.changed).toEqual(['RS-1 github = ada']);

    // Written to the roster document, not held in the session.
    expect(readFileSync(`${paths.teamDir}/RS-1/_resource.md`, 'utf8')).toContain('github: ada');

    const report = await json<RemoteReadinessReport>(
      base,
      '/api/remotes/upstream/readiness',
      post('/api/remotes/upstream/readiness', {}),
    );
    expect(report.findings.find((entry) => entry.key === 'assignee:RS-1')).toBeUndefined();
  });

  it('narrows to the documents a push names', async () => {
    const report = await json<RemoteReadinessReport>(
      base,
      '/api/remotes/upstream/readiness',
      post('/api/remotes/upstream/readiness', { only: ['LP-21'] }),
    );
    expect(report.documents).toBe(1);
  });
});
