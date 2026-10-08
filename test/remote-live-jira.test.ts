/**
 * The Jira integration suite — end to end against a real Jira Cloud project.
 *
 * `test/remote-live.test.ts` is the *round trip*: one case, every provider,
 * "what went out is what came back". This file is the other kind of live test
 * — one provider, many scenarios, each asserting what **Jira itself** holds
 * after light-plan wrote to it. That distinction is the whole point. Every
 * defect this suite exists to catch was invisible to a fake, because the fake
 * was built from the same reading of Jira as the adapter:
 *
 *   - a created issue kept the workflow's first status, for ever, while the
 *     base recorded the status the board asked for (nothing ever disagreed);
 *   - `depends_on` reached Jira **backwards** — the dependent was recorded as
 *     blocking the dependency;
 *   - the link readers tested "is this end me?" against entries that name only
 *     the *other* end, so no dependency ever pulled back;
 *   - `unlink` matched on a pair of endpoints that no Jira record carries, so
 *     removing an edge locally silently left it in Jira;
 *   - Jira had no `parentIdOf` seam at all, so a pulled issue never landed
 *     under the twin of its Jira parent.
 *
 * Each of those passes an in-memory tracker and fails here.
 *
 * ## Running it
 *
 *   LPM_LIVE=1                 opt in to the live suite (skipped otherwise)
 *   JIRA_EMAIL                 the account email
 *   JIRA_API_TOKEN             an API token for it
 *   LPM_LIVE_JIRA_SITE         https://<you>.atlassian.net
 *   LPM_LIVE_JIRA_PROJECT      a **scratch** project key, and nothing else
 *
 * The project must already exist — this Jira instance does not expose project
 * templates over REST, so the suite cannot make one. Create a team-managed
 * ("next-gen") software project once through the Jira UI and point the
 * variable at it. A missing project **fails** rather than skipping, naming
 * what to create: a live suite that goes quiet when its target disappears is
 * worse than one that stops.
 *
 * ## It empties the project before it starts
 *
 * Not after. Cleaning up afterwards leaves a killed run's wreckage to poison
 * the next one, and "the assertions passed against whatever happened to be
 * lying around" is not a result. So `wipeProject` deletes every issue and
 * every sprint the project holds, and each scenario builds what it needs from
 * a board created in a fresh temp directory.
 *
 * **This is destructive, and the guard matters more than the wipe.** Two
 * things stand between it and somebody's real project: the project key has to
 * be named explicitly (there is no default), and a key that any board *in this
 * working tree* is mirroring is refused outright. That second rule is not
 * theoretical — this repository's own `.lpm` board mirrors a Jira project, and
 * one mistyped variable would have deleted it.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify, parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIssue,
  createPeriod,
  initBoard,
  linkIssue,
  loadBoard,
  moveNode,
  updateNode,
  type BoardPaths,
} from '../src/core/index.js';
import {
  buildConnector,
  loadLinkStore,
  openRemote,
  runSync,
  type OpenedRemote,
} from '../src/remote/index.js';
import { jiraDependsOnOf, jiraParentIdOf } from '../src/remote/providers/jira/index.js';

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------

const CASE_DIR = fileURLToPath(new URL('./cases/remote-live-jira/team-managed/', import.meta.url));

interface CaseIssue {
  type: string;
  title: string;
  parent?: string;
  body: string;
  status: string;
  period?: string;
  depends_on?: string[];
}

interface CaseInputs {
  periods: Array<{ type: string; title: string; starts: string; ends: string }>;
  issues: CaseIssue[];
}

const inputs = JSON.parse(
  readFileSync(path.join(CASE_DIR, 'inputs', 'documents.json'), 'utf8'),
) as CaseInputs;
const CONFIG_TEMPLATE = path.join(CASE_DIR, 'inputs', 'config.yml');

/**
 * The mapping, in a **team-managed** project's own vocabulary.
 *
 * Every board level above the work items becomes an `Epic`, because that is
 * the only container type such a project has; the leaf anchor is what then
 * decides which of those parent edges Jira can actually hold. No `attributes`
 * block: a scratch project has no custom fields, and this suite is about
 * structure, status and edges rather than field mapping.
 */
const MAPPING = {
  types: {
    program: { remote: 'Epic' },
    epic: { remote: 'Epic' },
    feature: { remote: 'Epic' },
    user_story: { remote: 'Story' },
    sub_task: { remote: 'Subtask' },
  },
  statuses: {
    backlog: { remote: ['To Do'], closed: false },
    in_progress: { remote: ['In Progress'], closed: false },
    done: { remote: ['Done'], closed: true },
  },
  periods: { container: 'sprint', carrier: 'sprint' },
};

// ---------------------------------------------------------------------------
// Reaching Jira directly
// ---------------------------------------------------------------------------

const SITE = (process.env.LPM_LIVE_JIRA_SITE ?? '').replace(/\/+$/, '');
const PROJECT = process.env.LPM_LIVE_JIRA_PROJECT ?? '';
const REQUIRED = ['JIRA_EMAIL', 'JIRA_API_TOKEN', 'LPM_LIVE_JIRA_SITE', 'LPM_LIVE_JIRA_PROJECT'];

function authHeader(): string {
  const pair = `${process.env.JIRA_EMAIL ?? ''}:${process.env.JIRA_API_TOKEN ?? ''}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

/**
 * A direct Jira call, deliberately **not** through the connector.
 *
 * An assertion that read Jira through the same adapter it is testing would
 * agree with the adapter by construction — which is exactly how a reversed
 * link direction stayed invisible: the writer and the reader shared one wrong
 * belief and round-tripped perfectly. Every check below reads the raw REST
 * payload instead.
 */
async function jira(method: string, endpoint: string, body?: unknown): Promise<any> {
  const response = await fetch(`${SITE}${endpoint}`, {
    method,
    headers: {
      authorization: authHeader(),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const payload: unknown = text === '' ? null : JSON.parse(text);
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

/** Every issue in the scratch project, paged to the end. */
async function allIssues(fields: string[] = ['summary']): Promise<any[]> {
  const issues: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await jira('POST', '/rest/api/3/search/jql', {
      jql: `project = ${PROJECT}`,
      maxResults: 100,
      fields,
      ...(cursor === undefined ? {} : { nextPageToken: cursor }),
    });
    issues.push(...(page.issues ?? []));
    cursor = page.nextPageToken;
  } while (cursor !== undefined);
  return issues;
}

/** One issue, read whole. */
const issue = (key: string): Promise<any> => jira('GET', `/rest/api/3/issue/${key}`);

/**
 * Every issue in the project, once the search index agrees there are `expected`
 * of them.
 *
 * Jira's JQL search is an **index**, and it lags the writes that feed it: an
 * issue created a second ago is readable by key and still missing from a
 * search. Asserting a count straight after a push is therefore a race, and one
 * that fails intermittently — the worst kind of live test, because the honest
 * reading of a red run is "something is wrong" and the true reading is "ask
 * again in a moment". Reads by key (`issue`) need none of this; only counting
 * does.
 */
async function issuesWhenIndexed(expected: number, timeoutMs = 30_000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  let latest = await allIssues();
  while (latest.length !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    latest = await allIssues();
  }
  return latest;
}

/** The scratch project's Agile board, which is where its sprints live. */
async function boardId(): Promise<number | undefined> {
  const boards = await jira('GET', `/rest/agile/1.0/board?projectKeyOrId=${PROJECT}`);
  const first = (boards.values ?? [])[0];
  return first === undefined ? undefined : (first.id as number);
}

// ---------------------------------------------------------------------------
// The guard, and the wipe
// ---------------------------------------------------------------------------

/**
 * Jira project keys any board in this working tree mirrors.
 *
 * The wipe below is indiscriminate by design, so the one thing it must never
 * be pointed at is a project somebody is actually using. This repository's own
 * `.lpm/config.yml` declares a Jira remote; if `LPM_LIVE_JIRA_PROJECT` names
 * that project, the suite refuses rather than emptying a real mirror over a
 * typo.
 */
function mirroredProjectKeys(): string[] {
  const configPath = fileURLToPath(new URL('../.lpm/config.yml', import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return []; // no board here — nothing to protect
  }
  const config = parseYaml(raw) as { remotes?: Record<string, any> } | null;
  const remotes = config?.remotes ?? {};
  return Object.values(remotes)
    .filter((remote) => remote?.provider === 'jira')
    .map((remote) => String(remote?.connection?.project ?? ''))
    .filter((key) => key !== '');
}

/**
 * Why this project may not be emptied, or `undefined` when it may.
 *
 * Pure, and separated from the run for one reason: it is the rail the whole
 * file rests on, so it is tested **offline**, on every `npm test`, rather than
 * only on the runs that hold a credential. A guard that is exercised only when
 * it is about to be needed is not a guard.
 */
export function scratchProjectProblem(
  projectKey: string,
  protectedKeys: readonly string[],
  allowMirrored = false,
): string | undefined {
  if (projectKey === '') {
    return 'LPM_LIVE_JIRA_PROJECT is not set, and this suite has no default: it empties the project it is given.';
  }
  // The deliberate escape hatch, off unless somebody sets it by hand. The rail
  // exists to stop an *accident* — a mistyped key emptying a real mirror — not
  // to stop a considered decision to run against a project whose contents the
  // owner is willing to re-push. It is a separate variable from the project
  // key precisely so that a typo can never satisfy both.
  if (allowMirrored) return undefined;
  if (protectedKeys.includes(projectKey)) {
    return (
      `LPM_LIVE_JIRA_PROJECT is "${projectKey}", which a board in this working tree ` +
      `mirrors (.lpm/config.yml). This suite empties the project it is given. ` +
      `Point it at a scratch project instead.`
    );
  }
  return undefined;
}

/** Throw unless the configured project is safe to empty. */
function assertScratchProject(): void {
  const problem = scratchProjectProblem(
    PROJECT,
    mirroredProjectKeys(),
    process.env.LPM_LIVE_JIRA_ALLOW_MIRRORED === '1',
  );
  if (problem !== undefined) throw new Error(`Refusing to run: ${problem}`);
}

/**
 * Empty the scratch project: every issue, then every sprint.
 *
 * Issues are deleted with `deleteSubtasks=true` and the failures are retried
 * once, because a parent whose children are deleted in the same pass can be
 * refused on the first attempt and succeed on the second. A second failure is
 * fatal — a wipe that half-worked leaves the run asserting against debris.
 */
async function wipeProject(): Promise<void> {
  const existing = await allIssues();
  const failed: string[] = [];
  for (const target of existing) {
    try {
      await jira('DELETE', `/rest/api/3/issue/${target.key}?deleteSubtasks=true`);
    } catch {
      failed.push(target.key);
    }
  }
  for (const key of failed) {
    await jira('DELETE', `/rest/api/3/issue/${key}?deleteSubtasks=true`);
  }

  const board = await boardId();
  if (board !== undefined) {
    const sprints = await jira('GET', `/rest/agile/1.0/board/${board}/sprint?maxResults=100`);
    for (const sprint of sprints.values ?? []) {
      await jira('DELETE', `/rest/agile/1.0/sprint/${sprint.id}`);
    }
  }

  const left = await issuesWhenIndexed(0);
  if (left.length > 0) {
    throw new Error(`the wipe left ${left.length} issues in ${PROJECT}`);
  }
}

// ---------------------------------------------------------------------------
// The mock board
// ---------------------------------------------------------------------------

const roots: string[] = [];

/** A fresh board in a temp directory, built from the case's config. */
function newBoard(): BoardPaths {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lpm-jira-it-'));
  roots.push(root);
  return initBoard({ root, template: CONFIG_TEMPLATE, prefix: 'LP', git: false }).paths;
}

/** Write the `remotes:` block onto a board, pointing at the scratch project. */
function declareRemote(paths: BoardPaths, board: number | undefined): void {
  const block = {
    remotes: {
      jira: {
        provider: 'jira',
        direction: 'both',
        on_delete: 'unlink',
        conflict: 'manual',
        connection: {
          site: SITE,
          project: PROJECT,
          ...(board === undefined ? {} : { board }),
        },
        mapping: MAPPING,
      },
    },
  };
  const config = readFileSync(paths.configPath, 'utf8');
  writeFileSync(paths.configPath, `${config}\n${stringify(block)}`, 'utf8');
}

/** Create the case's documents and return a title → local id map. */
function buildBoard(paths: BoardPaths): Map<string, string> {
  const ids = new Map<string, string>();

  for (const period of inputs.periods) {
    const created = createPeriod(loadBoard(paths), {
      type: period.type,
      title: period.title,
      starts: period.starts,
      ends: period.ends,
    });
    ids.set(period.title, created.id);
  }

  for (const document of inputs.issues) {
    const created = createIssue(loadBoard(paths), {
      type: document.type,
      title: document.title,
      status: document.status,
      ...(document.parent !== undefined ? { parentId: ids.get(document.parent)! } : {}),
      ...(document.period !== undefined ? { period: ids.get(document.period)! } : {}),
    });
    ids.set(document.title, created.id);
    const board = loadBoard(paths);
    updateNode(board, board.byId.get(created.id)!, { body: document.body });
  }

  // Edges last: a link refuses an id the board does not hold yet.
  for (const document of inputs.issues) {
    const dependencies = document.depends_on ?? [];
    if (dependencies.length === 0) continue;
    const board = loadBoard(paths);
    linkIssue(board, board.byId.get(ids.get(document.title)!)!, {
      dependsOn: dependencies.map((title) => ids.get(title)!),
    });
  }

  return ids;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const missing = REQUIRED.filter((key) => (process.env[key] ?? '') === '');
const live = process.env.LPM_LIVE === '1';
const reason = !live
  ? ' [skipped: set LPM_LIVE=1]'
  : missing.length > 0
    ? ` [skipped: set ${missing.join(', ')}]`
    : '';

describe.skipIf(!live || missing.length > 0)(`jira integration${reason}`, () => {
  let paths: BoardPaths;
  let ids: Map<string, string>;
  let remote: OpenedRemote;
  /** local id → the Jira key it was filed as. */
  const keys = new Map<string, string>();
  const keyOf = (title: string): string => keys.get(ids.get(title)!)!;

  beforeAll(async () => {
    assertScratchProject();

    // The project has to exist, and be the *right kind*. Both are checked
    // loudly rather than skipped: a live suite that goes quiet when its target
    // is missing or misconfigured is worse than one that stops.
    let project: any;
    try {
      project = await jira('GET', `/rest/api/3/project/${PROJECT}?expand=issueTypes`);
    } catch (error) {
      throw new Error(
        `Jira project "${PROJECT}" was not found at ${SITE}. Create a team-managed ` +
          `("next-gen") software project with that key once, through the Jira UI, ` +
          `and re-run. This instance does not expose project templates over REST, ` +
          `so the suite cannot create it. (${String(error)})`,
      );
    }

    // A company-managed project would pass most of this file and prove the
    // wrong thing: the leaf anchor exists because a *team-managed* project has
    // exactly two native parent levels, and that is the configuration whose
    // edges went out backwards and whose statuses never transitioned.
    if (project.style !== 'next-gen') {
      throw new Error(
        `Jira project "${PROJECT}" is ${project.style}, not team-managed. This suite ` +
          `asserts team-managed behaviour (Epic > standard > Subtask, and the leaf ` +
          `anchor that follows from it). Point it at a team-managed project.`,
      );
    }

    const typeNames = new Set<string>((project.issueTypes ?? []).map((type: any) => type.name));
    const needed = ['Epic', 'Story', 'Subtask'];
    const absent = needed.filter((name) => !typeNames.has(name));
    if (absent.length > 0) {
      throw new Error(
        `Jira project "${PROJECT}" has no issue type ${absent.join(', ')}. ` +
          `It offers: ${[...typeNames].sort().join(', ')}.`,
      );
    }

    if ((await boardId()) === undefined) {
      throw new Error(
        `Jira project "${PROJECT}" has no Agile board, so it can hold no sprints. ` +
          `A team-managed software project with the board feature enabled has one.`,
      );
    }

    await wipeProject();

    paths = newBoard();
    ids = buildBoard(paths);
    declareRemote(paths, await boardId());
    remote = openRemote(loadBoard(paths).config, 'jira');

    // The whole board in one push: `--all`, with the timeline, so the sprint
    // is filed too.
    const pushed = await runSync(loadBoard(paths), remote, paths, {
      direction: 'push',
      periods: 'all',
      yes: true,
    });
    expect(pushed.pushResult?.failed ?? [], 'the first push files everything').toEqual([]);

    for (const [localId, link] of loadLinkStore(paths, 'jira').links) {
      keys.set(localId, link.remoteKey);
    }
  }, 600_000);

  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('files one Jira issue per board document, and nothing else', async () => {
    expect(keys.size, 'one link entry per document').toBe(inputs.issues.length);
    const filed = await issuesWhenIndexed(inputs.issues.length);
    expect(filed.length, 'the project holds exactly the board').toBe(inputs.issues.length);
  });

  it('maps every board type onto the project’s own issue types', async () => {
    const typeOf = async (title: string): Promise<string> =>
      (await issue(keyOf(title))).fields.issuetype.name;

    // Every level above the work items is an Epic: that is the only container
    // a team-managed project has.
    expect(await typeOf('Payments')).toBe('Epic');
    expect(await typeOf('Card payments')).toBe('Epic');
    expect(await typeOf('Refunds')).toBe('Epic');
    expect(await typeOf('Refund a captured charge')).toBe('Story');
    expect(await typeOf('Write the refund ledger entry')).toBe('Subtask');
  });

  it('lands a finished document in its finished status, on the create itself', async () => {
    // The regression that cost a whole board its statuses. Jira cannot set a
    // status on `POST /issue`, so a create has to transition; without that the
    // issue sits in "To Do" for ever *and nothing reports it*, because the
    // base takes the echo, "To Do" maps back to more than one board status,
    // and the ambiguous read leaves the local value standing.
    const done = await issue(keyOf('Refund a voided charge'));
    expect(done.fields.status.name).toBe('Done');

    const active = await issue(keyOf('Refunds'));
    expect(active.fields.status.name).toBe('In Progress');

    const open = await issue(keyOf('Card payments'));
    expect(open.fields.status.name).toBe('To Do');
  });

  it('spends Jira’s native parent edge on the deepest levels and blocks the rest', async () => {
    // Jira is leaf-anchored: with two native parent levels on a five-level
    // board, depths 3 and 4 nest natively and 1 and 2 ride the managed block.
    // Anchored at the root instead, every native edge light-plan wrote was one
    // Jira refuses (an Epic cannot sit under an Epic) and the filed board came
    // out flat.
    const story = await issue(keyOf('Refund a captured charge'));
    expect(story.fields.parent?.key, 'a story nests natively under its feature').toBe(
      keyOf('Refunds'),
    );

    const subTask = await issue(keyOf('Write the refund ledger entry'));
    expect(subTask.fields.parent?.key, 'a sub-task nests natively under its story').toBe(
      keyOf('Refund a captured charge'),
    );

    const feature = await issue(keyOf('Refunds'));
    expect(feature.fields.parent, 'a feature has no native parent Jira would accept').toBeUndefined();
    expect(
      jiraParentIdOf(feature),
      'and carries it in the managed block instead',
    ).toBe((await issue(keyOf('Card payments'))).id);

    const root = await issue(keyOf('Payments'));
    expect(root.fields.parent, 'the scope root has no parent at all').toBeUndefined();
    expect(jiraParentIdOf(root), 'and none in the block either').toBeUndefined();
  });

  it('writes depends_on as a Blocks link pointing the way the board means it', async () => {
    // `A depends_on B` means B blocks A. Reversed, this is completely silent:
    // both sides link, the push reports success, and the plan reads as its own
    // mirror image to anybody working in Jira.
    const dependent = keyOf('Refund a captured charge');
    const dependency = keyOf('Refund a voided charge');

    const record = await issue(dependent);
    const blocks = (record.fields.issuelinks ?? []).filter(
      (link: any) => link.type.name === 'Blocks',
    );
    expect(blocks, 'one Blocks link on the dependent').toHaveLength(1);

    // Read from the dependent, the blocker is the `inwardIssue`: "this issue
    // is blocked by that one".
    expect(blocks[0].inwardIssue?.key, 'the dependency is what blocks').toBe(dependency);
    expect(blocks[0].outwardIssue, 'the dependent does not block its dependency').toBeUndefined();

    // And the other end agrees, which is the half that makes it unambiguous.
    const other = await issue(dependency);
    const reverse = (other.fields.issuelinks ?? []).filter(
      (link: any) => link.type.name === 'Blocks',
    );
    expect(reverse[0].outwardIssue?.key).toBe(dependent);
  });

  it('reads that edge back out of the live record', async () => {
    // The pull-side seam, against a real payload. It used to test whether the
    // record was one end of the link — but a Jira `issuelinks` entry names
    // only the *other* end, so it matched nothing and no dependency ever came
    // back from Jira.
    const record = await issue(keyOf('Refund a captured charge'));
    expect(jiraDependsOnOf(record)).toEqual([(await issue(keyOf('Refund a voided charge'))).id]);

    // And the reverse end reports nothing: it is the same edge, not a second.
    const blocker = await issue(keyOf('Refund a voided charge'));
    expect(jiraDependsOnOf(blocker)).toEqual([]);
  });

  it('schedules the story into the sprint the period pushed', async () => {
    const record = await issue(keyOf('Refund a captured charge'));
    const sprints = Object.entries(record.fields)
      .filter(([key, value]) => key.startsWith('customfield_') && Array.isArray(value))
      .flatMap(([, value]) => value as any[])
      .filter((entry) => entry !== null && typeof entry === 'object' && 'boardId' in entry);
    expect(sprints.map((sprint) => sprint.name)).toContain('Sprint A');
  });

  it('plans nothing on a second push: the duplicate wave, and the phantom-change loop', async () => {
    const again = await runSync(loadBoard(paths), remote, paths, {
      direction: 'push',
      dryRun: true,
    });
    expect(again.pushPlan?.ops ?? [], 'a settled board pushes nothing').toEqual([]);
  });

  it('carries a local edit to Jira: title, status and parent', async () => {
    const localId = ids.get('Refund a captured charge')!;
    const key = keyOf('Refund a captured charge');

    updateNode(loadBoard(paths), loadBoard(paths).byId.get(localId)!, {
      title: 'Refund a captured charge, in full or in part',
    });
    moveNode(loadBoard(paths), loadBoard(paths).byId.get(localId)!, {
      status: 'done',
      rollUp: false,
    });
    moveNode(loadBoard(paths), loadBoard(paths).byId.get(localId)!, {
      parentId: ids.get('Chargebacks')!,
    });

    const pushed = await runSync(loadBoard(paths), remote, paths, {
      direction: 'push',
      only: [localId],
      yes: true,
    });
    expect(pushed.pushResult?.failed ?? []).toEqual([]);

    const record = await issue(key);
    expect(record.fields.summary).toBe('Refund a captured charge, in full or in part');
    expect(record.fields.status.name, 'a terminal status closes the twin').toBe('Done');
    expect(record.fields.parent?.key, 'the reparent moved it in Jira too').toBe(
      keyOf('Chargebacks'),
    );
  });

  it('brings a Jira edit back to the board', async () => {
    const key = keyOf('Card payments');
    await jira('PUT', `/rest/api/3/issue/${key}`, {
      fields: { summary: 'Card payments, edited in Jira' },
    });

    await runSync(loadBoard(paths), remote, paths, { direction: 'pull', yes: true });

    const board = loadBoard(paths);
    expect(board.byId.get(ids.get('Card payments')!)!.title).toBe('Card payments, edited in Jira');
  });

  it('files an issue created in Jira under the twin of its Jira parent', async () => {
    // Without a `parentIdOf` seam this refused outright, asking for a
    // `--parent` when light-plan was already mirroring the parent it needed.
    const created = await jira('POST', '/rest/api/3/issue', {
      fields: {
        project: { key: PROJECT },
        summary: 'Written in Jira, pulled to the board',
        issuetype: { name: 'Story' },
        parent: { key: keyOf('Refunds') },
      },
    });

    const pulled = await runSync(loadBoard(paths), remote, paths, {
      direction: 'pull',
      pullIds: [created.key],
      yes: true,
    });
    expect(pulled.pullResult?.failures ?? []).toEqual([]);

    const board = loadBoard(paths);
    const arrived = board.issues.find(
      (document) => document.title === 'Written in Jira, pulled to the board',
    );
    expect(arrived, 'the issue reached the board').toBeDefined();
    expect(arrived!.parentId, 'under the twin of its Jira parent').toBe(ids.get('Refunds'));
  });

  it('removes a Jira link when the dependency is removed on the board', async () => {
    // `unlink` used to match on a pair of endpoints no Jira record carries, so
    // it found nothing, deleted nothing, and reported success.
    const localId = ids.get('Refund a captured charge')!;
    const board = loadBoard(paths);
    linkIssue(board, board.byId.get(localId)!, {
      dependsOn: [ids.get('Refund a voided charge')!],
      remove: true,
    });

    const pushed = await runSync(loadBoard(paths), remote, paths, {
      direction: 'push',
      only: [localId],
      yes: true,
    });
    expect(pushed.pushResult?.failed ?? []).toEqual([]);

    const record = await issue(keyOf('Refund a captured charge'));
    const blocks = (record.fields.issuelinks ?? []).filter(
      (link: any) => link.type.name === 'Blocks',
    );
    expect(blocks, 'the Blocks link is gone from Jira').toEqual([]);
  });

  it('applies on_delete when an issue is deleted in Jira', async () => {
    const localId = ids.get('Write the refund ledger entry')!;
    await jira('DELETE', `/rest/api/3/issue/${keyOf('Write the refund ledger entry')}`);

    // A complete listing, so absence is evidence: a targeted pull is partial
    // and deliberately infers no deletion from it.
    await runSync(loadBoard(paths), remote, paths, { direction: 'pull', yes: true });

    expect(
      loadLinkStore(paths, 'jira').links.has(localId),
      'the policy is unlink: the twin is forgotten, the document stays',
    ).toBe(false);
    expect(loadBoard(paths).byId.get(localId), 'the board document survives').toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The safety rail, checked without a credential
// ---------------------------------------------------------------------------

describe('the wipe guard', () => {
  it('refuses a project a board in this working tree mirrors', () => {
    // The accident this exists to prevent: one mistyped variable emptying the
    // Jira project somebody's real board is mirrored onto.
    expect(scratchProjectProblem('SCRUM', ['SCRUM'])).toMatch(/mirrors/);
    expect(scratchProjectProblem('SCRUM', ['SCRUM'])).toMatch(/scratch project/);
  });

  it('refuses an unset project rather than defaulting to one', () => {
    expect(scratchProjectProblem('', [])).toMatch(/not set/);
  });

  it('allows a key no board here mirrors', () => {
    expect(scratchProjectProblem('LPMIT', ['SCRUM'])).toBeUndefined();
    expect(scratchProjectProblem('LPMIT', [])).toBeUndefined();
  });

  it('lets a deliberate override through, and only a deliberate one', () => {
    // Opt-in, and a separate variable from the project key, so no single typo
    // can both name a protected project and unlock it.
    expect(scratchProjectProblem('SCRUM', ['SCRUM'], true)).toBeUndefined();
    expect(scratchProjectProblem('SCRUM', ['SCRUM'], false)).toMatch(/mirrors/);
    // It does not excuse an unset key: there is still nothing to empty.
    expect(scratchProjectProblem('', ['SCRUM'], true)).toMatch(/not set/);
  });

  it('reads the protected keys out of this repository’s own board', () => {
    // Not a fixture: the real config, so the rail cannot drift away from the
    // board it is protecting. Asserted against the file rather than against a
    // hard-coded key, so it neither goes vacuous if the parse breaks nor
    // breaks if somebody renames the remote.
    const keys = mirroredProjectKeys();
    for (const key of keys) expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);

    // A fresh clone has no board: there is nothing to protect, so nothing may
    // be reported as protected either.
    const configPath = fileURLToPath(new URL('../.lpm/config.yml', import.meta.url));
    if (!existsSync(configPath)) {
      expect(keys).toEqual([]);
      return;
    }
    const raw = readFileSync(configPath, 'utf8');
    if (/provider:\s*jira/.test(raw)) {
      expect(keys.length, 'this board declares a Jira remote, so it must be protected').toBeGreaterThan(0);
    }
  });
});
