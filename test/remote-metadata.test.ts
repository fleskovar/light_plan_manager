import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createIssue, createResource } from '../src/core/index.js';
import type { BoardPaths } from '../src/core/storage/paths.js';
import { ASSIGNEE_FIELD, poolLabel, type Roster } from '../src/remote/accounts.js';
import { executePush } from '../src/remote/execute.js';
import type { LinkStore } from '../src/remote/links.js';
import { parseManagedBlock, renderManagedBlock } from '../src/remote/managed-block.js';
import { degradedPeriodField } from '../src/remote/periods.js';
import type { PeriodIndex } from '../src/remote/periods.js';
import type {
  AttributeDefs,
  Connector,
  Provider,
  RemoteRecord,
  RemoteRequest,
} from '../src/remote/provider.js';
import { githubProvider } from '../src/remote/providers/github/index.js';
import { jiraProvider } from '../src/remote/providers/jira/index.js';
import { linearProvider } from '../src/remote/providers/linear/index.js';
import { openRemote, type OpenedRemote } from '../src/remote/remotes.js';
import { adfToMarkdown, markdownToAdf } from '../src/shared/adf.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';
import { loadConfig } from '../src/core/index.js';

afterAll(cleanupBoards);

/**
 * **What the tracker cannot hold, the body carries.**
 *
 * The rule this suite exists for: a board pushed to a tracker and pulled down
 * into a *different* board must arrive whole. Every tracker drops something —
 * no platform can assign an issue to a pool, none has more than a couple of
 * native hierarchy levels, Jira has one sprint and no notion of the increment
 * above it — and the answer is always the same, rung 4 of the degradation
 * ladder: the value rides the managed block in the issue body, where the next
 * pull reads it back. A field that is neither native nor in the block is not
 * degraded, it is **lost**.
 *
 * It was lost, for two fields and for real. Jira's translator parsed the block
 * on the way *out* and never on the way back, so every degraded period level it
 * wrote was written into the local body as markdown and discarded as data. And
 * no provider carried an assignee it could not write: GitHub and Linear encoded
 * a pool as a `pool:` label and Jira encoded it as nothing at all, so a board
 * assigning work to roles came back from Jira with an empty roster.
 *
 * The suite is deliberately about the *recovery*, not about one provider's wire
 * format: each entry says how its platform stores a body, and the assertions
 * name only board vocabulary.
 */

const ATTRIBUTES: AttributeDefs = {
  story_points: { type: 'int' },
};

/** A person with no account anywhere, and a pool. Neither can be assigned natively. */
const ROSTER: Roster = new Map([
  ['RS-1', { id: 'RS-1', title: 'Ada', generic: false, attributes: { email: 'ada@example.com' } }],
  ['RS-2', { id: 'RS-2', title: 'Nobody', generic: false, attributes: { email: null } }],
  ['RS-3', { id: 'RS-3', title: 'Backend', generic: true, attributes: {} }],
]);

/** increment › sprint: only the sprint has a native container anywhere. */
const PERIODS: PeriodIndex = new Map([
  ['TL-1', { id: 'TL-1', title: 'PI-1', type: 'increment', parentId: null, starts: '2026-01-01', ends: '2026-03-31' }],
  ['TL-2', { id: 'TL-2', title: 'Sprint 1', type: 'sprint', parentId: 'TL-1', starts: '2026-01-01', ends: '2026-01-14' }],
]);

const TYPES = { user_story: { remote: 'story' } };
const STATUSES = {
  backlog: { remote: ['Backlog'], closed: false },
  in_progress: { remote: ['In Progress'], closed: false },
};

interface Entry {
  name: string;
  provider: Provider;
  mapping: Record<string, unknown>;
  /** A remote record whose body holds `body` — the platform's own shape. */
  recordWithBody(body: string): RemoteRecord;
}

const entries: Entry[] = [
  {
    name: 'github',
    provider: githubProvider,
    mapping: {
      types: TYPES,
      statuses: STATUSES,
      attributes: { story_points: 'Pts' },
      accounts: { via: 'email' },
      periods: { container: 'sprint', carrier: 'milestones' },
    },
    recordWithBody: (body) => ({
      number: 7,
      title: 'Work',
      body,
      state: 'open',
      labels: [],
      assignee: null,
      milestone: null,
    }),
  },
  {
    name: 'linear',
    provider: linearProvider,
    mapping: {
      types: TYPES,
      statuses: STATUSES,
      attributes: { story_points: 'Pts' },
      accounts: { via: 'email' },
      periods: { container: 'sprint', carrier: 'sprint' },
    },
    recordWithBody: (body) => ({
      id: '7',
      identifier: 'ENG-7',
      title: 'Work',
      description: body,
      state: { name: 'Backlog' },
      labels: [],
      assignee: null,
      cycle: null,
    }),
  },
  {
    name: 'jira',
    provider: jiraProvider,
    mapping: {
      types: TYPES,
      statuses: STATUSES,
      attributes: { story_points: 'customfield_10016' },
      accounts: { via: 'email' },
      periods: { container: 'sprint', carrier: 'sprint' },
    },
    // Jira stores the description as ADF, so the body goes through the real
    // converter — the block has to survive that round trip too, and this is the
    // code the connector uses at the wire.
    recordWithBody: (body) => ({
      id: '7',
      key: 'PAY-7',
      fields: {
        summary: 'Work',
        description: markdownToAdf(body),
        issuetype: { name: 'story', subtask: false },
        status: { name: 'Backlog' },
        assignee: null,
      },
    }),
  },
];

/** Recover the board fields a provider reads out of a body. */
function pullBody(entry: Entry, body: string) {
  return entry.provider.translator.fieldsFromRecord(
    entry.recordWithBody(body),
    entry.mapping,
    ATTRIBUTES,
    ROSTER,
    PERIODS,
  );
}

for (const entry of entries) {
  describe(`${entry.name}: the body carries what the tracker cannot`, () => {
    it('recovers a pool assignment from the block', () => {
      // No tracker can assign an issue to a pool — the assignee field is a
      // single user account on all three — so the board's resource id rides the
      // block and comes back as that resource.
      const body = `Prose.\n\n${renderManagedBlock([
        { name: ASSIGNEE_FIELD, kind: 'id', value: 'RS-3' },
      ])}`;

      const { patch } = pullBody(entry, body);

      expect(patch.assignee).toBe('RS-3');
    });

    it('recovers a person the tracker has no account for', () => {
      // The other half of the same problem: a real person who simply has no
      // account on this tracker. Nothing native can hold that either.
      const body = `Prose.\n\n${renderManagedBlock([
        { name: ASSIGNEE_FIELD, kind: 'id', value: 'RS-2' },
      ])}`;

      const { patch } = pullBody(entry, body);

      expect(patch.assignee).toBe('RS-2');
    });

    it('recovers a block assignee written as a link', () => {
      // An `id` entry renders as `[RS-3](url)` when the writer knew the twin's
      // URL, and the reader has to unwrap it or the whole encoding is lossy for
      // exactly the boards that are furthest along.
      const body = `Prose.\n\n${renderManagedBlock(
        [{ name: ASSIGNEE_FIELD, kind: 'id', value: 'RS-3' }],
        new Map([['RS-3', 'https://example.com/RS-3']]),
      )}`;

      const { patch } = pullBody(entry, body);

      expect(patch.assignee).toBe('RS-3');
    });

    it('recovers the period levels above the native container', () => {
      // A tracker holds one container (a sprint, a milestone, a cycle); the
      // increment above it has nowhere native to go on any of them.
      const body = `Prose.\n\n${renderManagedBlock([
        { name: degradedPeriodField('increment'), kind: 'text', value: 'PI-1' },
      ])}`;

      const { period } = pullBody(entry, body);

      expect(period?.degraded).toContainEqual({ type: 'increment', name: 'PI-1' });
    });

    it('keeps the block out of the prose', () => {
      // The block is the sync layer's own output. Left in the body it becomes
      // part of the document on the next pull, and then part of the *next*
      // push's prose — the block growing a copy of itself every round trip.
      const prose = 'Prose a person wrote.';
      const body = `${prose}\n\n${renderManagedBlock([
        { name: ASSIGNEE_FIELD, kind: 'id', value: 'RS-3' },
      ])}`;

      const { patch } = pullBody(entry, body);

      expect(patch.body).toBe(prose);
      expect(patch.body).not.toContain('lpm:begin');
    });

    it('leaves a body with no block exactly as it found it', () => {
      const { patch } = pullBody(entry, 'Just prose.');

      expect(patch.body).toBe('Just prose.');
      expect(patch.assignee ?? null).toBeNull();
    });

    it('prefers what the tracker holds natively over the block', () => {
      // A `pool:` label is carriage the remote really has, so a provider that
      // writes one needs no block row. Both resolve to the same resource id, so
      // a document that somehow carried both still comes back the same.
      const body = `Prose.\n\n${renderManagedBlock([
        { name: ASSIGNEE_FIELD, kind: 'id', value: 'RS-3' },
      ])}`;
      const record = entry.recordWithBody(body);
      const withLabel =
        entry.name === 'jira'
          ? { ...record, fields: { ...(record['fields'] as object), labels: [poolLabel('RS-3')] } }
          : { ...record, labels: [{ name: poolLabel('RS-3') }] };

      const { patch } = entry.provider.translator.fieldsFromRecord(
        withLabel,
        entry.mapping,
        ATTRIBUTES,
        ROSTER,
        PERIODS,
      );

      expect(patch.assignee).toBe('RS-3');
    });
  });
}

// ---------------------------------------------------------------------------
// The table must stay complete
// ---------------------------------------------------------------------------

describe('every provider that mirrors assignees is in this table', () => {
  it('covers the three trackers a board can be mirrored onto', () => {
    // `jsonfile` is deliberately absent: it declares no `accounts` mapping at
    // all, so it never carries an assignee natively *or* degraded, and there is
    // nothing here for it to recover. A fourth tracker belongs in this list.
    expect(entries.map((entry) => entry.name).sort()).toEqual(['github', 'jira', 'linear']);
  });

  it('renders a block every provider can parse back', () => {
    // One encoding, three readers: a block written for one tracker has to be
    // readable by the others, because the whole point is that a board pushed
    // from here can be pulled down somewhere else.
    const block = renderManagedBlock([{ name: ASSIGNEE_FIELD, kind: 'id', value: 'RS-3' }]);
    expect(parseManagedBlock(block).fields[ASSIGNEE_FIELD]).toBe('RS-3');
  });
});

// ---------------------------------------------------------------------------
// The write side: what goes into the body when the tracker cannot take it
// ---------------------------------------------------------------------------

/** An empty correspondence store — the state before the first sync. */
function emptyStore(): LinkStore {
  return { version: 1, cursor: null, links: new Map(), byRemote: new Map(), tombstones: new Map() };
}

/** A `create` op's placeholder reference, as the planner emits one. */
function tempRef(localId: string) {
  return { kind: 'new' as const, id: `new:${localId}` };
}

/** Declare a Jira remote on this board and open it — no connector, no network. */
function openedJira(paths: BoardPaths): OpenedRemote {
  const text = `
remotes:
  upstream:
    provider: jira
    on_delete: unlink
    conflict: manual
    connection:
      site: https://acme.atlassian.net
      project: PAY
    mapping:
      types:
        program: Task
      statuses:
        backlog: { remote: To Do, closed: false }
        ready: { remote: To Do, closed: false }
        in_progress: { remote: In Progress, closed: false }
        in_review: { remote: In Progress, closed: false }
        done: { remote: Done, closed: true }
      accounts:
        via: email
      periods:
        container: sprint
        carrier: sprint
`;
  writeFileSync(paths.configPath, `${readFileSync(paths.configPath, 'utf8')}${text}`, 'utf8');
  return openRemote(loadConfig(paths).config!, 'upstream');
}

/**
 * The other half of the rule, and the half that actually writes.
 *
 * A recording connector rather than an HTTP double: `executePush` drives the
 * real provider — its translator, its capabilities, its degradation ladder — and
 * calls `connector.create` / `update` with the request it built. What those
 * requests carry *is* the behaviour under test, so a fake that records them
 * tests it exactly, with no wire format in the way.
 *
 * Jira is here for a reason: it writes no labels, so it is the provider with
 * nowhere but the body to put a pool, and it is the one this was found on.
 */
describe('the push puts an unwritable assignee in the body', () => {
  /** A connector that records every request and answers plausibly. */
  function recorder() {
    const requests: Array<{ kind: string; remoteId?: string; request: RemoteRequest }> = [];
    const result = (remoteId: string) => ({
      remoteId,
      remoteKey: `PAY-${remoteId}`,
      remoteUrl: `https://example.invalid/${remoteId}`,
      remoteRev: 'r1',
      record: { id: remoteId, key: `PAY-${remoteId}`, fields: { summary: 'Work' } },
    });
    const connector = {
      name: 'jira',
      create: async (request: RemoteRequest) => {
        requests.push({ kind: 'create', request });
        return result('1000');
      },
      update: async (remoteId: string, request: RemoteRequest) => {
        requests.push({ kind: 'update', remoteId, request });
        return result(remoteId);
      },
      delete: async (remoteId: string) => result(remoteId),
      get: async () => null,
      list: async () => ({ records: [], cursor: null }),
    } as unknown as Connector;
    return { connector, requests };
  }

  /** The markdown a request carries, whatever shape the provider put it in. */
  function bodyOf(request: RemoteRequest): string {
    return typeof request.body === 'string' ? request.body : adfToMarkdown(request.body!);
  }

  it('writes the pool into the block, because Jira has no label to put it on', async () => {
    const paths = makeBoard('scrum', 'LP');
    const pool = createResource(reload(paths), { type: 'role', title: 'Backend' });
    const story = createIssue(reload(paths), {
      type: 'program',
      title: 'Work',
      assignee: pool.id,
    });
    const remote = openedJira(paths);
    const { connector, requests } = recorder();

    await executePush(reload(paths), remote, connector, emptyStore(), [
      { kind: 'create', localId: story.id, ref: tempRef(story.id) } as never,
    ]);

    expect(requests).toHaveLength(1);
    const fields = parseManagedBlock(bodyOf(requests[0]!.request)).fields;
    // The board's own resource id, which is what the `pool:` label carries
    // elsewhere — so one reader recovers both encodings.
    expect(fields[ASSIGNEE_FIELD]).toBe(pool.id);
  });

  it('leaves the block alone when the tracker can hold the assignee itself', async () => {
    const paths = makeBoard('scrum', 'LP');
    const person = createResource(reload(paths), {
      type: 'person',
      title: 'Ada',
      attributes: { email: 'ada@example.com' },
    });
    const story = createIssue(reload(paths), {
      type: 'program',
      title: 'Work',
      assignee: person.id,
    });
    const remote = openedJira(paths);
    const { connector, requests } = recorder();

    await executePush(reload(paths), remote, connector, emptyStore(), [
      { kind: 'create', localId: story.id, ref: tempRef(story.id) } as never,
    ]);

    // Written to Jira's own assignee field, so a block row would be a second
    // copy of a fact the remote already holds.
    expect(requests[0]!.request.assignee).toBe('ada@example.com');
    expect(parseManagedBlock(bodyOf(requests[0]!.request)).fields[ASSIGNEE_FIELD]).toBeUndefined();
  });
});
