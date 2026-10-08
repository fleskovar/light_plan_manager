/**
 * LP-327 — discover custom fields by name, and report what an admin must change.
 *
 * Four halves, mirroring `test/remote-jira-types.test.ts`:
 *
 *   - the pure discovery logic (`fields.ts`): parse the field list, resolve a
 *     `mapping.attributes` name to a `customfield_*` id, detect an ambiguous
 *     name, and check a field's type against the board attribute type;
 *   - the pure screen + report logic: a field not on a mapped issue type's
 *     create screen is reported, and the report ends with a copy-pasteable
 *     administrator-request list;
 *   - the cache and provision path: `resolveFieldIds` writes/reads
 *     `.lpm/remotes/<name>/jira.json`, and `planFieldProvision` +
 *     `provisionFields` create fields and add them to the screen;
 *   - the connector (fetch stubbed, exactly as `remote-jira.test.ts`): `fields()`
 *     lists the instance's custom fields, `createMeta()` reads the create-screen
 *     metadata, `createField` / `addFieldToScreen` provision, and
 *     `probe('custom_fields')` answers the capability.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardError } from '../src/core/errors.js';
import { jiraConnector } from '../src/remote/providers/jira/connector.js';
import {
  adminRequests,
  customFieldTypeFor,
  fieldFitsAttribute,
  fieldProblems,
  isCustomFieldId,
  loadFieldCache,
  missingFromScreens,
  parseFields,
  planFieldProvision,
  preflightFields,
  provisionFields,
  resolveAttributeField,
  resolveFieldIds,
  validateFieldMapping,
  type FieldProvisionPlan,
  type JiraField,
} from '../src/remote/providers/jira/fields.js';
import type { AttributeDefs } from '../src/remote/provider.js';
import { cleanupBoards, makeBoard } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

afterEach(cleanupBoards);

const SITE = 'https://acme.atlassian.net';
const CONNECTION = { site: SITE, project: 'PAY', email: 'me@acme.com', token: 'api-token' };

/** The attribute definitions the reports are computed against. */
const ATTRS: AttributeDefs = {
  story_points: { type: 'int' },
  impact: { type: 'text' },
  budget: { type: 'string' },
  target_date: { type: 'date' },
  severity: { type: 'enum', values: ['low', 'medium', 'high'] },
  components: { type: 'array' },
  released: { type: 'bool' },
};

/** A custom field in the shape `GET /rest/api/3/field` returns. */
function field(overrides: Partial<JiraField> & { id: string; name: string }): JiraField {
  return {
    custom: true,
    schemaType: 'string',
    customType: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
    ...overrides,
  };
}

/** The classic story-points-style field list, with one ambiguous duplicate name. */
const FIELDS: JiraField[] = [
  field({ id: 'customfield_10016', name: 'Story Points', schemaType: 'number', customType: 'com.atlassian.jira.plugin.system.customfieldtypes:float' }),
  field({ id: 'customfield_10032', name: 'Story Points', schemaType: 'number', customType: 'com.atlassian.jira.plugin.system.customfieldtypes:float' }),
  field({ id: 'customfield_10020', name: 'Impact' }),
  field({ id: 'customfield_10021', name: 'Target Date', schemaType: 'date', customType: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker' }),
  field({ id: 'customfield_10022', name: 'Severity', schemaType: 'option', customType: 'com.atlassian.jira.plugin.system.customfieldtypes:select' }),
  field({ id: 'customfield_10023', name: 'Components', schemaType: 'array', customType: 'com.atlassian.jira.plugin.system.customfieldtypes:multiselect' }),
];

/** A message + its hints, flattened for assertions. */
function messageOf(error: unknown): string {
  return error instanceof BoardError ? `${error.message}\n${error.details.join('\n')}` : String(error);
}

// ---------------------------------------------------------------------------
// The pure discovery logic
// ---------------------------------------------------------------------------

describe('parseFields', () => {
  it('trims the raw field list to id, name, custom flag and schema facts', () => {
    const parsed = parseFields([
      { id: 'customfield_10016', name: 'Story Points', custom: true, schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' } },
      { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string', system: 'summary' } },
      { id: 'customfield_10020', name: 'Impact', custom: true, schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } },
    ]);

    expect(parsed).toEqual([
      { id: 'customfield_10016', name: 'Story Points', custom: true, schemaType: 'number', customType: 'com.atlassian.jira.plugin.system.customfieldtypes:float' },
      { id: 'summary', name: 'Summary', custom: false, schemaType: 'string', customType: '' },
      { id: 'customfield_10020', name: 'Impact', custom: true, schemaType: 'string', customType: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' },
    ]);
  });

  it('drops entries with no id or no name', () => {
    expect(parseFields([{ name: 'No id' }, { id: 'customfield_1' }, { id: '', name: '' }])).toEqual([]);
  });
});

describe('isCustomFieldId', () => {
  it('recognises a customfield id and not a name', () => {
    expect(isCustomFieldId('customfield_10016')).toBe(true);
    expect(isCustomFieldId('customfield_10016 ')).toBe(true);
    expect(isCustomFieldId('Story Points')).toBe(false);
    expect(isCustomFieldId('summary')).toBe(false);
  });
});

describe('fieldFitsAttribute', () => {
  it('maps the board attribute types onto the Jira schema shapes', () => {
    expect(fieldFitsAttribute('string', field({ id: 'f', name: 'n' }))).toBe(true);
    expect(fieldFitsAttribute('text', field({ id: 'f', name: 'n' }))).toBe(true);
    expect(fieldFitsAttribute('int', field({ id: 'f', name: 'n', schemaType: 'number' }))).toBe(true);
    expect(fieldFitsAttribute('float', field({ id: 'f', name: 'n', schemaType: 'number' }))).toBe(true);
    expect(fieldFitsAttribute('date', field({ id: 'f', name: 'n', schemaType: 'date' }))).toBe(true);
    expect(fieldFitsAttribute('date', field({ id: 'f', name: 'n', schemaType: 'datetime' }))).toBe(true);
    expect(fieldFitsAttribute('enum', field({ id: 'f', name: 'n', schemaType: 'option' }))).toBe(true);
    expect(fieldFitsAttribute('array', field({ id: 'f', name: 'n', schemaType: 'array' }))).toBe(true);
  });

  it('refuses a mismatch, and bool has no Jira field type at all', () => {
    expect(fieldFitsAttribute('int', field({ id: 'f', name: 'n' }))).toBe(false);
    expect(fieldFitsAttribute('enum', field({ id: 'f', name: 'n' }))).toBe(false);
    expect(fieldFitsAttribute('bool', field({ id: 'f', name: 'n', schemaType: 'option' }))).toBe(false);
    expect(customFieldTypeFor('bool')).toBeUndefined();
  });
});

describe('resolveAttributeField', () => {
  it('passes a customfield id through', () => {
    expect(resolveAttributeField('customfield_10016', FIELDS)).toEqual({
      status: 'id',
      id: 'customfield_10016',
      field: FIELDS[0],
    });
  });

  it('resolves a unique name', () => {
    expect(resolveAttributeField('Impact', FIELDS)).toEqual({ status: 'resolved', field: FIELDS[2] });
  });

  it('reports two fields that share a name, with both ids', () => {
    const resolution = resolveAttributeField('Story Points', FIELDS);
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status === 'ambiguous') {
      expect(resolution.fields.map((f) => f.id)).toEqual(['customfield_10016', 'customfield_10032']);
    }
  });

  it('reports a name the instance does not have', () => {
    expect(resolveAttributeField('Budget', FIELDS)).toEqual({ status: 'missing', name: 'Budget' });
  });
});

describe('validateFieldMapping', () => {
  it('resolves every mapping entry and flags a type mismatch', () => {
    const report = validateFieldMapping(
      {
        attributes: {
          story_points: 'Story Points',
          impact: 'Impact',
          target_date: 'Target Date',
          severity: 'Severity',
          components: 'Components',
          released: 'customfield_10020', // a text field, but bool needs none
        },
      },
      FIELDS,
      ATTRS,
    );

    const byAttribute = new Map(report.entries.map((e) => [e.attribute, e]));
    expect(byAttribute.get('story_points')!.resolution.status).toBe('ambiguous');
    expect(byAttribute.get('impact')!.resolution.status).toBe('resolved');
    expect(byAttribute.get('impact')!.typeMismatch).toBe(false);
    expect(byAttribute.get('target_date')!.typeMismatch).toBe(false);
    expect(byAttribute.get('severity')!.typeMismatch).toBe(false);
    expect(byAttribute.get('components')!.typeMismatch).toBe(false);
    // `released` is bool mapped onto a text field id — a mismatch, reported.
    expect(byAttribute.get('released')!.typeMismatch).toBe(true);
  });

  it('ignores mapping entries that carry no string value', () => {
    const report = validateFieldMapping({ attributes: { story_points: '' } }, FIELDS, ATTRS);
    expect(report.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The screen check and the report
// ---------------------------------------------------------------------------

describe('missingFromScreens', () => {
  const REPORT = validateFieldMapping(
    { attributes: { impact: 'Impact', target_date: 'Target Date' } },
    FIELDS,
    ATTRS,
  );

  it('names the issue types whose create screen lacks a resolved field', () => {
    const meta = new Map<string, Set<string>>([
      ['Story', new Set(['summary', 'customfield_10020'])],
      ['Epic', new Set(['summary', 'customfield_10020', 'customfield_10021'])],
    ]);

    const absences = missingFromScreens(REPORT, meta, ['Story', 'Epic']);
    expect(absences).toEqual([
      {
        attribute: 'target_date',
        fieldId: 'customfield_10021',
        fieldName: 'Target Date',
        missingFrom: ['Story'],
      },
    ]);
  });

  it('reports nothing when every field is on every mapped type screen', () => {
    const meta = new Map<string, Set<string>>([
      ['Story', new Set(['customfield_10020', 'customfield_10021'])],
    ]);
    expect(missingFromScreens(REPORT, meta, ['Story'])).toEqual([]);
  });
});

describe('fieldProblems', () => {
  const REPORT = validateFieldMapping(
    {
      attributes: {
        story_points: 'Story Points',
        budget: 'Budget',
        released: 'customfield_10020',
      },
    },
    FIELDS,
    ATTRS,
  );
  const SCREEN: Parameters<typeof fieldProblems>[1] = [
    { attribute: 'released', fieldId: 'customfield_10020', fieldName: 'Impact', missingFrom: ['Epic'] },
  ];

  it('turns an ambiguous name into an error naming both ids', () => {
    const problems = fieldProblems(REPORT, [], 'jira', 'config.yml');
    const ambiguous = problems.find((p) => p.message.includes('Story Points'));
    expect(ambiguous!.level).toBe('error');
    expect(ambiguous!.message).toContain('customfield_10016, customfield_10032');
    expect(ambiguous!.message).toContain('write the id you mean');
  });

  it('turns a missing name into an error naming the list the instance has', () => {
    const problems = fieldProblems(REPORT, [], 'jira', 'config.yml');
    const missing = problems.find((p) => p.message.includes('Budget'));
    expect(missing!.level).toBe('error');
    expect(missing!.message).toContain('no custom field named "Budget"');
    expect(missing!.message).toContain('the instance has: Components, Impact, Severity, Story Points, Story Points, Target Date');
  });

  it('turns a type mismatch and a screen absence into errors', () => {
    const problems = fieldProblems(REPORT, SCREEN, 'jira', 'config.yml');
    const mismatch = problems.find((p) => p.message.includes('cannot carry a bool'));
    expect(mismatch!.level).toBe('error');
    expect(mismatch!.message).toContain('the field "Impact" (customfield_10020)');

    const screen = problems.find((p) => p.message.includes('not on the create screen'));
    expect(screen!.level).toBe('error');
    expect(screen!.message).toContain('Epic');
  });
});

describe('adminRequests', () => {
  const REPORT = validateFieldMapping(
    { attributes: { story_points: 'Story Points', budget: 'Budget', released: 'customfield_10020' } },
    FIELDS,
    ATTRS,
  );
  const SCREEN: Parameters<typeof adminRequests>[1] = [
    { attribute: 'released', fieldId: 'customfield_10020', fieldName: 'Impact', missingFrom: ['Epic'] },
  ];

  it('ends with a copy-pasteable request per gap, naming the project and the type', () => {
    const requests = adminRequests(REPORT, SCREEN, 'jira', 'PAY');

    const createBudget = requests.find((r) => r.includes('Budget'))!;
    expect(createBudget).toContain('Create a custom field named "Budget"');
    expect(createBudget).toContain('Text Field (single line)');
    expect(createBudget).toContain('project PAY');

    const disambiguate = requests.find((r) => r.includes('Disambiguate'))!;
    expect(disambiguate).toContain('customfield_10016');
    expect(disambiguate).toContain('customfield_10032');
    expect(disambiguate).toContain('remotes.jira.mapping.attributes.story_points');

    const addToScreen = requests.find((r) => r.includes('customfield_10020') && r.startsWith('Add '))!;
    expect(addToScreen).toContain('customfield_10020');
    expect(addToScreen).toContain('Epic');
    expect(addToScreen).toContain('project PAY');
  });
});

// ---------------------------------------------------------------------------
// Provision
// ---------------------------------------------------------------------------

describe('planFieldProvision and provisionFields', () => {
  const REPORT = validateFieldMapping(
    { attributes: { budget: 'Budget', released: 'customfield_10020' } },
    FIELDS,
    ATTRS,
  );
  const SCREEN: Parameters<typeof planFieldProvision>[1] = [
    { attribute: 'released', fieldId: 'customfield_10020', fieldName: 'Impact', missingFrom: ['Epic'] },
  ];

  it('plans a missing creatable field and an off-screen field, and skips an ambiguous name', () => {
    const plan = planFieldProvision(REPORT, SCREEN);
    expect(plan.create).toEqual([
      { attribute: 'budget', name: 'Budget', typeKey: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield', label: 'Text Field (single line)' },
    ]);
    expect(plan.addToScreen).toEqual(['customfield_10020']);
    expect(plan.empty).toBe(false);
  });

  it('creates the missing field and adds it and the off-screen field to the screen', async () => {
    const plan: FieldProvisionPlan = {
      create: [{ attribute: 'budget', name: 'Budget', typeKey: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield', label: 'Text Field (single line)' }],
      addToScreen: ['customfield_10020'],
      empty: false,
    };

    const created: string[] = [];
    const added: string[] = [];
    const result = await provisionFields(
      {
        name: 'jira',
        createField: async (name) => {
          created.push(name);
          return { id: 'customfield_10099' };
        },
        addFieldToScreen: async (id) => {
          added.push(id);
        },
      },
      plan,
    );

    expect(result.created).toEqual([{ attribute: 'budget', id: 'customfield_10099' }]);
    expect(created).toEqual(['Budget']);
    // The fresh field and the pre-existing off-screen field are both added.
    expect(result.addedToScreen).toEqual(['customfield_10020', 'customfield_10099']);
    expect(added).toEqual(['customfield_10099', 'customfield_10020']);
  });

  it('refuses when the connector cannot provision', async () => {
    await expect(provisionFields({ name: 'jira' }, { create: [], addToScreen: [], empty: true })).rejects.toThrow(
      /cannot provision custom fields/,
    );
  });
});

// ---------------------------------------------------------------------------
// The committed cache
// ---------------------------------------------------------------------------

describe('resolveFieldIds cache', () => {
  it('resolves once, caches under jira.json, and reads the cache on the next call', async () => {
    const paths = makeBoard('blank', 'LP');
    const listFields = vi.fn(async () => FIELDS);
    const connector = { name: 'jira', fields: listFields };

    const first = await resolveFieldIds(connector, paths, 'jira');
    expect(first.refreshed).toBe(true);
    expect(first.fields).toEqual(FIELDS);
    expect(listFields).toHaveBeenCalledTimes(1);

    // The cache is on disk and reads back.
    const cached = loadFieldCache(paths, 'jira');
    expect(cached!.fields).toEqual(FIELDS);
    expect(cached!.version).toBe(1);

    // A second resolution is a read, not a re-fetch.
    const second = await resolveFieldIds(connector, paths, 'jira');
    expect(second.refreshed).toBe(false);
    expect(listFields).toHaveBeenCalledTimes(1);

    // --refresh re-resolves.
    const third = await resolveFieldIds(connector, paths, 'jira', { refresh: true });
    expect(third.refreshed).toBe(true);
    expect(listFields).toHaveBeenCalledTimes(2);
  });

  it('refuses when the connector cannot list fields', async () => {
    const paths = makeBoard('blank', 'LP');
    await expect(resolveFieldIds({ name: 'jira' }, paths, 'jira')).rejects.toThrow(
      /cannot list custom fields/,
    );
  });
});

// ---------------------------------------------------------------------------
// The live preflight
// ---------------------------------------------------------------------------

describe('preflightFields', () => {
  const MAPPING = {
    types: { user_story: { remote: 'Story' }, epic: { remote: 'Epic' } },
    attributes: { story_points: 'Story Points', impact: 'Impact' },
  };

  it('fetches fields and screen metadata and reports the gaps', async () => {
    const problems = await preflightFields(
      {
        name: 'jira',
        fields: async () => FIELDS,
        createMeta: async () =>
          new Map<string, Set<string>>([
            ['Story', new Set(['summary', 'customfield_10020', 'customfield_10016'])],
            ['Epic', new Set(['summary'])],
          ]),
      },
      MAPPING,
      ATTRS,
      'jira',
      'config.yml',
    );

    const messages = problems.map((p) => p.message);
    expect(messages).toContain(
      'remotes.jira.mapping.attributes.story_points: the name "Story Points" matches 2 custom fields (customfield_10016, customfield_10032) — write the id you mean, not the name',
    );
    expect(messages.some((m) => m.includes('impact') && m.includes('not on the create screen of Epic'))).toBe(true);
    expect(problems.every((p) => p.level === 'error')).toBe(true);
  });

  it('is a no-op when the connector exposes no field list', async () => {
    expect(await preflightFields({ name: 'jira' }, MAPPING, ATTRS, 'jira', 'config.yml')).toEqual([]);
  });

  it('reports nothing when every mapped field resolves, fits and is on screen', async () => {
    const problems = await preflightFields(
      {
        name: 'jira',
        fields: async () => FIELDS,
        createMeta: async () =>
          new Map<string, Set<string>>([
            ['Story', new Set(['summary', 'customfield_10020', 'customfield_10016'])],
            ['Epic', new Set(['summary', 'customfield_10020', 'customfield_10016'])],
          ]),
      },
      { types: { user_story: { remote: 'Story' } }, attributes: { impact: 'Impact' } },
      ATTRS,
      'jira',
      'config.yml',
    );
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The connector: fields, createMeta, provision, probe
// ---------------------------------------------------------------------------

/** A `fetch` stub routing the field, createmeta, create and screen endpoints. */
function fieldFetch(overrides: { fields?: unknown; meta?: Record<string, string[]> } = {}) {
  const fields =
    overrides.fields ??
    [
      { id: 'customfield_10016', name: 'Story Points', custom: true, schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' } },
      { id: 'customfield_10020', name: 'Impact', custom: true, schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } },
      { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string', system: 'summary' } },
    ];
  const meta = overrides.meta ?? { Story: ['summary', 'customfield_10016'], Epic: ['summary', 'customfield_10016'] };
  const issueTypes = Object.keys(meta).map((name, i) => ({ id: String(10000 + i), name }));

  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.endsWith('/rest/api/3/field') && method === 'GET') {
      return new Response(JSON.stringify(fields), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/rest/api/3/field') && method === 'POST') {
      return new Response(JSON.stringify({ id: 'customfield_10099', name: 'Budget' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/rest/api/3/screens/addToDefault/')) {
      return new Response('', { status: 200 });
    }
    if (url.endsWith('/issuetypes') && url.includes('/issue/createmeta/')) {
      return new Response(JSON.stringify({ issueTypes }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const metaMatch = /\/issue\/createmeta\/PAY\/issuetypes\/(\d+)$/.exec(url);
    if (metaMatch) {
      const type = issueTypes.find((t) => t.id === metaMatch[1])!;
      const fieldsList = (meta[type.name] ?? []).map((fieldId) => ({ fieldId, key: fieldId, name: fieldId, required: false, operations: ['set'] }));
      return new Response(JSON.stringify({ fields: fieldsList }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('jiraConnector: custom-field discovery (LP-327)', () => {
  it('lists only the instance custom fields, once per connector', async () => {
    const fetch = fieldFetch();
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION);
    const fields = await connector.fields();
    const again = await connector.fields();

    expect(fields.map((f) => f.id)).toEqual(['customfield_10016', 'customfield_10020']);
    expect(again).toBe(fields);
    // One GET /rest/api/3/field, shared by both calls.
    const fieldCalls = fetch.mock.calls.filter(([input]) => String(input).endsWith('/rest/api/3/field'));
    expect(fieldCalls).toHaveLength(1);
  });

  it('reads the create-screen field ids keyed by issue type', async () => {
    const fetch = fieldFetch();
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION);
    const meta = await connector.createMeta();

    expect(meta.get('Story')).toEqual(new Set(['summary', 'customfield_10016']));
    expect(meta.get('Epic')).toEqual(new Set(['summary', 'customfield_10016']));
  });

  it('answers the `custom_fields` probe with the value shapes it can hold', async () => {
    vi.stubGlobal('fetch', fieldFetch());
    const connector = jiraConnector(CONNECTION);
    expect(await connector.probe!('custom_fields')).toEqual({
      valueTypes: ['string', 'number', 'date', 'datetime', 'option', 'array'],
    });
  });

  it('creates a field and adds it to the default screen', async () => {
    const fetch = fieldFetch();
    vi.stubGlobal('fetch', fetch);

    const connector = jiraConnector(CONNECTION);
    const created = await connector.createField('Budget', 'com.atlassian.jira.plugin.system.customfieldtypes:textfield');
    expect(created.id).toBe('customfield_10099');

    await connector.addFieldToScreen('customfield_10099');

    const postCall = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    const sent = JSON.parse(String(postCall[1]!.body)) as { name: string; type: string };
    expect(sent).toEqual({ name: 'Budget', type: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' });

    const screenCalls = fetch.mock.calls.filter(([input]) => String(input).includes('/screens/addToDefault/'));
    expect(screenCalls).toHaveLength(1);
    expect(String(screenCalls[0]![0])).toContain('customfield_10099');
  });

  it('reports a permission denial when creating a field as a non-admin', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST' && String(input).endsWith('/rest/api/3/field')) {
        return new Response(
          JSON.stringify({ errorMessages: ['You do not have permission to create custom fields'] }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const connector = jiraConnector(CONNECTION);
    const message = await (async () => {
      try {
        await connector.createField('Budget', 'com.atlassian.jira.plugin.system.customfieldtypes:textfield');
        return null;
      } catch (error) {
        return messageOf(error);
      }
    })();

    expect(message).toContain('permission denied');
    expect(message).toContain('creating the custom field "Budget"');
  });
});
