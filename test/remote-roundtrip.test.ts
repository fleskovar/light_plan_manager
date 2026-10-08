/**
 * LP-353 — a realistic board round-trips through every provider without drift.
 *
 * The acceptance test for the whole remote-sync increment: one board — five
 * levels, every attribute type, dependencies, periods and a roster with a
 * generic pool — is pushed to each provider's fake, pulled back, and compared.
 * The bar is the note in the story: every document is byte-identical apart
 * from `updated`, because `serializeNode` fixes frontmatter key order, so
 * anything else that moves is a real bug.
 *
 * The table is the same shape as the conformance suite's (LP-300): one entry
 * per provider, the scenario bodies never name one.  The board config is richer
 * than the conformance suite's — it declares all eight attribute types, a
 * timeline and a roster — so a provider's attribute / period / account mapping
 * is exercised, not just types and statuses.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIssue,
  createPeriod,
  createResource,
  loadBoard,
  updateNode,
  type LoadedBoard,
} from '../src/core/index.js';
import type { BoardPaths } from '../src/core/index.js';
import { githubBlockEdgesOf, githubParentIdOf, githubProvider } from '../src/remote/providers/github/index.js';
import {
  linearDependsOnOf,
  linearParentIdOf,
  linearProvider,
  linearRelatesToOf,
} from '../src/remote/providers/linear/index.js';
import {
  jsonfileDependsOnOf,
  jsonfileParentIdOf,
  jsonfileProvider,
  jsonfileRemoteIdOf,
} from '../src/remote/providers/jsonfile/index.js';
import { executePush } from '../src/remote/index.js';
import { planPull, planPush } from '../src/remote/plan.js';
import { applyPull } from '../src/remote/pull.js';
import { cleanupBoards } from './helpers.js';
import { jsonFileTracker, type JsonFileTracker } from './support/jsonfile-tracker.js';
import {
  buildHarness,
  providerPull,
  viewOf,
  type ConformanceEntry,
  type ConformanceHarness,
} from './support/provider-conformance.js';

afterAll(cleanupBoards);
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The board: five levels, all eight attribute types, periods, a roster
// ---------------------------------------------------------------------------

/**
 * The config declares every attribute type on the story level, a two-level
 * timeline (increment › sprint) and a roster (person + generic pool) whose
 * `via` attribute carries the remote account.
 */
const CONFIG = `version: 1

key_prefix: LP

statuses:
  - id: backlog
    label: Backlog
  - id: ready
    label: Ready
  - id: in_progress
    label: In Progress
    active: true
  - id: done
    label: Done
    terminal: true

default_status: backlog

hierarchy:
  - program
  - epic
  - feature
  - user_story
  - sub_task

period_prefix: TL

period_hierarchy:
  - increment
  - sprint

period_types:
  increment:
    label: Increment
    attributes:
      theme:
        type: string
    body: |
      ## Increment Objectives

      | Objective | Value |
      | --- | --- |
      |  |  |

  sprint:
    label: Sprint
    attributes:
      goal:
        type: string
    body: |
      ## Sprint Goal

      One sentence the team commits to.

resource_prefix: RS

resource_hierarchy:
  - [person, role]

resource_types:
  person:
    label: Person
    attributes:
      via:
        type: string
    body: |
      ## Notes
  role:
    label: Role
    generic: true
    attributes:
      via:
        type: string
    body: |
      ## Notes

issue_types:
  program:
    label: Program
    body: |
      ## Vision

      What outcome does this program pursue?

  epic:
    label: Epic
    body: |
      ## Summary

      A short paragraph describing the epic.

  feature:
    label: Feature
    body: |
      ## Summary

      What capability does this feature deliver?

  user_story:
    label: User Story
    atomic: true
    attributes:
      attr_string:
        type: string
      attr_text:
        type: text
      attr_int:
        type: int
      attr_float:
        type: float
      attr_bool:
        type: bool
      attr_date:
        type: date
      attr_enum:
        type: enum
        values: [alpha, beta, gamma]
      attr_array:
        type: array
    body: |
      As a **role**, I want **capability**.

      ## Acceptance Criteria

      - [ ] Criterion

  sub_task:
    label: Sub-task
    body: |
      ## Description

      What exactly needs to be done?
`;

let configDir: string | null = null;

/** Write the board config once and hand back a path `makeBoard` can read. */
function configPath(): string {
  if (configDir === null) {
    configDir = mkdtempSync(path.join(os.tmpdir(), 'lpm-roundtrip-config-'));
  }
  const file = path.join(configDir, 'roundtrip.yml');
  writeFileSync(file, CONFIG, 'utf8');
  return file;
}

afterAll(() => {
  if (configDir !== null) rmSync(configDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The table: one entry per provider, the same mapping shape
// ---------------------------------------------------------------------------

const TYPES = {
  program: { remote: 'program' },
  epic: { remote: 'epic' },
  feature: { remote: 'feature' },
  user_story: { remote: 'story' },
  sub_task: { remote: 'subtask' },
};

const STATUSES = {
  backlog: { remote: ['Backlog'], closed: false },
  ready: { remote: ['Ready'], closed: false },
  in_progress: { remote: ['In Progress'], closed: false },
  done: { remote: ['Done'], closed: true },
};

const ATTRIBUTES = {
  attr_string: 'Str',
  attr_text: 'Txt',
  attr_int: 'Int',
  attr_float: 'Flt',
  attr_bool: 'Bool',
  attr_date: 'Dat',
  attr_enum: 'Enm',
  attr_array: 'Arr',
};

const GITHUB_MAPPING: Record<string, unknown> = {
  types: TYPES,
  statuses: STATUSES,
  attributes: ATTRIBUTES,
  accounts: { via: 'via' },
  periods: { container: 'sprint', carrier: 'milestones' },
};

const LINEAR_MAPPING: Record<string, unknown> = {
  types: TYPES,
  statuses: STATUSES,
  attributes: ATTRIBUTES,
  accounts: { via: 'via' },
  periods: { container: 'sprint', carrier: 'sprint' },
};

/**
 * The jsonfile mapping. Deliberately shorter than the other two: the file
 * tracker holds `type` and `status` natively, and declares **no** `periods`
 * and no `accounts` block — a period and an assignee ride the managed block
 * (rung 4). That absence is the point of including it here. The provider was
 * missing from this table until LP-531/LP-532, and its absence hid two
 * defects that only a whole board round trip could show: a remote that could
 * not be opened at all on a board declaring period types, and a pull that
 * matched no record to its link and read every twin as deleted.
 */
const JSONFILE_MAPPING: Record<string, unknown> = {
  types: {
    program: { remote: 'program' },
    epic: { remote: 'epic' },
    feature: { remote: 'feature' },
    user_story: { remote: 'story' },
    sub_task: { remote: 'subtask' },
  },
  statuses: STATUSES,
  attributes: ATTRIBUTES,
};

const entries: ConformanceEntry[] = [
  {
    name: 'github',
    provider: githubProvider,
    connection: { repo: 'acme/payments', base_url: 'https://api.github.com' },
    mapping: GITHUB_MAPPING,
    pull: providerPull(githubProvider, GITHUB_MAPPING, {
      parentIdOf: githubParentIdOf,
      blockEdgesOf: githubBlockEdgesOf,
    }),
  },
  {
    name: 'linear',
    provider: linearProvider,
    connection: { team: 'ENG', base_url: 'https://api.linear.app' },
    mapping: LINEAR_MAPPING,
    pull: providerPull(linearProvider, LINEAR_MAPPING, {
      parentIdOf: linearParentIdOf,
      dependsOnOf: linearDependsOnOf,
      relatesToOf: linearRelatesToOf,
    }),
    recordsOf: (tracker) => tracker.linearRecords(),
    remoteIdOf: (record) => String(record.id ?? ''),
  },
  {
    name: 'jsonfile',
    provider: jsonfileProvider,
    // Overridden per-harness by `trackerAndConnection` — the connector is
    // fs-backed, so the file path is resolved against the board's own root.
    connection: { file: '' },
    mapping: JSONFILE_MAPPING,
    pull: providerPull(jsonfileProvider, JSONFILE_MAPPING, {
      parentIdOf: jsonfileParentIdOf,
      dependsOnOf: jsonfileDependsOnOf,
    }),
    trackerAndConnection: (paths, { tracker, seed }) => {
      const t = (
        tracker ?? jsonFileTracker({ file: path.join(paths.root, 'tracker.json'), seed })
      ) as JsonFileTracker;
      return { tracker: t, connection: { file: t.file } };
    },
    recordsOf: (tracker) => (tracker as JsonFileTracker).records(),
    remoteIdOf: jsonfileRemoteIdOf,
  },
];

// ---------------------------------------------------------------------------
// The realistic board
// ---------------------------------------------------------------------------

/** programme › epic › feature › story(+all 8 attrs) › sub-task, two stories,
 *  one dependent edge, a sprint, and two assignees (person + generic pool). */
function buildRealisticBoard(paths: BoardPaths) {
  const board = loadBoard(paths);
  const increment = createPeriod(board, {
    type: 'increment',
    title: 'Inc 1',
    starts: '2026-08-01',
    ends: '2026-08-31',
  });
  const sprint = createPeriod(loadBoard(paths), {
    type: 'sprint',
    title: 'Sprint 1',
    parentId: increment.id,
    starts: '2026-08-10',
    ends: '2026-08-24',
  });
  const ada = createResource(loadBoard(paths), {
    type: 'person',
    title: 'Ada',
    attributes: { via: 'ada' },
  });
  const pool = createResource(loadBoard(paths), {
    type: 'role',
    title: 'Backend',
    capacity: 3,
    attributes: { via: 'backend' },
  });

  const program = createIssue(loadBoard(paths), {
    type: 'program',
    title: 'Programme',
  });
  const epic = createIssue(loadBoard(paths), {
    type: 'epic',
    title: 'Epic',
    parentId: program.id,
  });
  const feature = createIssue(loadBoard(paths), {
    type: 'feature',
    title: 'Feature',
    parentId: epic.id,
  });
  const story = createIssue(loadBoard(paths), {
    type: 'user_story',
    title: 'Story',
    parentId: feature.id,
    period: sprint.id,
    assignee: ada.id,
    attributes: {
      attr_string: 'hello',
      attr_text: 'a line of text',
      attr_int: 5,
      attr_float: 2.5,
      attr_bool: true,
      attr_date: '2026-08-16',
      attr_enum: 'beta',
      attr_array: ['x', 'y'],
    },
  });
  updateNode(loadBoard(paths), loadBoard(paths).byId.get(story.id)!, {
    body: 'As a **user**, I want **a thing**.\n\n## Acceptance Criteria\n\n- [ ] Criterion\n',
  });
  const story2 = createIssue(loadBoard(paths), {
    type: 'user_story',
    title: 'Story 2',
    parentId: feature.id,
    period: sprint.id,
    assignee: pool.id,
    dependsOn: [story.id],
    attributes: { attr_string: 'world', attr_enum: 'alpha' },
  });
  const subtask = createIssue(loadBoard(paths), {
    type: 'sub_task',
    title: 'Sub-task',
    parentId: story.id,
  });

  return { increment, sprint, ada, pool, program, epic, feature, story, story2, subtask };
}

/** Every document the round trip is compared over, as its serialized bytes. */
function documentBytes(board: LoadedBoard): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of [...board.issues, ...board.periods, ...board.resources]) {
    map.set(node.file, readFileSync(node.file, 'utf8'));
  }
  return map;
}

/** The same bytes with the `updated:` line dropped — the one field allowed to move. */
function stripUpdated(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('updated:'))
    .join('\n');
}

/** Re-bind the pull seams to the populated board (periods + roster exist now). */
function rebindPull(h: ConformanceHarness): ConformanceHarness {
  h.pullOptions = h.entry.pull(h.reload());
  return h;
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

/**
 * Providers whose *scheduling* does not survive a fresh pull yet, with the bug
 * that tracks it. Everything else in the round trip is asserted for them.
 *
 * `jsonfile` — LP-533. The push now writes each period level as a
 * `period:<type>` row in the managed block (that half is fixed and asserted by
 * the main round trip), but the provider's translator ignores `periods`
 * entirely on the way back, so a fresh board cannot recover the sprint. The
 * assignee rides the same gap: the file holds an arbitrary `assignee` string
 * that nothing resolves to a resource. `docs/remote-jsonfile.md` describes
 * both as working; they do not, and the doc is what is wrong.
 *
 * Do not widen this set to make a failure go away — a provider that stops
 * round-tripping scheduling is a regression, and this list is the record of
 * the two that never did it, not a licence.
 */
const SCHEDULING_GAPS = new Map<string, string>([['jsonfile', 'LP-533']]);

for (const entry of entries) {
  describe(`round trip: ${entry.name}`, () => {
    it('push → pull reproduces the board byte-identically apart from `updated`, and the next two cycles plan nothing', async () => {
      const h = await buildHarness(entry, { template: configPath() });
      buildRealisticBoard(h.paths);
      rebindPull(h);

      const before = documentBytes(h.reload());

      // -- cycle 1: push -----------------------------------------------------
      const pushPlan = planPush(viewOf(h.reload()), h.store, h.snapshot());
      const pushed = await executePush(h.reload(), h.opened, h.connector, h.store, pushPlan.ops);
      expect(pushed.failed).toEqual([]);
      expect(pushed.skipped).toEqual([]);
      // Six issues filed, each with a twin.
      expect(h.store.links.size).toBe(6);
      expect(pushed.landed.filter((op) => op.kind === 'create')).toHaveLength(6);

      // -- cycle 1: pull -----------------------------------------------------
      const pullPlan = planPull(h.view(), h.store, h.snapshot(), h.pullOptions);
      expect(pullPlan.changes).toEqual([]);
      expect(pullPlan.links).toEqual([]);
      const pulled = applyPull(h.paths, entry.name, h.store, pullPlan);
      expect(pulled.failures).toEqual([]);

      // -- the bar: nothing moved except possibly `updated` -------------------
      const after = documentBytes(h.reload());
      expect(after.size).toBe(before.size);
      for (const [file, original] of before) {
        expect(stripUpdated(after.get(file)!)).toBe(stripUpdated(original));
      }

      // -- cycles 2 and 3: both directions plan nothing ----------------------
      for (let cycle = 2; cycle <= 3; cycle += 1) {
        expect(planPush(viewOf(h.reload()), h.store, h.snapshot())).toEqual({
          ops: [],
          skipped: [],
        });
        expect(planPull(h.view(), h.store, h.snapshot(), h.pullOptions)).toEqual({
          changes: [],
          links: [],
        });
      }
    });

    it('reproduces the board through a fresh pull (the degraded block round-trips)', async () => {
      const producer = await buildHarness(entry, { template: configPath() });
      const docs = buildRealisticBoard(producer.paths);
      rebindPull(producer);
      const plan = planPush(viewOf(producer.reload()), producer.store, producer.snapshot());
      const result = await executePush(
        producer.reload(),
        producer.opened,
        producer.connector,
        producer.store,
        plan.ops,
      );
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);

      // A fresh board over the same tracker: same timeline, same roster, no issues.
      const consumer = await buildHarness(entry, {
        template: configPath(),
        tracker: producer.tracker,
      });
      const consumerIncrement = createPeriod(loadBoard(consumer.paths), {
        type: 'increment',
        title: 'Inc 1',
        starts: '2026-08-01',
        ends: '2026-08-31',
      });
      const consumerSprint = createPeriod(loadBoard(consumer.paths), {
        type: 'sprint',
        title: 'Sprint 1',
        parentId: consumerIncrement.id,
        starts: '2026-08-10',
        ends: '2026-08-24',
      });
      createResource(loadBoard(consumer.paths), {
        type: 'person',
        title: 'Ada',
        attributes: { via: 'ada' },
      });
      createResource(loadBoard(consumer.paths), {
        type: 'role',
        title: 'Backend',
        capacity: 3,
        attributes: { via: 'backend' },
      });
      rebindPull(consumer);

      const pullPlan = planPull(consumer.view(), consumer.store, consumer.snapshot(), consumer.pullOptions);
      const applied = applyPull(consumer.paths, entry.name, consumer.store, pullPlan);
      expect(applied.failures).toEqual([]);
      expect(consumer.store.links.size).toBe(6);

      // The fresh board reproduces the source board, issue for issue.
      const source = loadBoard(producer.paths);
      const fresh = consumer.reload();
      expect(fresh.issues).toHaveLength(source.issues.length);

      const byTitle = new Map(fresh.issues.map((issue) => [issue.title, issue]));
      for (const original of source.issues) {
        const twin = byTitle.get(original.title)!;
        expect(twin, original.title).toBeDefined();
        expect(twin.type).toBe(original.type);
        expect(twin.status).toBe(original.status);
        expect(twin.attributes).toEqual(original.attributes);
        // Hierarchy recovered by title — the parent chain, not the id.
        const parentTitle = (id: string | null): string | null =>
          id ? (source.byId.get(id)?.title ?? null) : null;
        expect(twin.parentId === null ? null : fresh.byId.get(twin.parentId)?.title ?? null).toBe(
          parentTitle(original.parentId),
        );
        // Dependency edges recovered by title.
        const dependsTitles = original.depends_on
          .map((id) => source.byId.get(id)?.title)
          .filter((t): t is string => t !== undefined)
          .sort();
        expect(
          twin.depends_on
            .map((id) => fresh.byId.get(id)?.title)
            .filter((t): t is string => t !== undefined)
            .sort(),
        ).toEqual(dependsTitles);
        // Period and assignee recovered by title.
        if (!SCHEDULING_GAPS.has(entry.name)) {
          expect(twin.period ? fresh.periodsById.get(twin.period)?.title ?? null : null).toBe(
            original.period ? source.periodsById.get(original.period)?.title ?? null : null,
          );
          expect(twin.assignee ? fresh.resourcesById.get(twin.assignee)?.title ?? null : null).toBe(
            original.assignee ? source.resourcesById.get(original.assignee)?.title ?? null : null,
          );
        }
      }

      // The sprint the stories were scheduled into is the fresh board's sprint.
      if (!SCHEDULING_GAPS.has(entry.name)) {
        const freshStory = byTitle.get('Story')!;
        expect(freshStory.period).toBe(consumerSprint.id);
      }
    });

    it('an edit on each side between cycles lands, and neither is lost', async () => {
      const h = await buildHarness(entry, { template: configPath() });
      const { story, story2 } = buildRealisticBoard(h.paths);
      rebindPull(h);

      // Converge first: push, then pull.
      const pushPlan = planPush(viewOf(h.reload()), h.store, h.snapshot());
      await executePush(h.reload(), h.opened, h.connector, h.store, pushPlan.ops);
      applyPull(h.paths, entry.name, h.store, planPull(h.view(), h.store, h.snapshot(), h.pullOptions));

      // -- the local edit: rename the story ---------------------------------
      updateNode(h.reload(), h.reload().byId.get(story.id)!, { title: 'Story (renamed locally)' });

      // -- the remote edit: a human re-titles the dependent story upstream ---
      const story2RemoteId = Number(h.store.links.get(story2.id)!.remoteId);
      h.tracker.mutateIssue(String(story2RemoteId), { title: 'Story 2 (renamed remotely)' });

      // Push lands the local rename; pull lands the remote rename.
      const pushPlan2 = planPush(viewOf(h.reload()), h.store, h.snapshot());
      const pushed2 = await executePush(h.reload(), h.opened, h.connector, h.store, pushPlan2.ops);
      expect(pushed2.failed).toEqual([]);
      const remoteStory = [...h.tracker.issues().values()].find(
        (issue) => issue.number === Number(h.store.links.get(story.id)!.remoteId),
      )!;
      expect(remoteStory.title).toBe('Story (renamed locally)');

      const pullPlan2 = planPull(h.view(), h.store, h.snapshot(), h.pullOptions);
      applyPull(h.paths, entry.name, h.store, pullPlan2);

      const board = h.reload();
      expect(board.byId.get(story.id)!.title).toBe('Story (renamed locally)');
      expect(board.byId.get(story2.id)!.title).toBe('Story 2 (renamed remotely)');

      // Neither edit was lost on the remote either: the local rename is on its
      // twin, and the human's remote rename is still where they left it.
      const remoteStory2 = [...h.tracker.issues().values()].find(
        (issue) => issue.number === Number(h.store.links.get(story2.id)!.remoteId),
      )!;
      expect(remoteStory2.title).toBe('Story 2 (renamed remotely)');

      // A push re-records the pulled title into the base, and the push after
      // that plans nothing — neither edit bounces back and forth.
      const resync = planPush(viewOf(h.reload()), h.store, h.snapshot());
      const resynced = await executePush(h.reload(), h.opened, h.connector, h.store, resync.ops);
      expect(resynced.failed).toEqual([]);
      expect(planPush(viewOf(h.reload()), h.store, h.snapshot())).toEqual({ ops: [], skipped: [] });
    });
  });
}
