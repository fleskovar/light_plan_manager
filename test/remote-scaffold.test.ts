import { describe, expect, it } from 'vitest';
import { parseConfigText } from '../src/core/index.js';
import type { BoardConfig } from '../src/core/index.js';
import type { ResolvedCapabilities } from '../src/remote/capabilities.js';
import { findMarkers, isMarker, MARKER_PREFIX, scaffoldMapping } from '../src/remote/scaffold.js';
import { openRemote } from '../src/remote/remotes.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOARD = `
version: 1
key_prefix: LP
statuses:
  - id: backlog
    label: Backlog
  - id: in_progress
    label: In Progress
    active: true
  - id: done
    label: Done
    terminal: true
default_status: backlog
hierarchy:
  - epic
  - [user_story, bug]
issue_types:
  epic:
    label: Epic
  user_story:
    label: User Story
    attributes:
      priority:
        type: enum
        values: [high, medium, low]
      story_points:
        type: int
      notes:
        type: text
  bug:
    label: Bug
period_prefix: TL
period_hierarchy:
  - increment
  - sprint
period_types:
  increment:
    label: Increment
  sprint:
    label: Sprint
resource_prefix: RS
resource_hierarchy:
  - person
resource_types:
  person:
    label: Person
    attributes:
      github:
        type: string
      email:
        type: string
`;

function board(): BoardConfig {
  const { config, errors } = parseConfigText(BOARD);
  expect(errors).toEqual([]);
  return config!;
}

/** GitHub's resolved capability table, one cell overridable at a time. */
function capabilities(overrides: Partial<ResolvedCapabilities> = {}): ResolvedCapabilities {
  return {
    hierarchyDepth: 1,
    nativeTypes: false,
    status: { kind: 'binary', open: 'open', closed: 'closed' },
    edges: { dependsOn: false, relatesTo: false },
    customFields: null,
    provisioning: { customFields: false, periods: false, labels: true },
    periods: { native: true, creatable: true },
    comments: { native: true, editable: true, deletable: true },
    incrementalRead: { kind: 'since' },
    vocabulary: 'fixed',
    ...overrides,
  };
}

function githubConfig(mappingText: string): ReturnType<typeof parseConfigText> {
  const indented = mappingText
    .trimEnd()
    .split('\n')
    .map((line) => (line === '' ? '' : `      ${line}`))
    .join('\n');
  return parseConfigText(`${BOARD}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
${indented}
`);
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

describe('findMarkers / isMarker', () => {
  it('recognises a marker string and nothing else', () => {
    expect(isMarker(`${MARKER_PREFIX} choose a thing`)).toBe(true);
    expect(isMarker('Done')).toBe(false);
    expect(isMarker('TODO-ish')).toBe(false);
    expect(isMarker(42)).toBe(false);
    expect(isMarker(null)).toBe(false);
  });

  it('walks objects and arrays, reporting dot paths in sorted-key order', () => {
    const mapping = {
      statuses: { done: { remote: ['Done'] }, backlog: { remote: [`${MARKER_PREFIX} name a state`] } },
      types: { epic: { remote: 'epic' } },
      accounts: { via: `${MARKER_PREFIX} name the attribute` },
    };
    expect(findMarkers(mapping)).toEqual([
      { path: 'accounts.via', question: 'name the attribute' },
      // A status may list several remote states, so the path carries the index
      // of the one still unanswered — the array walk this fixture exists for.
      { path: 'statuses.backlog.remote.0', question: 'name a state' },
    ]);
  });

  it('returns nothing for a fully resolved mapping', () => {
    expect(findMarkers({ statuses: { done: { remote: ['Done'] } } })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scaffoldMapping — coverage and decisions
// ---------------------------------------------------------------------------

describe('scaffoldMapping', () => {
  it('covers types, statuses, attributes, resources and periods', () => {
    const { mapping } = scaffoldMapping(board(), capabilities(), { provider: 'github' });

    expect(Object.keys(mapping).sort()).toEqual([
      'accounts',
      'attributes',
      'periods',
      'statuses',
      'types',
    ]);

    // One key, whatever the carrier — the same shape the statuses use.
    expect(mapping.types).toEqual({
      epic: { remote: 'epic' },
      user_story: { remote: 'user_story' },
      bug: { remote: 'bug' },
    });
    expect(mapping.statuses).toEqual({
      backlog: { remote: 'Backlog', closed: false },
      in_progress: { remote: 'In Progress', closed: false },
      done: { remote: 'Done', closed: true },
    });
    // `notes` is a text attribute: it has no home, so it is not mapped.
    expect(mapping.attributes).toEqual({ priority: 'Priority', story_points: 'StoryPoints' });
    expect(mapping.accounts).toEqual({ via: 'github' });
    expect(mapping.periods).toEqual({ container: 'sprint' });
  });

  it('maps a status with an obvious counterpart; marks one without, never guessing', () => {
    const binary = scaffoldMapping(board(), capabilities());
    expect(binary.markers).toEqual([]);

    const states = scaffoldMapping(board(), capabilities({ status: { kind: 'states' } }));
    expect(states.markers.map((m) => m.path)).toEqual([
      'statuses.backlog.remote',
      'statuses.done.remote',
      'statuses.in_progress.remote',
    ]);
    // `closed` still follows the board's terminal flag.
    expect(states.mapping.statuses).toMatchObject({
      done: { closed: true },
      backlog: { closed: false },
    });
  });

  it('marks a native issue type whose name only the platform knows', () => {
    const native = scaffoldMapping(board(), capabilities({ nativeTypes: true }));
    expect(native.markers.map((m) => m.path)).toEqual([
      'types.bug.remote',
      'types.epic.remote',
      'types.user_story.remote',
    ]);
  });

  it('names a native type itself when the vocabulary is ours to write', () => {
    // `jsonfile` creates the tracker, so there is no existing type name to
    // discover and nothing to ask about.
    const open = scaffoldMapping(board(), capabilities({ nativeTypes: true, vocabulary: 'open' }));
    expect(open.mapping.types).toEqual({
      epic: { remote: 'epic' },
      user_story: { remote: 'user_story' },
      bug: { remote: 'bug' },
    });
    expect(open.markers.filter((m) => m.path.startsWith('types.'))).toEqual([]);
  });

  it('assigns an attribute with no home to the managed block, with the cost on the line', () => {
    const { mapping, text } = scaffoldMapping(board(), capabilities());
    // `notes` (text) is not in the mapping — it rides the managed block.
    expect(mapping.attributes).not.toHaveProperty('notes');
    expect(text).toContain('# notes: Notes  # no native or provisionable home');
    expect(text).toContain('managed block (rung 4)');
  });

  it('names a custom-field home when the provider holds custom fields', () => {
    const { mapping, text } = scaffoldMapping(
      board(),
      capabilities({ customFields: { valueTypes: ['number', 'text'] } }),
    );
    // With custom fields, attributes do not need a label prefix.
    expect(mapping.attributes).toEqual({});
    expect(text).toContain('provisionable as a custom field (rung 2)');
  });

  it('guesses the account attribute from the provider name, else a known candidate, else a marker', () => {
    expect(scaffoldMapping(board(), capabilities(), { provider: 'github' }).mapping.accounts).toEqual({
      via: 'github',
    });
    expect(scaffoldMapping(board(), capabilities()).mapping.accounts).toEqual({ via: 'email' });

    const noStringAttrs = scaffoldMapping(board(), capabilities(), { provider: 'linear' });
    // "linear" is not a declared resource attribute; `email` is, and beats a marker.
    expect(noStringAttrs.mapping.accounts).toEqual({ via: 'email' });
  });

  it('marks the account attribute when no candidate is obvious', () => {
    const config = board();
    // Drop the string-typed resource attributes entirely.
    config.resource_types = { person: { label: 'Person', attributes: {}, body: '' } };
    const { mapping, markers } = scaffoldMapping(config, capabilities());
    expect(markers.map((m) => m.path)).toEqual(['accounts.via']);
    expect(isMarker((mapping.accounts as { via: string }).via)).toBe(true);
  });

  it('omits a block the provider schema does not declare, however answerable it is', () => {
    // Both answers are there in the board config — a `github` account attribute
    // and a `sprint` period level — and a provider whose schema declares
    // neither key would have the block stripped on the way in. Drafting it
    // would write a mapping into config.yml that can never take effect, which
    // is how `jsonfile` came to carry `periods: { container: sprint }` for a
    // tracker with no container at all.
    const { mapping, text } = scaffoldMapping(board(), capabilities(), {
      provider: 'github',
      mappingKeys: ['types', 'statuses', 'attributes'],
    });
    expect(Object.keys(mapping).sort()).toEqual(['attributes', 'statuses', 'types']);
    expect(text).not.toContain('accounts');
    expect(text).not.toContain('periods');
    // The three blocks every provider shares are still drafted.
    expect(mapping.types).toBeTruthy();
    expect(mapping.statuses).toBeTruthy();
  });

  it('drafts every block when no provider schema is given', () => {
    const { mapping } = scaffoldMapping(board(), capabilities(), { provider: 'github' });
    expect(mapping).toHaveProperty('accounts');
    expect(mapping).toHaveProperty('periods');
  });

  it('omits accounts and periods when the board declares neither', () => {
    const config = board();
    config.resource_types = {};
    config.period_types = {};
    config.period_hierarchy = [];
    const { mapping } = scaffoldMapping(config, capabilities());
    expect(mapping).not.toHaveProperty('accounts');
    expect(mapping).not.toHaveProperty('periods');
  });

  it('emits YAML that parses back to the same mapping object', () => {
    const { mapping, text } = scaffoldMapping(board(), capabilities(), { provider: 'github' });
    const parsed = parseConfigText(`${BOARD}
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
${text
  .split('\n')
  .map((line) => `      ${line}`)
  .join('\n')}
`);
    expect(parsed.errors).toEqual([]);
    expect(parsed.config!.remotes.upstream!.mapping).toEqual(mapping);
  });
});

// ---------------------------------------------------------------------------
// Markers block opening the remote (acceptance criterion 4)
// ---------------------------------------------------------------------------

describe('openRemote refuses an unresolved scaffold', () => {
  it('opens a scaffold with no markers, unchanged', () => {
    const { text } = scaffoldMapping(board(), capabilities(), { provider: 'github' });
    const { config, errors } = githubConfig(text);
    expect(errors).toEqual([]);
    const opened = openRemote(config!, 'upstream');
    expect(opened.mapping.statuses).toMatchObject({ done: { closed: true } });
  });

  it('fails naming every marker when one is left unresolved', () => {
    const states = scaffoldMapping(board(), capabilities({ status: { kind: 'states' } }));
    const { config, errors } = githubConfig(states.text);
    // The marker strings are plain YAML values, so the config still parses;
    // the refusal is `openRemote`'s, before the provider schema runs.
    expect(errors).toEqual([]);

    let message = '';
    let details: string[] = [];
    try {
      openRemote(config!, 'upstream');
    } catch (error) {
      message = (error as Error).message;
      details = (error as { details?: string[] }).details ?? [];
    }
    expect(message).toContain('unresolved markers');
    expect(details).toEqual([
      'remotes.upstream.mapping.statuses.backlog.remote: TODO: choose the remote state for board status "Backlog"',
      'remotes.upstream.mapping.statuses.done.remote: TODO: choose the remote state for board status "Done"',
      'remotes.upstream.mapping.statuses.in_progress.remote: TODO: choose the remote state for board status "In Progress"',
    ]);
  });
});
