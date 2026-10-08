import { describe, expect, it } from 'vitest';
import {
  type TypeMappings,
  mapTypeToRemote,
  claimedTypeValues,
  normalizeTypeMapping,
  normalizeTypeMappings,
  missingTypeMappings,
  mapTypeFromRemote,
  degradedHierarchyLevels,
  type RemoteTypeObservation,
  type StatusMappings,
  normalizeStatusMapping,
  normalizeStatusMappings,
  mapStatusToRemote,
  isClosedRemote,
  missingStatusMappings,
  mapStatusFromRemote,
  unmappedRemoteStates,
  statusClosednessMismatches,
} from '../src/remote/mapping.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The story's five-level board: program > epic > feature > (stories) > sub_task.
const HIERARCHY: string[][] = [
  ['program'],
  ['epic'],
  ['feature'],
  ['user_story', 'bug', 'test', 'review', 'research'],
  ['sub_task'],
];

const GITHUB_MAPPING: TypeMappings = {
  program: { remote: 'program' },
  epic: { remote: 'epic' },
  feature: { remote: 'feature' },
  user_story: { remote: 'story' },
  bug: { remote: 'bug' },
  test: { remote: 'test' },
  review: { remote: 'review' },
  research: { remote: 'research' },
  sub_task: { remote: 'sub-task' },
};

const JIRA_MAPPING: TypeMappings = {
  program: { remote: 'Initiative' },
  epic: { remote: 'Epic' },
  feature: { remote: 'Feature' },
  user_story: { remote: 'Story' },
  bug: { remote: 'Story' }, // shares an issue type with user_story
  test: { remote: 'Story' },
  review: { remote: 'Story' },
  research: { remote: 'Story' },
  sub_task: { remote: 'Sub-task' },
};

// ---------------------------------------------------------------------------
// normalizeTypeMapping — one name, however it was written
// ---------------------------------------------------------------------------

describe('normalizeTypeMapping', () => {
  it('accepts the bare name and the object form', () => {
    expect(normalizeTypeMapping('Story')).toEqual({ remote: 'Story' });
    expect(normalizeTypeMapping({ remote: 'Story' })).toEqual({ remote: 'Story' });
  });

  it('folds the superseded `type` and `labels` keys to the one name', () => {
    // A board written against the older two-carrier shape keeps meaning what it
    // meant: the carrier those keys named is the one the provider would pick.
    expect(normalizeTypeMapping({ type: 'Story' })).toEqual({ remote: 'Story' });
    expect(normalizeTypeMapping({ labels: ['story'] })).toEqual({ remote: 'story' });
  });

  it('keeps the native type when an older entry named both carriers', () => {
    // `{ type: Story, labels: [story] }` wrote "Story" into the native field
    // and "story" onto a label; the native name is the one that survives.
    expect(normalizeTypeMapping({ type: 'Story', labels: ['story'] })).toEqual({
      remote: 'Story',
    });
  });

  it('takes the first of a list, from back when types were many-valued', () => {
    expect(normalizeTypeMapping(['Story', 'User Story'])).toEqual({ remote: 'Story' });
    expect(normalizeTypeMapping({ remote: ['Story', 'User Story'] })).toEqual({ remote: 'Story' });
  });

  it('returns undefined for a value that names no remote type', () => {
    expect(normalizeTypeMapping({})).toBeUndefined();
    expect(normalizeTypeMapping('')).toBeUndefined();
    expect(normalizeTypeMapping([])).toBeUndefined();
    expect(normalizeTypeMapping(null)).toBeUndefined();
  });

  it('drops entries that normalize away, across the whole block', () => {
    expect(normalizeTypeMappings({ epic: 'Epic', ghost: {}, story: ['Story'] })).toEqual({
      epic: { remote: 'Epic' },
      story: { remote: 'Story' },
    });
  });
});

// ---------------------------------------------------------------------------
// mapTypeToRemote — push direction
// ---------------------------------------------------------------------------

describe('mapTypeToRemote', () => {
  it('writes the mapped name', () => {
    expect(mapTypeToRemote(JIRA_MAPPING, 'program')).toBe('Initiative');
    expect(mapTypeToRemote(GITHUB_MAPPING, 'epic')).toBe('epic');
  });

  it('returns undefined for a type with no mapping', () => {
    expect(mapTypeToRemote({}, 'epic')).toBeUndefined();
    expect(mapTypeToRemote(GITHUB_MAPPING, 'unknown_type')).toBeUndefined();
  });

  it('treats an entry that names nothing as unmapped rather than crashing', () => {
    // Reachable only by skipping the schema — a hand-edited config, a test
    // literal — and it must read as "no mapping", never throw.
    expect(mapTypeToRemote({ epic: { remote: '' } }, 'epic')).toBeUndefined();
    expect(mapTypeToRemote({ epic: {} as never }, 'epic')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// claimedTypeValues — what a mapping claims, for a label reconciliation
// ---------------------------------------------------------------------------

describe('claimedTypeValues', () => {
  it('collects every mapped name', () => {
    expect(claimedTypeValues(GITHUB_MAPPING)).toContain('story');
    expect(claimedTypeValues({})).toEqual([]);
  });

  it('skips an entry that names nothing', () => {
    expect(claimedTypeValues({ epic: { remote: 'epic' }, ghost: {} as never })).toEqual(['epic']);
  });
});

// ---------------------------------------------------------------------------
// missingTypeMappings — preflight refusal
// ---------------------------------------------------------------------------

describe('missingTypeMappings', () => {
  it('returns nothing when every declared type maps', () => {
    expect(missingTypeMappings(GITHUB_MAPPING, HIERARCHY)).toEqual([]);
  });

  it('lists declared types with no mapping, in hierarchy order', () => {
    const mappings: TypeMappings = { program: { remote: 'program' } };
    expect(missingTypeMappings(mappings, HIERARCHY)).toEqual([
      'epic',
      'feature',
      'user_story',
      'bug',
      'test',
      'review',
      'research',
      'sub_task',
    ]);
  });

  it('counts an entry with no remote representation as missing', () => {
    const mappings: TypeMappings = { epic: { remote: '' }, feature: { remote: 'feature' } };
    const missing = missingTypeMappings(mappings, HIERARCHY);
    expect(missing).toContain('epic');
    expect(missing).not.toContain('feature');
  });

  it('ignores mapping entries for types the board does not declare', () => {
    const mappings: TypeMappings = { program: { remote: 'program' }, ghost: { remote: 'ghost' } };
    expect(missingTypeMappings(mappings, [['program']])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mapTypeFromRemote — pull direction
// ---------------------------------------------------------------------------

function pull(
  mappings: TypeMappings,
  observation: RemoteTypeObservation,
  opts: { depth: number; recordedType?: string },
) {
  return mapTypeFromRemote(mappings, HIERARCHY, observation, opts);
}

describe('mapTypeFromRemote', () => {
  it('resolves an unambiguous remote type', () => {
    const result = pull(JIRA_MAPPING, { remoteType: 'Epic', labels: [] }, { depth: 1 });
    expect(result.type).toBe('epic');
    expect(result.unresolved).toBeUndefined();
    expect(result.candidates).toEqual(['epic']);
  });

  it('resolves an unambiguous label (GitHub)', () => {
    const result = pull(GITHUB_MAPPING, { labels: ['story'] }, { depth: 3 });
    expect(result.type).toBe('user_story');
    expect(result.unresolved).toBeUndefined();
  });

  it('disambiguates by depth first when a remote type maps to two board types', () => {
    // One remote type spans two depths: depth decides which board type it is.
    const mappings: TypeMappings = {
      epic: { remote: 'Story' },
      feature: { remote: 'Story' },
    };
    const atDepth1 = mapTypeFromRemote(mappings, HIERARCHY, { remoteType: 'Story', labels: [] }, { depth: 1 });
    const atDepth2 = mapTypeFromRemote(mappings, HIERARCHY, { remoteType: 'Story', labels: [] }, { depth: 2 });
    expect(atDepth1.type).toBe('epic');
    expect(atDepth2.type).toBe('feature');
    expect(atDepth1.candidates).toEqual(['epic', 'feature']);
  });

  it('disambiguates by the recorded type when two same-depth types share a remote type', () => {
    // JIRA_MAPPING: user_story and bug both map to "Story", both at depth 3.
    const asStory = pull(JIRA_MAPPING, { remoteType: 'Story', labels: [] }, { depth: 3, recordedType: 'user_story' });
    const asBug = pull(JIRA_MAPPING, { remoteType: 'Story', labels: [] }, { depth: 3, recordedType: 'bug' });
    expect(asStory.type).toBe('user_story');
    expect(asBug.type).toBe('bug');
  });

  it('is ambiguous when same-depth candidates remain and no recorded type breaks the tie', () => {
    const result = pull(JIRA_MAPPING, { remoteType: 'Story', labels: [] }, { depth: 3 });
    expect(result.type).toBeUndefined();
    expect(result.unresolved).toBe('ambiguous');
    expect(result.candidates).toEqual(['bug', 'research', 'review', 'test', 'user_story']);
  });

  it('is ambiguous when the recorded type is not among the candidates', () => {
    const result = pull(JIRA_MAPPING, { remoteType: 'Story', labels: [] }, { depth: 3, recordedType: 'epic' });
    expect(result.unresolved).toBe('ambiguous');
    expect(result.type).toBeUndefined();
  });

  it('reports unmapped when no mapping matches the observation', () => {
    const result = pull(GITHUB_MAPPING, { labels: ['nonsense'] }, { depth: 3 });
    expect(result.type).toBeUndefined();
    expect(result.unresolved).toBe('unmapped');
    expect(result.candidates).toEqual([]);
  });

  it('reports depth when candidates match but none is legal at the document depth', () => {
    // "Story" maps to depth-3 types only; at depth 2 none is legal.
    const result = pull(JIRA_MAPPING, { remoteType: 'Story', labels: [] }, { depth: 2 });
    expect(result.type).toBeUndefined();
    expect(result.unresolved).toBe('depth');
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('resolves a root when the remote parent is outside scope', () => {
    // A remote issue whose parent is not mirrored arrives at depth 0 — it must
    // become a root of the scoped subtree, not be dropped.
    const result = pull(JIRA_MAPPING, { remoteType: 'Initiative', labels: [] }, { depth: 0 });
    expect(result.type).toBe('program');
    expect(result.unresolved).toBeUndefined();
  });

  it('matches a label only when a mapping names it', () => {
    // Both labels are names some board type claims, so both are candidates —
    // and depth decides, exactly as it would for two native types.
    const claimed = pull(GITHUB_MAPPING, { labels: ['epic', 'bug'] }, { depth: 1 });
    expect(claimed.candidates).toEqual(['bug', 'epic']);
    expect(claimed.type).toBe('epic');

    // A human's triage label is not a type: nobody's mapping names it.
    const triage = pull(GITHUB_MAPPING, { labels: ['epic', 'needs-triage'] }, { depth: 1 });
    expect(triage.candidates).toEqual(['epic']);
    expect(triage.type).toBe('epic');
  });

  it('matches the one name against either carrier', () => {
    // The mapping does not say whether its name is a native type or a label,
    // so a value arriving in either field resolves — which is what lets a
    // repository turn native issue types on without a mapping rewrite.
    const asLabel = pull(GITHUB_MAPPING, { labels: ['story'] }, { depth: 3 });
    const asNative = pull(GITHUB_MAPPING, { remoteType: 'story', labels: [] }, { depth: 3 });
    expect(asLabel.type).toBe('user_story');
    expect(asNative.type).toBe('user_story');
  });

  it('accepts an empty observation as unmapped', () => {
    const result = pull(GITHUB_MAPPING, { labels: [] }, { depth: 3 });
    expect(result.unresolved).toBe('unmapped');
  });

  it('sorts candidates deterministically', () => {
    const result = pull(JIRA_MAPPING, { remoteType: 'Story', labels: [] }, { depth: 3 });
    expect(result.candidates).toEqual([...result.candidates].sort());
  });
});

// ---------------------------------------------------------------------------
// degradedHierarchyLevels
// ---------------------------------------------------------------------------

describe('degradedHierarchyLevels', () => {
  it('degrades nothing when the remote holds the whole hierarchy', () => {
    expect(degradedHierarchyLevels(HIERARCHY, 5)).toEqual([]);
    expect(degradedHierarchyLevels(HIERARCHY, 99)).toEqual([]);
  });

  it('degrades every level of a flat remote (nativeDepth 1)', () => {
    const degraded = degradedHierarchyLevels(HIERARCHY, 1);
    expect(degraded.map((level) => level.depth)).toEqual([1, 2, 3, 4]);
    expect(degraded[0]).toEqual({ depth: 1, types: ['epic'] });
    expect(degraded[3]).toEqual({ depth: 4, types: ['sub_task'] });
  });

  it('degrades levels beyond one level of sub-issues (GitHub, nativeDepth 2)', () => {
    const degraded = degradedHierarchyLevels(HIERARCHY, 2);
    expect(degraded.map((level) => level.depth)).toEqual([2, 3, 4]);
  });

  it('degrades every level when nativeDepth is 0', () => {
    const degraded = degradedHierarchyLevels(HIERARCHY, 0);
    expect(degraded.map((level) => level.depth)).toEqual([0, 1, 2, 3, 4]);
  });

  it('returns nothing for an empty hierarchy', () => {
    expect(degradedHierarchyLevels([], 2)).toEqual([]);
  });

  it('does not alias the hierarchy types arrays', () => {
    const degraded = degradedHierarchyLevels(HIERARCHY, 4);
    degraded[0]!.types.push('mutation');
    expect(HIERARCHY[4]).toEqual(['sub_task']);
  });
});

// ---------------------------------------------------------------------------
// Status mapping (LP-269)
// ---------------------------------------------------------------------------

// A board with `done` terminal; the remote's `Done`/`Won't Fix`/`Duplicate`
// all mean `done`, and a push writes `Done`.
const STATUSES: StatusMappings = {
  backlog: { remote: ['Backlog'] },
  ready: { remote: ['Ready'] },
  in_progress: { remote: ['In Progress'] },
  in_review: { remote: ['In Review'] },
  done: { remote: ['Done', "Won't Fix", 'Duplicate'], push: 'Done', closed: true },
};

const BOARD_STATUSES = [
  { id: 'backlog' },
  { id: 'ready' },
  { id: 'in_progress' },
  { id: 'in_review' },
  { id: 'done', terminal: true },
];

// ---------------------------------------------------------------------------
// normalizeStatusMapping
// ---------------------------------------------------------------------------

describe('normalizeStatusMapping', () => {
  it('expands a plain string to a single remote state', () => {
    expect(normalizeStatusMapping('Done')).toEqual({ remote: ['Done'] });
  });

  it('expands a list of remote states', () => {
    expect(normalizeStatusMapping(['Done', "Won't Fix"])).toEqual({
      remote: ['Done', "Won't Fix"],
    });
  });

  it('passes the object form through, keeping push and closed', () => {
    expect(
      normalizeStatusMapping({ remote: ['Done'], push: 'Done', closed: true }),
    ).toEqual({ remote: ['Done'], push: 'Done', closed: true });
  });

  it('accepts a single-string remote in the object form', () => {
    expect(normalizeStatusMapping({ remote: 'Done' })).toEqual({ remote: ['Done'] });
  });

  it('returns undefined for an empty or unusable value', () => {
    expect(normalizeStatusMapping('')).toBeUndefined();
    expect(normalizeStatusMapping([])).toBeUndefined();
    expect(normalizeStatusMapping({})).toBeUndefined();
    expect(normalizeStatusMapping(42)).toBeUndefined();
  });

  it('does not alias the input array', () => {
    const input = ['Done'];
    const entry = normalizeStatusMapping(input)!;
    entry.remote.push('mutation');
    expect(input).toEqual(['Done']);
  });
});

describe('normalizeStatusMappings', () => {
  it('normalises every entry and drops unusable ones', () => {
    expect(
      normalizeStatusMappings({ done: 'Done', in_review: ['In Review'], ghost: '' }),
    ).toEqual({
      done: { remote: ['Done'] },
      in_review: { remote: ['In Review'] },
    });
  });
});

// ---------------------------------------------------------------------------
// mapStatusToRemote — push direction
// ---------------------------------------------------------------------------

describe('mapStatusToRemote', () => {
  it('writes the first remote state by default', () => {
    expect(mapStatusToRemote(STATUSES, 'backlog')).toBe('Backlog');
  });

  it('writes the declared push target when several states mean one status', () => {
    expect(mapStatusToRemote(STATUSES, 'done')).toBe('Done');
  });

  it('returns undefined for an unmapped status', () => {
    expect(mapStatusToRemote(STATUSES, 'mystery')).toBeUndefined();
    expect(mapStatusToRemote({}, 'done')).toBeUndefined();
  });

  it('returns undefined for an entry with no remote states', () => {
    const mappings: StatusMappings = { done: { remote: [] } };
    expect(mapStatusToRemote(mappings, 'done')).toBeUndefined();
  });
});

describe('isClosedRemote', () => {
  it('reads the closed flag', () => {
    expect(isClosedRemote(STATUSES, 'done')).toBe(true);
    expect(isClosedRemote(STATUSES, 'backlog')).toBeUndefined();
  });

  it('distinguishes an explicit open from an undeclared one', () => {
    const mappings: StatusMappings = {
      open: { remote: ['Open'], closed: false },
      unknown: { remote: ['Unknown'] },
    };
    expect(isClosedRemote(mappings, 'open')).toBe(false);
    expect(isClosedRemote(mappings, 'unknown')).toBeUndefined();
  });

  it('is undefined for an unmapped status', () => {
    expect(isClosedRemote(STATUSES, 'mystery')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// missingStatusMappings — preflight refusal
// ---------------------------------------------------------------------------

describe('missingStatusMappings', () => {
  it('returns nothing when every board status maps', () => {
    expect(missingStatusMappings(STATUSES, BOARD_STATUSES.map((s) => s.id))).toEqual([]);
  });

  it('lists board statuses with no usable mapping', () => {
    expect(missingStatusMappings({ done: { remote: ['Done'] } }, ['todo', 'done'])).toEqual([
      'todo',
    ]);
  });
});

// ---------------------------------------------------------------------------
// mapStatusFromRemote — pull direction
// ---------------------------------------------------------------------------

describe('mapStatusFromRemote', () => {
  it('resolves one observed state to its board status', () => {
    const result = mapStatusFromRemote(STATUSES, ['In Progress']);
    expect(result.status).toBe('in_progress');
    expect(result.unresolved).toBeUndefined();
  });

  it('resolves several remote states that all mean one board status', () => {
    const result = mapStatusFromRemote(STATUSES, ["Won't Fix"]);
    expect(result.status).toBe('done');
    expect(result.unresolved).toBeUndefined();
    expect(result.candidates).toEqual(['done']);
  });

  it('reports unmapped when no board status claims any observed state', () => {
    const result = mapStatusFromRemote(STATUSES, ['Nonsense']);
    expect(result.status).toBeUndefined();
    expect(result.unresolved).toBe('unmapped');
    expect(result.candidates).toEqual([]);
  });

  it('reports ambiguous when several board statuses each claim a state', () => {
    const result = mapStatusFromRemote(STATUSES, ['In Progress', 'In Review']);
    expect(result.status).toBeUndefined();
    expect(result.unresolved).toBe('ambiguous');
    expect(result.candidates).toEqual(['in_progress', 'in_review']);
  });

  it('matches only states the mapping claims', () => {
    // A human triage label must not read as a status.
    const result = mapStatusFromRemote(STATUSES, ['Ready', 'triage']);
    expect(result.status).toBe('ready');
    expect(result.unresolved).toBeUndefined();
  });

  it('sorts candidates deterministically', () => {
    const result = mapStatusFromRemote(STATUSES, ['In Review', 'In Progress']);
    expect(result.candidates).toEqual([...result.candidates].sort());
  });
});

// ---------------------------------------------------------------------------
// unmappedRemoteStates — reverse totality, reported at preflight
// ---------------------------------------------------------------------------

describe('unmappedRemoteStates', () => {
  it('reports remote states no board status claims', () => {
    expect(
      unmappedRemoteStates(STATUSES, ['Backlog', 'Done', 'Blocked', 'In Progress']),
    ).toEqual(['Blocked']);
  });

  it('returns nothing when every remote state is claimed', () => {
    expect(unmappedRemoteStates(STATUSES, ['Done', "Won't Fix", 'Duplicate'])).toEqual([]);
  });

  it('reports everything against an empty mapping', () => {
    expect(unmappedRemoteStates({}, ['Done'])).toEqual(['Done']);
  });
});

// ---------------------------------------------------------------------------
// statusClosednessMismatches — terminal ↔ closed agreement
// ---------------------------------------------------------------------------

describe('statusClosednessMismatches', () => {
  it('returns nothing when terminal and closed agree', () => {
    expect(statusClosednessMismatches(STATUSES, BOARD_STATUSES)).toEqual([]);
  });

  it('flags a terminal status not marked closed', () => {
    const mappings: StatusMappings = {
      done: { remote: ['Done'] }, // no `closed`
    };
    expect(statusClosednessMismatches(mappings, [{ id: 'done', terminal: true }])).toEqual([
      { status: 'done', terminal: true, closed: false },
    ]);
  });

  it('flags a non-terminal status marked closed', () => {
    const mappings: StatusMappings = {
      backlog: { remote: ['Backlog'], closed: true },
    };
    expect(statusClosednessMismatches(mappings, [{ id: 'backlog' }])).toEqual([
      { status: 'backlog', terminal: false, closed: true },
    ]);
  });

  it('ignores statuses the board does not declare', () => {
    // A mapping key for a status the board dropped is not a closedness
    // mismatch; it is simply dead config.
    expect(statusClosednessMismatches(STATUSES, [{ id: 'done', terminal: true }])).toEqual([]);
  });
});
