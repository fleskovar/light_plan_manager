/**
 * LP-332 — the Linear provider, as pure addition.
 *
 * These are the provider's own tests, beside the shared conformance suite
 * (which runs Linear end to end against the in-memory tracker). They cover what
 * the conformance suite deliberately leaves to the provider: the config schema,
 * the capability table, and the translator's and relation seams' pure behaviour
 * against literal records.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateNode } from '../src/core/index.js';
import type { AttributeDefs, RemoteRecord } from '../src/remote/provider.js';
import { executePush } from '../src/remote/index.js';
import { planPull, planPush } from '../src/remote/plan.js';
import { applyPull } from '../src/remote/pull.js';
import { linearConfigSchema } from '../src/remote/providers/linear/config.js';
import { linearConnector } from '../src/remote/providers/linear/connector.js';
import {
  linearDependsOnOf,
  linearParentIdOf,
  linearRelatesToOf,
} from '../src/remote/providers/linear/labels.js';
import { linearProvider } from '../src/remote/providers/linear/index.js';
import { linearTranslator } from '../src/remote/providers/linear/translator.js';
import { lookupProvider, providers } from '../src/remote/registry.js';
import { buildHarness, plantTree, providerPull, type ConformanceEntry } from './support/provider-conformance.js';
import type { MemoryConnector } from './support/memory-tracker.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Linear provider is pure addition', () => {
  it('is registered under the name "linear"', () => {
    expect(providers.linear).toBe(linearProvider);
    expect(lookupProvider('linear')).toBe(linearProvider);
  });

  it('exposes the four members plus its two optional descriptors', () => {
    expect(Object.keys(linearProvider).sort()).toEqual([
      'capabilities',
      'config',
      'connector',
      'credentials',
      'standardVocabulary',
      'translator',
    ]);
    expect(linearProvider.credentials?.secrets).toEqual({ api_key: 'LINEAR_API_KEY' });
  });

  it('states a status convention and no type one, because Linear has no types (LP-537)', () => {
    // A board type rides a label whose name is the board's own word, so there is
    // no convention to state and nothing to reconcile — only the workflow states
    // are Linear's own vocabulary.
    expect(linearProvider.standardVocabulary?.statusFor).toBeTypeOf('function');
    expect(linearProvider.standardVocabulary?.typeFor).toBeUndefined();
  });

  it('declares Linear capabilities (LP-267)', () => {
    const c = linearProvider.capabilities;
    expect(c.hierarchyDepth).toBe(1); // one native parent edge: issue › sub-issue
    expect(c.nativeTypes).toBe(false); // no issue types — the type rides labels
    expect(c.status).toEqual({ kind: 'states' }); // named team workflow states
    expect(c.edges).toEqual({ dependsOn: true, relatesTo: true }); // blocks / related
    expect(c.customFields).toBeNull(); // no custom fields at all
    expect(c.periods).toEqual({ native: true, creatable: true }); // cycles
    expect(c.comments).toEqual({ native: true, editable: true, deletable: true });
  });
});

describe('the Linear config schema', () => {
  it('validates a full declaration, stamping the sprint carrier', () => {
    const parsed = linearConfigSchema.safeParse({
      connection: { team: 'ENG', api_key: '${LINEAR_API_KEY}' },
      mapping: {
        types: { user_story: { remote: 'story' } },
        statuses: { backlog: 'Backlog', done: { remote: ['Done'], closed: true } },
        attributes: { story_points: 'Points' },
        accounts: { via: 'email' },
        periods: { container: 'sprint' },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.mapping.periods).toEqual({ container: 'sprint', carrier: 'sprint' });
      expect(parsed.data.mapping.statuses).toMatchObject({
        backlog: { remote: ['Backlog'] },
        done: { remote: ['Done'], closed: true },
      });
    }
  });

  it('requires the team', () => {
    const parsed = linearConfigSchema.safeParse({ connection: {}, mapping: {} });
    expect(parsed.success).toBe(false);
  });

  it('accepts an effort mapping naming the estimate attribute (LP-333)', () => {
    const parsed = linearConfigSchema.safeParse({
      connection: { team: 'ENG' },
      mapping: { effort: { attribute: 'story_points' } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mapping.effort).toEqual({ attribute: 'story_points' });
  });
});

describe('the Linear translator', () => {
  const mapping = {
    types: { program: { remote: 'program' }, user_story: { remote: 'story' } },
    statuses: {
      backlog: { remote: ['Backlog'] },
      in_progress: { remote: ['In Progress'] },
      done: { remote: ['Done'], closed: true },
    },
    attributes: { story_points: 'Points' },
    accounts: { via: 'email' },
  };
  const attributes: AttributeDefs = { story_points: { type: 'int' } };

  it('describes a create as a Linear request: type label, state name, attribute label', () => {
    const result = linearTranslator.describeRequest(
      {
        kind: 'create',
        localId: 'LP-1',
        fields: {
          type: 'user_story',
          title: 'Story',
          body: 'body',
          status: 'in_progress',
          assignee: null,
          attributes: { story_points: 5 },
        },
      },
      mapping,
      attributes,
    );
    expect(result.request).toMatchObject({
      kind: 'create',
      title: 'Story',
      body: 'body',
      state: 'In Progress',
      labels: expect.arrayContaining(['story', 'Points:5']),
    });
    expect(result.problems).toEqual([]);
  });

  it('recovers board fields from a Linear record', () => {
    const record = {
      title: 'Story',
      description: 'body',
      state: { name: 'Done', type: 'completed' },
      labels: [{ name: 'story' }],
      assignee: null,
    };
    const result = linearTranslator.fieldsFromRecord(
      record,
      mapping,
      attributes,
      new Map(),
      new Map(),
    );
    expect(result.patch).toMatchObject({
      title: 'Story',
      body: 'body',
      type: 'user_story',
      status: 'done',
    });
  });
});

describe('the Linear relation seams', () => {
  it('reads the native parent and both edge kinds (LP-334 direction)', () => {
    const record = {
      parent: { id: '42' },
      // `relations` is the source side: this issue (99) blocks 30 and relates
      // to 11 — neither of those is a *dependency* of 99.
      relations: {
        nodes: [
          { id: 'r1', type: 'blocks', issue: { id: '99' }, relatedIssue: { id: '30' } },
          { id: 'r2', type: 'related', issue: { id: '99' }, relatedIssue: { id: '11' } },
        ],
      },
      // `inverseRelations` is the target side: 10 blocks 99, 12 relates to 99.
      inverseRelations: {
        nodes: [
          { id: 'r3', type: 'blocks', issue: { id: '10' }, relatedIssue: { id: '99' } },
          { id: 'r4', type: 'related', issue: { id: '12' }, relatedIssue: { id: '99' } },
        ],
      },
    };
    expect(linearParentIdOf(record)).toBe('42');
    // depends_on reads the blocker from `inverseRelations` — 30 is *blocked by*
    // this issue, so it must not appear.
    expect(linearDependsOnOf(record)).toEqual(['10']);
    // relates_to reads both sides of every `related` relation.
    expect(linearRelatesToOf(record)).toEqual(['11', '12']);
  });
});

describe('the Linear effort ↔ estimate mapping (LP-333)', () => {
  // The effort attribute is double-mapped — once to `estimate`, once to the
  // `Points` label prefix — to prove the native field wins and the label is
  // not written twice.
  const mapping = {
    types: { user_story: { remote: 'story' } },
    statuses: { backlog: { remote: ['Backlog'] }, done: { remote: ['Done'], closed: true } },
    effort: { attribute: 'story_points' },
    attributes: { story_points: 'Points' },
  };
  const attributes: AttributeDefs = { story_points: { type: 'int' } };

  it('writes the effort attribute as the native estimate, not a label', () => {
    const result = linearTranslator.describeRequest(
      {
        kind: 'create',
        localId: 'LP-1',
        fields: {
          type: 'user_story',
          title: 'Story',
          body: 'body',
          status: 'backlog',
          attributes: { story_points: 5 },
        },
      },
      mapping,
      attributes,
    );
    expect(result.request.estimate).toBe(5);
    expect(result.request.labels).not.toContain('Points:5');
    expect(result.request.labels).toContain('story');
    expect(result.problems).toEqual([]);
  });

  it('clears the estimate when the effort attribute is unset', () => {
    const result = linearTranslator.describeRequest(
      {
        kind: 'create',
        localId: 'LP-1',
        fields: { type: 'user_story', title: 'Story', body: 'body', status: 'backlog', attributes: {} },
      },
      mapping,
      attributes,
    );
    expect(result.request.estimate).toBeNull();
  });

  it('reports a non-numeric effort value instead of rounding it', () => {
    const result = linearTranslator.describeRequest(
      {
        kind: 'create',
        localId: 'LP-1',
        fields: {
          type: 'user_story',
          title: 'Story',
          body: 'body',
          status: 'backlog',
          attributes: { story_points: 'five' },
        },
      },
      mapping,
      attributes,
    );
    expect(result.request.estimate).toBeUndefined();
    expect(result.problems).toEqual([
      expect.objectContaining({ attribute: 'story_points', direction: 'push' }),
    ]);
  });

  it('recovers the estimate back into the effort attribute', () => {
    const record = {
      title: 'Story',
      description: 'body',
      state: { name: 'Done', type: 'completed' },
      labels: [{ name: 'story' }],
      estimate: 8,
    };
    const result = linearTranslator.fieldsFromRecord(
      record,
      mapping,
      attributes,
      new Map(),
      new Map(),
    );
    expect(result.patch.attributes).toEqual({ story_points: 8 });
  });

  it('leaves the effort attribute unset when the record carries no estimate', () => {
    const result = linearTranslator.fieldsFromRecord(
      { title: 'Story', description: 'body', state: { name: 'Done', type: 'completed' }, labels: [{ name: 'story' }], estimate: null },
      mapping,
      attributes,
      new Map(),
      new Map(),
    );
    expect(result.patch.attributes).toBeUndefined();
  });
});

describe('the Linear connector fetches the team schema (LP-333)', () => {
  const CONNECTION = { team: 'ENG', base_url: 'https://api.linear.app' };

  it('workflowStates() asks for the team states with their type', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      expect(body.query).toContain('states(first: 250) { nodes { id name type } }');
      expect(body.variables).toEqual({ teamId: 'ENG' });
      return new Response(
        JSON.stringify({
          data: {
            team: {
              states: {
                nodes: [
                  { id: 's1', name: 'Backlog', type: 'backlog' },
                  { id: 's2', name: 'Done', type: 'completed' },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetch);

    const connector = linearConnector(CONNECTION);
    expect(await connector.workflowStates!()).toEqual([
      { id: 's1', name: 'Backlog', type: 'backlog' },
      { id: 's2', name: 'Done', type: 'completed' },
    ]);
  });

  it('estimateScale() asks for the team estimation settings', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      expect(body.query).toContain('issueEstimationType issueEstimationAllowZero issueEstimationExtended');
      expect(body.variables).toEqual({ teamId: 'ENG' });
      return new Response(
        JSON.stringify({
          data: {
            team: {
              issueEstimationType: 'fibonacci',
              issueEstimationAllowZero: false,
              issueEstimationExtended: true,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetch);

    const connector = linearConnector(CONNECTION);
    expect(await connector.estimateScale!()).toEqual({
      type: 'fibonacci',
      allowZero: false,
      extended: true,
    });
  });
});

describe('the Linear estimate round-trip (LP-333)', () => {
  const mapping = {
    types: { user_story: { remote: 'story' } },
    statuses: {
      backlog: { remote: ['Backlog'] },
      done: { remote: ['Done'], closed: true },
    },
    effort: { attribute: 'story_points' },
  };
  const entry: ConformanceEntry = {
    name: 'linear',
    provider: linearProvider,
    connection: { team: 'ENG', base_url: 'https://api.linear.app' },
    mapping,
    pull: providerPull(linearProvider, mapping, {
      parentIdOf: linearParentIdOf,
      dependsOnOf: linearDependsOnOf,
      relatesToOf: linearRelatesToOf,
    }),
    recordsOf: (tracker: MemoryConnector) => tracker.linearRecords(),
    remoteIdOf: (record: RemoteRecord) => String(record.id ?? ''),
  };

  it('pushes the effort attribute as the native estimate and pulls a Linear change back', async () => {
    const h = await buildHarness(entry);
    const { story } = plantTree(h.paths);
    const stale = h.reload();
    updateNode(stale, stale.byId.get(story.id)!, { attributes: { story_points: 5 } });

    const board = h.reload();
    const pushed = await executePush(
      board,
      h.opened,
      h.connector,
      h.store,
      planPush(h.view(), h.store, h.snapshot()).ops,
    );
    expect(pushed.failed).toEqual([]);

    const remoteId = h.store.links.get(story.id)!.remoteId;
    expect(h.tracker.issues().get(Number(remoteId))?.estimate).toBe(5);

    // A human changes the estimate in Linear; the pull recovers it as the
    // board's effort attribute.
    h.tracker.mutateIssue(remoteId, { estimate: 8 });
    const pullPlan = planPull(h.view(), h.store, h.snapshot(), h.pullOptions);
    expect(pullPlan.changes).toContainEqual({
      kind: 'update',
      id: story.id,
      nodeKind: 'issue',
      patch: { attributes: { story_points: 8 } },
    });
    const applied = applyPull(h.paths, 'linear', h.store, pullPlan);
    expect(applied.failures).toEqual([]);
    expect(h.reload().byId.get(story.id)!.attributes.story_points).toBe(8);
  });
});
