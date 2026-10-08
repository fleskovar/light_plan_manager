import { describe, expect, it } from 'vitest';
import { markdownToAdf } from '../src/shared/adf.js';
import type { PeriodIndex } from '../src/remote/periods.js';
import type { Roster } from '../src/remote/accounts.js';
import type {
  AttributeDefs,
  BoardFields,
  Provider,
  RemoteRecord,
  RemoteRequest,
} from '../src/remote/provider.js';
import { registeredProviders } from '../src/remote/registry.js';
import { githubProvider } from '../src/remote/providers/github/index.js';
import { jiraProvider } from '../src/remote/providers/jira/index.js';
import { jsonfileProvider } from '../src/remote/providers/jsonfile/index.js';
import { linearProvider } from '../src/remote/providers/linear/index.js';

/**
 * **A document must survive its own translation.** One suite, every provider.
 *
 * This is the guard against spurious drift, and it is written as the property
 * that was missing rather than as a list of the bugs that got through. Drift is
 * decided by comparing the board against what the *remote* reports, so the only
 * way a document can be reported as changed when nobody changed it is if the
 * round trip through the remote's own vocabulary does not come back where it
 * started. So that is what is asserted, per provider:
 *
 * ```
 *   board document + board config + mapping        (what we have)
 *         │  translator.describeRequest
 *         ▼
 *   remote request                                 (what we would write)
 *         │  echo(): the platform's storage format AND its restrictions
 *         ▼
 *   remote record                                  (what the platform reports back)
 *         │  translator.fieldsFromRecord
 *         ▼
 *   recovered board fields    ===    the mirrored fields we started from
 * ```
 *
 * The four inputs are all present and each one is load-bearing: the **config**
 * (types, statuses, attributes), the **mapping** (which remote word carries
 * which board word), the platform's **known restrictions**, and the **document**.
 *
 * `echo` is the interesting one and the reason this suite can catch anything at
 * all. A double built from the same reading of the platform as the connector
 * round-trips a shared misunderstanding perfectly and passes — which is exactly
 * how these defects shipped. So every restriction an `echo` models carries the
 * evidence for it in a comment, and the ones that came from a live instance say
 * so. Where the platform's *format* is real code (Jira's ADF), `echo` calls that
 * code rather than imitating it.
 *
 * What this suite deliberately does **not** do is talk to a network, need a
 * credential, or build an HTTP double. It is the pure core of the property:
 * `describeRequest` → `fieldsFromRecord`, which is where both halves of every
 * drift comparison come from.
 */

// ---------------------------------------------------------------------------
// The board vocabulary the suite speaks
// ---------------------------------------------------------------------------

const ATTRIBUTES: AttributeDefs = {
  story_points: { type: 'int' },
  severity: { type: 'enum', values: ['low', 'high'] },
};

const ROSTER: Roster = new Map([
  ['RS-1', { id: 'RS-1', title: 'Ada', generic: false, attributes: { via: 'ada' } }],
]);

/** increment › sprint, so a board period resolves to a container plus a degraded level. */
const PERIODS: PeriodIndex = new Map([
  ['TL-1', { id: 'TL-1', title: 'PI-1', type: 'increment', parentId: null, starts: '2026-01-01', ends: '2026-03-31' }],
  ['TL-2', { id: 'TL-2', title: 'Sprint 1', type: 'sprint', parentId: 'TL-1', starts: '2026-01-01', ends: '2026-01-14' }],
]);

/** The fields a document carries into the round trip. */
function fields(over: Partial<BoardFields> = {}): BoardFields {
  return {
    type: 'user_story',
    status: 'in_progress',
    title: 'Paginate the query API',
    body: 'Prose about the work.',
    assignee: 'RS-1',
    period: 'TL-2',
    attributes: { story_points: 5, severity: 'high' },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The table: one entry per provider
// ---------------------------------------------------------------------------

/** What `echo` is told about the issue it is echoing back. */
interface EchoContext {
  /** The remote id the platform assigned. */
  remoteId: string;
  /**
   * The issue type the *platform* filed it as, in the platform's own words.
   * Separate from `request.type` because a restriction may depend on it — a
   * Jira sub-task is the worked example.
   */
  nativeType: string;
  /** Whether the platform treats this issue as a child that cannot be scheduled. */
  subtask?: boolean;
  /** The sprint the platform would report, when a restriction supplies one. */
  inheritedSprint?: { name: string; starts?: string; ends?: string };
}

interface TranslationEntry {
  name: string;
  provider: Provider;
  mapping: Record<string, unknown>;
  /**
   * The record the platform would store and report back for this request.
   *
   * This is the "known restrictions of the remote" input. It is hand-written on
   * purpose and every deviation from "store exactly what was sent" is justified
   * in a comment, because an `echo` that merely mirrors the request can never
   * fail and would make this whole suite decorative.
   */
  echo(request: RemoteRequest, ctx: EchoContext): RemoteRecord;
}

/**
 * The mapping shape every entry shares, as the whole-board round-trip suite
 * spells it: `types` and `statuses` name the remote's own words, `attributes`
 * name a short carrier per attribute. A provider that cannot hold one of these
 * natively degrades it (a label, the managed block) and the suite asserts the
 * result rather than the route.
 */
const TYPES = { user_story: { remote: 'story' }, sub_task: { remote: 'subtask' } };

const STATUSES = {
  backlog: { remote: ['Backlog'], closed: false },
  in_progress: { remote: ['In Progress'], closed: false },
  done: { remote: ['Done'], closed: true },
};

const ATTRS = { story_points: 'Pts', severity: 'Sev' };

/** Every label the request carried, plus one a human added. */
function labelsWithTriage(request: RemoteRequest): string[] {
  // A human's triage labels sit alongside the sync's own, which is why the
  // reader reconciles by claim rather than replacing the list (LP-308).
  // Echoing one back means the recovery has to ignore it, or a label nobody
  // mapped becomes an attribute or a type.
  return [...(request.labels ?? []), 'needs-triage'];
}

const entries: TranslationEntry[] = [
  {
    name: 'github',
    provider: githubProvider,
    mapping: {
      types: TYPES,
      statuses: STATUSES,
      attributes: ATTRS,
      accounts: { via: 'via' },
      periods: { container: 'sprint', carrier: 'milestones' },
    },
    // GitHub has no native type and no native status: both ride labels, and the
    // body is markdown stored verbatim.
    echo: (request, ctx) => ({
      number: Number(ctx.remoteId),
      title: request.title,
      body: request.body,
      state: request.state ?? 'open',
      labels: labelsWithTriage(request).map((name) => ({ name })),
      assignee: request.assignee ? { login: request.assignee } : null,
      milestone: request.period ? { title: request.period.name } : null,
      node_id: `N_${ctx.remoteId}`,
      updated_at: '2026-01-02T00:00:00Z',
    }),
  },
  {
    name: 'linear',
    provider: linearProvider,
    mapping: {
      types: TYPES,
      statuses: STATUSES,
      attributes: ATTRS,
      accounts: { via: 'via' },
      periods: { container: 'sprint', carrier: 'sprint' },
    },
    // Linear has a native workflow state and a native assignee, but no issue
    // type — the type rides a label.
    echo: (request, ctx) => ({
      id: ctx.remoteId,
      identifier: `ENG-${ctx.remoteId}`,
      title: request.title,
      description: request.body,
      state: { name: request.state ?? 'Backlog' },
      // A flat array, not GraphQL's `{ nodes: [...] }`: the connector flattens
      // the relay connection before the translator ever sees the record, so
      // this is the shape `fieldsFromRecord` is contracted to read.
      labels: labelsWithTriage(request).map((name) => ({ name })),
      assignee: request.assignee ? { id: request.assignee, name: request.assignee } : null,
      cycle: request.period ? { name: request.period.name } : null,
      updatedAt: '2026-01-02T00:00:00.000Z',
    }),
  },
  {
    name: 'jsonfile',
    provider: jsonfileProvider,
    mapping: { types: TYPES, statuses: STATUSES, attributes: ATTRS },
    // The store is ours, so the vocabulary is written rather than pre-existing
    // (`vocabulary: 'open'`) and `type` / `status` are native fields. It declares
    // no `accounts` and no `periods`, so an assignee and a period ride the
    // managed block — which is why neither appears on the request at all.
    echo: (request, ctx) => ({
      number: Number(ctx.remoteId),
      title: request.title,
      body: request.body,
      status: request.state,
      type: request.type,
      labels: labelsWithTriage(request),
      assignee: request.assignee ?? null,
      depends_on: [],
      comments: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    }),
  },
  {
    name: 'jira',
    provider: jiraProvider,
    mapping: {
      types: TYPES,
      statuses: STATUSES,
      attributes: ATTRS,
      accounts: { via: 'via' },
      periods: { container: 'sprint', carrier: 'sprint' },
    },
    echo: (request, ctx) => {
      // **Jira's description is ADF**, and this calls the real converter rather
      // than imitating it: `markdownToAdf` is what the connector's `fieldsOf`
      // uses at the wire, so the body genuinely goes through the format the
      // platform stores. Imitating it is the one thing that would make this
      // double worthless.
      const description =
        typeof request.body === 'string' ? markdownToAdf(request.body) : request.body;
      const record: RemoteRecord = {
        id: ctx.remoteId,
        key: `SCRUM-${ctx.remoteId}`,
        fields: {
          summary: request.title,
          description,
          issuetype: { name: ctx.nativeType, subtask: ctx.subtask === true },
          status: { name: request.state ?? 'Backlog' },
          assignee: request.assignee
            ? { accountId: request.assignee, id: request.assignee, name: request.assignee }
            : null,
          updated: '2026-01-02T00:00:00.000+0000',
        },
      };
      // **Restriction: a sub-task cannot be scheduled on its own.** Jira reports
      // the *parent's* sprint on it, the identical object, whether or not
      // anything ever wrote it there. Measured against a live instance:
      // `SCRUM-1385` (Subtask) and its parent `SCRUM-1225` (Story) both came
      // back with `customfield_10020 = [{id:63,name:"New Sprint",state:"future"}]`
      // while the board had a period on the story alone. Without this line the
      // sub-task case below passes whatever the translator does.
      const sprint = ctx.inheritedSprint ?? request.period ?? undefined;
      if (sprint !== null && sprint !== undefined) {
        record['sprint'] = {
          name: sprint.name,
          ...(sprint.starts !== undefined ? { starts: sprint.starts } : {}),
          ...(sprint.ends !== undefined ? { ends: sprint.ends } : {}),
        };
      }
      return record;
    },
  },
];

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

/** Push the fields through the provider and read them back. */
function roundTrip(
  entry: TranslationEntry,
  boardFields: BoardFields,
  ctx: Partial<EchoContext> = {},
) {
  const { request } = entry.provider.translator.describeRequest(
    { kind: 'create', localId: 'LP-1', fields: boardFields },
    entry.mapping,
    ATTRIBUTES,
    ROSTER,
    PERIODS,
  );
  const record = entry.echo(request, {
    remoteId: '101',
    nativeType: request.type ?? 'Story',
    ...ctx,
  });
  const result = entry.provider.translator.fieldsFromRecord(
    record,
    entry.mapping,
    ATTRIBUTES,
    ROSTER,
    PERIODS,
  );
  return { request, record, patch: result.patch };
}

for (const entry of entries) {
  describe(`${entry.name}: a document survives its own translation`, () => {
    it('brings back nothing that differs from what it sent', () => {
      // **The property, in one assertion.** Drift is decided by comparing the
      // board against what the remote reports, so a document is reported as
      // changed when nobody changed it exactly when some field comes back
      // *different*. A field the translation does not carry at all is a
      // different thing and is not drift: `baseFromRecord` falls back to the
      // board's own value for it, so both sides agree by construction. That
      // asymmetry is the whole shape of the sub-task fix, and asserting it as
      // "nothing differs" rather than "everything is present" is what makes one
      // property cover four providers of very different capability.
      const sent = fields();
      const { patch } = roundTrip(entry, sent);

      const differences: string[] = [];
      if (patch.title !== undefined && patch.title !== sent.title) differences.push('title');
      if (patch.type !== undefined && patch.type !== sent.type) differences.push('type');
      if (patch.status !== undefined && patch.status !== sent.status) differences.push('status');
      if (patch.assignee !== undefined && patch.assignee !== sent.assignee) {
        differences.push('assignee');
      }
      if (patch.period !== undefined && patch.period !== sent.period) differences.push('period');
      for (const [name, value] of Object.entries(patch.attributes ?? {})) {
        if (value !== sent.attributes?.[name]) differences.push(`attributes.${name}`);
      }
      expect(differences).toEqual([]);
    });

    it('carries the title and the status, which every provider mirrors', () => {
      // The floor under the property above: a provider that carried *nothing*
      // would satisfy "nothing differs" trivially, so the two fields every
      // shipped provider does mirror are named explicitly.
      const { patch } = roundTrip(entry, fields());
      expect(patch.title).toBe('Paginate the query API');
      expect(patch.status).toBe('in_progress');
    });

    it('recovers a body unchanged once the remote has stored it', () => {
      // The body is compared as a hash of `normalizeBody(local)` against what
      // the remote reports, so the two must agree after one round trip. A
      // provider whose body format is not markdown declares `normalizeBody`
      // for exactly this, and that is what is being checked here.
      const body = 'A paragraph of prose.\n\n## A heading\n\n- a list item\n- another\n';
      const { patch } = roundTrip(entry, fields({ body }));
      const normalize = entry.provider.translator.normalizeBody ?? ((text: string) => text);
      expect(patch.body).toBe(normalize(body));
    });

    it('is idempotent about the body: normalizing twice changes nothing', () => {
      // The base records `normalizeBody(local)` and the remote's echo has been
      // through it once already, so a second application must be a no-op or the
      // two sides can never agree and every push rewrites every document.
      const normalize = entry.provider.translator.normalizeBody;
      if (normalize === undefined) return; // a markdown-bodied remote round-trips as-is
      for (const body of [
        'Plain prose.',
        'Hard-wrapped prose that\ncontinues on the next line.',
        '## Heading\n\n- [ ] a task item\n- [x] a done item\n',
        'Inline `code` and **bold** and a [link](https://example.com).',
      ]) {
        const once = normalize(body);
        expect(normalize(once)).toBe(once);
      }
    });

    it('recovers an unscheduled document as unscheduled, never as a period', () => {
      // A board document with no period must not come back carrying one. This
      // is the shape the Jira sub-task defect took, and asserting it for every
      // provider is what stops the next platform inventing a value here.
      const { patch } = roundTrip(entry, fields({ period: null }));
      expect(patch.period ?? null).toBeNull();
    });

    it('recovers an unassigned document as unassigned', () => {
      const { patch } = roundTrip(entry, fields({ assignee: null }));
      expect(patch.assignee ?? null).toBeNull();
    });

    it('ignores labels the sync does not claim', () => {
      // Every double above echoes a human's triage label back. It must not
      // become an attribute, a type or a status.
      const { patch } = roundTrip(entry, fields());
      expect(patch.type).toBe('user_story');
      expect(patch.status).toBe('in_progress');
    });
  });
}

// ---------------------------------------------------------------------------
// The restriction that produced the defect
// ---------------------------------------------------------------------------

describe('jira: a sub-task does not own its sprint', () => {
  const jira = entries.find((entry) => entry.name === 'jira')!;

  it('does not read the parent\'s sprint back as the sub-task\'s own', () => {
    // The board schedules the story and leaves the sub-task alone; Jira reports
    // the story's sprint on the sub-task anyway. Reading it back is a remote
    // edit nobody made — 13 documents of permanent `behind` on this repository's
    // own board, which is where this test comes from.
    const { record, patch } = roundTrip(jira, fields({ type: 'sub_task', period: null }), {
      nativeType: 'Subtask',
      subtask: true,
      inheritedSprint: { name: 'Sprint 1', starts: '2026-01-01', ends: '2026-01-14' },
    });

    // The double really does report it — otherwise this test proves nothing.
    expect(record['sprint']).toMatchObject({ name: 'Sprint 1' });
    // And the translator does not pass it on.
    expect('period' in patch).toBe(false);
  });

  it('still reads a sprint off a standard issue through the same double', () => {
    const { patch } = roundTrip(jira, fields(), { nativeType: 'Story', subtask: false });
    expect(patch.period).toBe('TL-2');
  });
});

// ---------------------------------------------------------------------------
// The table must stay complete
// ---------------------------------------------------------------------------

describe('every registered provider is in this table', () => {
  it('has an entry per provider, so a new one cannot skip the property', () => {
    // The failure this guards against has happened: `test/remote-roundtrip.test.ts`
    // claimed every provider in its header and covered three, and the one it
    // left out was Jira — the provider every one of these defects came from.
    expect(entries.map((entry) => entry.name).sort()).toEqual(registeredProviders());
  });

  it('gives each entry a mapping that names the board vocabulary under test', () => {
    // A mapping missing `statuses` or `types` would make the round trip vacuous:
    // nothing is claimed, so nothing can come back wrong.
    for (const entry of entries) {
      expect(Object.keys(entry.mapping)).toContain('types');
      expect(Object.keys(entry.mapping)).toContain('statuses');
    }
  });
});
