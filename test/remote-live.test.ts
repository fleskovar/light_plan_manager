/**
 * The live suite — the only tests in this repository that hold a real
 * credential and write to a real tracker.
 *
 * Everything else in `test/remote-*` runs against a fake: an in-memory
 * tracker, a stubbed `fetch`, a JSON file. That is the right default — it is
 * fast, offline and deterministic — but it shares one blind spot with the
 * capability matrix it was written from: a fake built from the same reading of
 * the platform's documentation as the adapter cannot disagree with the
 * adapter. `test/fixtures/remote/README.md` says so plainly: nothing in that
 * folder is a captured response, and the matrix quotes documentation rather
 * than observation. This file is the other half.
 *
 * ## What it runs
 *
 * One case folder — `test/cases/remote-round-trip/scoped-subtree/` — whose
 * `README.md` derives every expected value by hand from its `inputs/`. The
 * runner is deliberately thin: it builds the board the case describes, pushes
 * it, and checks the three claims the case states. All the *reasoning* lives
 * in the README, where a person can check it against the tracker's own UI.
 *
 * ## Offline and live are the same code path
 *
 * `jsonfile` runs on every `npm test` with no credential at all, so the
 * baseline is exercised continuously and a regression in the shared machinery
 * (the planners, the executor, the base snapshot, the link store) is red
 * before anybody reaches for a token. The three real providers run the same
 * assertions against their own platform when `LPM_LIVE=1` and their
 * credentials are present. That is the point of the arrangement: the fixture
 * proves the machinery every day, and the credential proves the platform.
 *
 *   LPM_LIVE=1                 opt in to the live half (skipped otherwise)
 *
 *   GITHUB_TOKEN               a token with write access to
 *   LPM_LIVE_GITHUB_REPO       a scratch `owner/repo`
 *
 *   JIRA_EMAIL                 the account email
 *   JIRA_API_TOKEN             an API token for it
 *   LPM_LIVE_JIRA_SITE         https://<you>.atlassian.net
 *   LPM_LIVE_JIRA_PROJECT      a scratch project key
 *
 *   LINEAR_API_KEY             a personal API key
 *   LPM_LIVE_LINEAR_TEAM       a scratch team key
 *
 * A provider with `LPM_LIVE=1` and *incomplete* credentials skips **loudly** —
 * the skip names the variables it wanted — because a live suite that goes
 * quiet when a token expires is worse than one that fails.
 *
 * ## It cleans up after itself
 *
 * Every document is filed with a run marker in its title and removed in a
 * `finally`, whatever the assertions did. A killed run leaves findable
 * leftovers: search the tracker for `lpm-uat`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createIssue,
  createPeriod,
  initBoard,
  linkIssue,
  loadBoard,
  updateNode,
  type BoardPaths,
  type LoadedBoard,
} from '../src/core/index.js';
import {
  buildConnector,
  computeRemoteStatus,
  loadLinkStore,
  openRemote,
  runSync,
} from '../src/remote/index.js';
import { registeredProviders } from '../src/remote/registry.js';
import { remoteStatusExitCode } from '../src/shared/index.js';

// ---------------------------------------------------------------------------
// The case folder
// ---------------------------------------------------------------------------

const CASE_DIR = fileURLToPath(
  new URL('./cases/remote-round-trip/scoped-subtree/', import.meta.url),
);

/** One issue as the case states it — titles, never ids. */
interface CaseIssue {
  type: string;
  title: string;
  parent?: string;
  body: string;
  status: string;
  period?: string;
  depends_on?: string[];
  attributes?: Record<string, unknown>;
}

interface CaseInputs {
  periods: Array<{ type: string; title: string; starts: string; ends: string }>;
  issues: CaseIssue[];
}

/** One document as the baseline states it — again by title, never by id. */
interface RecoveredDocument {
  title: string;
  type: string;
  status: string;
  parent: string | null;
  depends_on: string[];
  attributes: Record<string, unknown>;
  period: string | null;
}

function readCase<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(path.join(CASE_DIR, ...segments), 'utf8')) as T;
}

const inputs = readCase<CaseInputs>('inputs', 'documents.json');
const recovered = readCase<{ documents: RecoveredDocument[] }>('outputs', 'recovered.json');
const secondSync = readCase<{
  pushPlanOperations: number;
  pullPlanOperations: number;
  statusExitCode: number;
}>('outputs', 'second-sync.json');
const CONFIG_TEMPLATE = path.join(CASE_DIR, 'inputs', 'config.yml');

/**
 * Providers whose scheduling does not survive the round trip yet, with the bug
 * that tracks it. Mirrors `SCHEDULING_GAPS` in `test/remote-roundtrip.test.ts`
 * and is the same rule: this is a record of what never worked, not a licence
 * to silence a provider that stops working.
 */
const SCHEDULING_GAPS = new Map<string, string>([['jsonfile', 'LP-533']]);

// ---------------------------------------------------------------------------
// Credentials: which providers this machine can actually run
// ---------------------------------------------------------------------------

/** What one provider needs from the environment to be run live. */
interface LiveTarget {
  /** Env vars that must all be set, named in the skip message when they are not. */
  requires: readonly string[];
  /** The `connection` block, read from the environment. */
  connection: () => Record<string, unknown>;
  /** The provider's own spelling of the case mapping. */
  mapping: Record<string, unknown>;
}

const TYPES_NATIVE = {
  program: { type: 'program', labels: ['program'] },
  epic: { type: 'epic', labels: ['epic'] },
  feature: { type: 'feature', labels: ['feature'] },
  user_story: { type: 'story', labels: ['story'] },
};

const TYPES_LABELS = {
  program: { remote: 'program' },
  epic: { remote: 'epic' },
  feature: { remote: 'feature' },
  user_story: { remote: 'story' },
};

const STATUSES = {
  backlog: { remote: ['Backlog'], closed: false },
  in_progress: { remote: ['In Progress'], closed: false },
  done: { remote: ['Done'], closed: true },
};

const ATTRIBUTES = { story_points: 'Points' };

/**
 * The table. One entry per registered provider — and the completeness guard
 * below is what keeps it honest: a fifth provider fails the suite until
 * somebody says how to reach it, rather than being quietly untested. That is
 * the gap that let LP-530/531/532 ship, three defects in the one provider the
 * per-provider tables kept forgetting.
 */
const targets: Record<string, LiveTarget> = {
  jsonfile: {
    // The offline provider: no credential, so nothing is required and the
    // `connection` is filled in per run with the board's own temp directory.
    requires: [],
    connection: () => ({ file: '' }),
    mapping: { types: TYPES_NATIVE, statuses: STATUSES, attributes: ATTRIBUTES },
  },
  github: {
    requires: ['GITHUB_TOKEN', 'LPM_LIVE_GITHUB_REPO'],
    connection: () => ({ repo: process.env.LPM_LIVE_GITHUB_REPO }),
    mapping: {
      types: TYPES_LABELS,
      statuses: STATUSES,
      attributes: ATTRIBUTES,
      periods: { container: 'sprint', carrier: 'milestones' },
    },
  },
  jira: {
    requires: ['JIRA_EMAIL', 'JIRA_API_TOKEN', 'LPM_LIVE_JIRA_SITE', 'LPM_LIVE_JIRA_PROJECT'],
    connection: () => ({
      site: process.env.LPM_LIVE_JIRA_SITE,
      project: process.env.LPM_LIVE_JIRA_PROJECT,
    }),
    mapping: {
      types: TYPES_LABELS,
      statuses: STATUSES,
      attributes: ATTRIBUTES,
      periods: { container: 'sprint', carrier: 'sprint' },
    },
  },
  linear: {
    requires: ['LINEAR_API_KEY', 'LPM_LIVE_LINEAR_TEAM'],
    connection: () => ({ team: process.env.LPM_LIVE_LINEAR_TEAM }),
    mapping: {
      types: TYPES_LABELS,
      statuses: STATUSES,
      attributes: ATTRIBUTES,
      periods: { container: 'sprint', carrier: 'sprint' },
    },
  },
};

/** Env vars a target wants that this machine does not have. */
function missingCredentials(name: string): string[] {
  return targets[name]!.requires.filter((key) => (process.env[key] ?? '') === '');
}

// ---------------------------------------------------------------------------
// Building the board the case describes
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newBoard(): BoardPaths {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lpm-live-'));
  roots.push(root);
  return initBoard({ root, template: CONFIG_TEMPLATE, prefix: 'LP', git: false }).paths;
}

/**
 * Create the case's documents, in the order the case lists them, and return a
 * title → id map. Titles carry the run marker so a killed run's leftovers are
 * findable in the tracker, and so two runs against one scratch project never
 * collide.
 */
function buildBoard(paths: BoardPaths, marker: string): Map<string, string> {
  const ids = new Map<string, string>();

  for (const period of inputs.periods) {
    const created = createPeriod(loadBoard(paths), {
      type: period.type,
      title: `${period.title} ${marker}`,
      starts: period.starts,
      ends: period.ends,
    });
    ids.set(period.title, created.id);
  }

  for (const issue of inputs.issues) {
    const created = createIssue(loadBoard(paths), {
      type: issue.type,
      title: `${issue.title} ${marker}`,
      status: issue.status,
      ...(issue.parent !== undefined ? { parentId: ids.get(issue.parent)! } : {}),
      ...(issue.period !== undefined ? { period: ids.get(issue.period)! } : {}),
      ...(issue.attributes !== undefined ? { attributes: issue.attributes } : {}),
    });
    ids.set(issue.title, created.id);
    // The body is a separate write: `createIssue` takes the frontmatter, and
    // the body is what the brief renders into.
    const board = loadBoard(paths);
    updateNode(board, board.byId.get(created.id)!, { body: issue.body });
  }

  // Edges last: a link refuses an id the board does not have yet, and the
  // case's one edge points backwards at a story created before it.
  for (const issue of inputs.issues) {
    const dependencies = issue.depends_on ?? [];
    if (dependencies.length === 0) continue;
    const board = loadBoard(paths);
    linkIssue(board, board.byId.get(ids.get(issue.title)!)!, {
      dependsOn: dependencies.map((title) => ids.get(title)!),
    });
  }

  return ids;
}

/** Write the `remotes:` block for one provider onto a board's config. */
function declareRemote(
  paths: BoardPaths,
  provider: string,
  connection: Record<string, unknown>,
  scopeId: string | null,
): void {
  const block = {
    remotes: {
      live: {
        provider,
        ...(scopeId === null ? {} : { scope: scopeId }),
        direction: 'both',
        on_delete: 'unlink',
        conflict: 'manual',
        connection,
        mapping: targets[provider]!.mapping,
      },
    },
  };
  // Stringified with the same `yaml` package the config is read with, so the
  // block is appended in the file's own idiom rather than as a flow mapping a
  // block document cannot hold.
  const config = readFileSync(paths.configPath, 'utf8');
  writeFileSync(paths.configPath, `${config}\n${stringify(block)}`, 'utf8');
}

/** The board, as the recovered baseline describes documents: by title. */
function describeBoard(board: LoadedBoard, marker: string): RecoveredDocument[] {
  const titleOf = (id: string | null | undefined): string | null => {
    if (!id) return null;
    const node = board.byId.get(id) ?? board.periodsById.get(id);
    return node ? node.title.replace(` ${marker}`, '') : null;
  };

  return board.issues
    // Only this run's documents. A live scratch project may hold anything
    // else, and a comparison that swept those in would fail for a reason that
    // has nothing to do with the sync.
    .filter((issue) => issue.title.includes(marker))
    .map((issue) => ({
      title: issue.title.replace(` ${marker}`, ''),
      type: issue.type,
      status: issue.status,
      parent: titleOf(issue.parentId),
      depends_on: issue.depends_on
        .map((id) => titleOf(id))
        .filter((title): title is string => title !== null)
        .sort(),
      attributes: issue.attributes ?? {},
      period: titleOf(issue.period),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Drop the fields a provider is known not to recover, on both sides. */
function withoutGaps(documents: RecoveredDocument[], provider: string): unknown[] {
  if (!SCHEDULING_GAPS.has(provider)) return documents;
  return documents.map(({ period: _period, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const live = process.env.LPM_LIVE === '1';

describe('the live table covers every registered provider', () => {
  it('names a way to reach each one, so a new provider is not silently untested', () => {
    expect(Object.keys(targets).sort()).toEqual(registeredProviders());
  });
});

for (const provider of registeredProviders()) {
  const offline = targets[provider]!.requires.length === 0;
  const missing = missingCredentials(provider);

  // An offline provider always runs. A live one runs when it is opted into and
  // its credentials are all present; otherwise it skips with the reason in the
  // test name, so `--reporter=verbose` reads as a checklist rather than a
  // silence.
  const reason = offline
    ? ''
    : !live
      ? ' [skipped: set LPM_LIVE=1]'
      : missing.length > 0
        ? ` [skipped: set ${missing.join(', ')}]`
        : '';
  const run = offline || (live && missing.length === 0);

  describe.skipIf(!run)(`round trip: ${provider}${reason}`, () => {
    it(
      'pushes the case, reads it back with no drift, and the second sync plans nothing',
      async () => {
        const marker = `[lpm-uat ${Date.now()}]`;
        const paths = newBoard();
        const ids = buildBoard(paths, marker);
        const scopeId = ids.get('Payments')!;

        const connection = offline
          ? { file: path.join(paths.root, 'tracker.json') }
          : targets[provider]!.connection();
        declareRemote(paths, provider, connection, scopeId);

        const opened = openRemote(loadBoard(paths).config, 'live');
        const connector = buildConnector(opened, paths);

        let filed: string[] = [];
        try {
          // -- the first push --------------------------------------------------
          const pushed = await runSync(loadBoard(paths), opened, paths, {
            direction: 'push',
            yes: true,
          });
          expect(pushed.pushResult?.failed ?? [], 'every document landed').toEqual([]);
          expect(pushed.pushResult?.summary.created, 'one twin per document').toBe(
            inputs.issues.length,
          );

          filed = [...loadLinkStore(paths, 'live').links.values()].map((link) => link.remoteId);
          expect(filed.length).toBe(inputs.issues.length);

          // -- the board is unchanged by its own push --------------------------
          // A push writes to the remote and to `.lpm/remotes/`; it must never
          // rewrite a document. The recovered shape is the board's own, so a
          // push that edited a document shows up here first.
          expect(withoutGaps(describeBoard(loadBoard(paths), marker), provider)).toEqual(
            withoutGaps(recovered.documents, provider),
          );

          // -- the second sync is quiet ---------------------------------------
          const secondPush = await runSync(loadBoard(paths), opened, paths, {
            direction: 'push',
            dryRun: true,
          });
          expect(
            secondPush.pushPlan?.ops.length ?? 0,
            'a second push files nothing: the duplicate wave',
          ).toBe(secondSync.pushPlanOperations);

          const secondPull = await runSync(loadBoard(paths), opened, paths, {
            direction: 'pull',
            dryRun: true,
          });
          expect(
            secondPull.pullPlan?.changes.length ?? 0,
            'a pull straight after a push rewrites nothing: the phantom-edit loop',
          ).toBe(secondSync.pullPlanOperations);

          // -- the round trip: a fresh board pulls the same documents back ----
          // This is the claim the case exists for, and it is the only half
          // that can catch a *translation* defect: comparing the producer to
          // itself would pass however wrongly the document was written to the
          // remote, because the push never rewrites a document.
          const consumerPaths = newBoard();
          // The same timeline, so a period can be matched back by its title —
          // a pull recovers scheduling, it never invents a sprint.
          for (const period of inputs.periods) {
            createPeriod(loadBoard(consumerPaths), {
              type: period.type,
              title: `${period.title} ${marker}`,
              starts: period.starts,
              ends: period.ends,
            });
          }
          // No scope: the consumer has none of the documents yet, so there is
          // no local id to scope to. `describeBoard` keeps this run's marker.
          declareRemote(consumerPaths, provider, connection, null);
          const consumerRemote = openRemote(loadBoard(consumerPaths).config, 'live');
          // A complete listing is the default now, which is what a consumer
          // with none of the documents needs.
          const pulled = await runSync(loadBoard(consumerPaths), consumerRemote, consumerPaths, {
            direction: 'pull',
          });
          expect(pulled.pullResult?.failures ?? [], 'every document arrived').toEqual([]);
          expect(
            pulled.pullResult?.linked.length ?? 0,
            'one link per document the pull created',
          ).toBe(inputs.issues.length);

          expect(
            withoutGaps(describeBoard(loadBoard(consumerPaths), marker), provider),
            'the round trip: what came back is what went out',
          ).toEqual(withoutGaps(recovered.documents, provider));

          // -- and status agrees ----------------------------------------------
          const status = await computeRemoteStatus(loadBoard(paths), 'live');
          expect(status.ahead, 'nothing ahead').toEqual([]);
          expect(status.behind, 'nothing behind').toEqual([]);
          expect(status.conflicted, 'nothing conflicted').toEqual([]);
          expect(status.unlinked, 'nothing unlinked').toEqual([]);
          expect(
            remoteStatusExitCode(status),
            'the CI gate: exit 0 when the two sides agree',
          ).toBe(secondSync.statusExitCode);
        } finally {
          // Whatever the assertions did, take the issues back out. GitHub
          // closes rather than deletes — that is its documented degradation,
          // and it is what "clean up" means there.
          for (const remoteId of filed) {
            try {
              await connector.delete(remoteId);
            } catch {
              // A cleanup failure must never mask the assertion that ran
              // before it; the run marker is how a leftover is found.
            }
          }
        }
      },
      // A live provider is a real network round trip per document.
      offline ? 60_000 : 300_000,
    );
  });
}
