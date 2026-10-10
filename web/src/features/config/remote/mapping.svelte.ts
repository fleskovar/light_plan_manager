import type {
  ConfigDto,
  RemoteMappingDto,
  RemoteMappingUpdateDto,
  RemoteMappingUpdateResultDto,
  RemoteTypeItemDto,
} from '$shared';
import { ApiError } from '$lib/api/client.js';

/**
 * The mapping editor of one tracker remote: the choice that a person makes
 * between the items of the board and the items of the tracker, and the request
 * that saves it.
 *
 * The server answers both sides in one `RemoteMappingDto`. The editor keeps a
 * `MappingDraft` beside it. Each control changes the draft, and Save sends the
 * whole draft. Nothing is written before Save.
 *
 * The draft is keyed by the board item, because `.lpm/config.yml` stores the
 * mapping that way: one tracker type for each board type, and a list of
 * tracker states for each board status. The dialog draws a control on each
 * tracker item, so the functions below answer the question from that side:
 * which board items map to this tracker item.
 *
 * The pure functions are exported for the tests. The components are
 * presentational.
 */

// ---------------------------------------------------------------------------
// The draft

export interface MappingDraft {
  /** Board type name to the tracker type. An empty string means that the type is not mapped. */
  types: Record<string, string>;
  /** Board status id to the tracker states that mean it. A push writes the first. */
  statuses: Record<string, string[]>;
  /** The board period type that maps to the container of the tracker, or null. */
  periodContainer: string | null;
  /** Tracker type names that a person added. Only a tracker with no list of its own takes one. */
  addedTypes: string[];
  /** Tracker status names that a person added, under the same rule. */
  addedStatuses: string[];
}

/** The names of the issue types of the board, the top level first. */
export function boardTypes(config: ConfigDto): string[] {
  return config.hierarchy.issue.flat();
}

/**
 * The draft that shows the mapping as the file holds it.
 *
 * A name that the mapping holds and the tracker does not report is dropped
 * from the draft. The board item then shows as not mapped, and `staleNames`
 * says which name it held.
 */
export function draftOf(view: RemoteMappingDto, config: ConfigDto): MappingDraft {
  const knownType = (name: string): boolean =>
    !view.types.fixed || view.types.items.some((item) => item.name === name);
  const knownStatus = (name: string): boolean =>
    !view.statuses.fixed || view.statuses.items.includes(name);

  return {
    types: Object.fromEntries(
      boardTypes(config).map((type) => {
        const mapped = view.types.mapping[type] ?? '';
        return [type, knownType(mapped) ? mapped : ''];
      }),
    ),
    statuses: Object.fromEntries(
      config.statuses.map((status) => [
        status.id,
        (view.statuses.mapping[status.id] ?? []).filter(knownStatus),
      ]),
    ),
    periodContainer: view.periods.container,
    addedTypes: [],
    addedStatuses: [],
  };
}

/** One board item whose mapping names a word that the tracker does not have. */
export interface StaleName {
  block: 'types' | 'statuses';
  boardKey: string;
  name: string;
}

export function staleNames(view: RemoteMappingDto): StaleName[] {
  const stale: StaleName[] = [];
  if (view.types.fixed) {
    const known = new Set(view.types.items.map((item) => item.name));
    for (const [boardKey, name] of Object.entries(view.types.mapping)) {
      if (!known.has(name)) stale.push({ block: 'types', boardKey, name });
    }
  }
  if (view.statuses.fixed) {
    const known = new Set(view.statuses.items);
    for (const [boardKey, names] of Object.entries(view.statuses.mapping)) {
      for (const name of names) if (!known.has(name)) stale.push({ block: 'statuses', boardKey, name });
    }
  }
  return stale;
}

// ---------------------------------------------------------------------------
// The tracker side

/** One level of the type hierarchy of the tracker, the top level first. */
export interface RemoteTypeLevel {
  /** The level as the tracker numbers it, or null when the tracker reports none. */
  level: number | null;
  /** How far the dialog indents the level: 0 for the top level. */
  indent: number;
  types: RemoteTypeItemDto[];
}

/**
 * The tracker types as a tree of levels. A tracker that reports a level for
 * each type gives one group for each level, the highest first. A tracker that
 * reports none gives one group.
 */
export function remoteTypeLevels(items: RemoteTypeItemDto[]): RemoteTypeLevel[] {
  if (!items.some((item) => item.level !== undefined)) {
    return items.length ? [{ level: null, indent: 0, types: items }] : [];
  }
  const levels = [...new Set(items.map((item) => item.level ?? 0))].sort((a, b) => b - a);
  return levels.map((level, indent) => ({
    level,
    indent,
    types: items.filter((item) => (item.level ?? 0) === level),
  }));
}

/** The tracker types of the dialog: the reported ones, then the ones a person added. */
export function remoteTypesOf(view: RemoteMappingDto, draft: MappingDraft): RemoteTypeItemDto[] {
  const reported = view.types.items.map((item) => item.name);
  return [
    ...view.types.items,
    ...draft.addedTypes.filter((name) => !reported.includes(name)).map((name) => ({ name })),
  ];
}

export function remoteStatusesOf(view: RemoteMappingDto, draft: MappingDraft): string[] {
  return [...new Set([...view.statuses.items, ...draft.addedStatuses])];
}

/** The board types that map to the tracker type `remote`, in hierarchy order. */
export function boardTypesFor(draft: MappingDraft, remote: string): string[] {
  return Object.keys(draft.types).filter((type) => draft.types[type] === remote);
}

/** The board statuses that map to the tracker status `remote`, in board order. */
export function boardStatusesFor(draft: MappingDraft, remote: string): string[] {
  return Object.keys(draft.statuses).filter((status) => draft.statuses[status]!.includes(remote));
}

// ---------------------------------------------------------------------------
// Changes to the draft. Each returns a new draft.

/**
 * Map a board type to a tracker type. A board type has one tracker type, so
 * the type leaves the tracker type that it mapped to before. An empty `remote`
 * removes the mapping.
 */
export function assignType(draft: MappingDraft, type: string, remote: string): MappingDraft {
  return { ...draft, types: { ...draft.types, [type]: remote } };
}

/**
 * Say that the tracker status `remote` means the board status `status`. The
 * first tracker status that a board status gets is the one a push writes.
 *
 * A tracker status can mean several board statuses. A tracker with fewer
 * statuses than the board needs that: `backlog` and `ready` both become
 * "To Do". A pull then cannot tell the two apart, and `lpm check` reports the
 * pair. `sharedStatuses` lists them for the dialog.
 */
export function assignStatus(draft: MappingDraft, status: string, remote: string): MappingDraft {
  const states = draft.statuses[status] ?? [];
  if (states.includes(remote)) return draft;
  return { ...draft, statuses: { ...draft.statuses, [status]: [...states, remote] } };
}

/** The tracker statuses that mean more than one board status, each with those board statuses. */
export function sharedStatuses(draft: MappingDraft): Array<{ remote: string; statuses: string[] }> {
  const remotes = [...new Set(Object.values(draft.statuses).flat())];
  return remotes
    .map((remote) => ({ remote, statuses: boardStatusesFor(draft, remote) }))
    .filter((entry) => entry.statuses.length > 1);
}

export function unassignStatus(draft: MappingDraft, status: string, remote: string): MappingDraft {
  return {
    ...draft,
    statuses: {
      ...draft.statuses,
      [status]: (draft.statuses[status] ?? []).filter((state) => state !== remote),
    },
  };
}

/** Make `remote` the state that a push writes for `status`: the first of its list. */
export function pushStatus(draft: MappingDraft, status: string, remote: string): MappingDraft {
  const states = draft.statuses[status] ?? [];
  if (!states.includes(remote)) return draft;
  return {
    ...draft,
    statuses: { ...draft.statuses, [status]: [remote, ...states.filter((state) => state !== remote)] },
  };
}

/** Add a tracker name by hand. Refused, with the same draft, for a blank or a known name. */
export function addRemoteName(
  draft: MappingDraft,
  view: RemoteMappingDto,
  block: 'types' | 'statuses',
  name: string,
): MappingDraft {
  const trimmed = name.trim();
  if (!trimmed) return draft;
  if (block === 'types') {
    if (remoteTypesOf(view, draft).some((item) => item.name === trimmed)) return draft;
    return { ...draft, addedTypes: [...draft.addedTypes, trimmed] };
  }
  if (remoteStatusesOf(view, draft).includes(trimmed)) return draft;
  return { ...draft, addedStatuses: [...draft.addedStatuses, trimmed] };
}

// ---------------------------------------------------------------------------
// Saving

/** Whether the board has period types and the tracker has a container for one. */
export function mapsPeriods(view: RemoteMappingDto, config: ConfigDto): boolean {
  return view.periods.native && config.hasPeriods;
}

/** Each reason that Save is refused. An empty list means that the draft can be saved. */
export function draftProblems(draft: MappingDraft, view: RemoteMappingDto, config: ConfigDto): string[] {
  const problems: string[] = [];
  const types = boardTypes(config).filter((type) => !draft.types[type]);
  if (types.length) problems.push(`Board types with no tracker type: ${types.join(', ')}.`);
  const statuses = config.statuses.filter((status) => !(draft.statuses[status.id] ?? []).length);
  if (statuses.length) {
    problems.push(`Board statuses with no tracker status: ${statuses.map((status) => status.id).join(', ')}.`);
  }
  if (mapsPeriods(view, config) && !draft.periodContainer) {
    problems.push('No period type maps to the period container of the tracker.');
  }
  return problems;
}

/** The request that saves the draft. */
export function updateOf(draft: MappingDraft, view: RemoteMappingDto, config: ConfigDto): RemoteMappingUpdateDto {
  return {
    types: { ...draft.types },
    statuses: Object.fromEntries(Object.entries(draft.statuses).map(([id, states]) => [id, [...states]])),
    ...(mapsPeriods(view, config) && draft.periodContainer
      ? { periodContainer: draft.periodContainer }
      : {}),
  };
}

/** True when Save would send something other than what the file holds. */
export function isDirty(draft: MappingDraft, view: RemoteMappingDto, config: ConfigDto): boolean {
  const held = updateOf(draftOf(view, config), view, config);
  // A stale name is a difference too: the file holds it and the draft does not.
  const file: RemoteMappingUpdateDto = {
    ...held,
    types: { ...held.types, ...view.types.mapping },
    statuses: { ...held.statuses, ...view.statuses.mapping },
  };
  return JSON.stringify(updateOf(draft, view, config)) !== JSON.stringify(file);
}

// ---------------------------------------------------------------------------
// The state

/** The server calls of the editor, behind a seam for the tests. */
export interface MappingApi {
  remoteMapping(name: string): Promise<RemoteMappingDto>;
  saveRemoteMapping(name: string, body: RemoteMappingUpdateDto): Promise<RemoteMappingUpdateResultDto>;
}

export class MappingState {
  view = $state.raw<RemoteMappingDto | null>(null);
  draft = $state.raw<MappingDraft | null>(null);
  /** `reading` while the tracker is asked, `saving` while the file is written. */
  busy = $state<'reading' | 'saving' | null>(null);
  /** Why the last read or save failed, or null. */
  problem = $state<{ message: string; details: string[] } | null>(null);
  /** The lines of `.lpm/config.yml` that the last save changed, or null before a save. */
  saved = $state.raw<string[] | null>(null);

  readonly #api: MappingApi;
  readonly #config: () => ConfigDto;

  constructor(api: MappingApi, config: () => ConfigDto) {
    this.#api = api;
    this.#config = config;
  }

  /** Ask the tracker what it has, and start a draft from the mapping in the file. */
  async load(name: string): Promise<void> {
    this.busy = 'reading';
    this.problem = null;
    this.saved = null;
    try {
      const view = await this.#api.remoteMapping(name);
      this.view = view;
      this.draft = draftOf(view, this.#config());
    } catch (error) {
      this.view = null;
      this.draft = null;
      this.problem = problemOf(error);
    } finally {
      this.busy = null;
    }
  }

  /** Apply one change to the draft. */
  change(next: (draft: MappingDraft) => MappingDraft): void {
    if (this.draft) this.draft = next(this.draft);
    this.saved = null;
  }

  get problems(): string[] {
    return this.view && this.draft ? draftProblems(this.draft, this.view, this.#config()) : [];
  }

  get dirty(): boolean {
    return this.view !== null && this.draft !== null && isDirty(this.draft, this.view, this.#config());
  }

  /** Write the draft into `.lpm/config.yml`. True when the server took it. */
  async save(): Promise<boolean> {
    const { view, draft } = this;
    if (!view || !draft || this.problems.length) return false;
    this.busy = 'saving';
    this.problem = null;
    try {
      const result = await this.#api.saveRemoteMapping(view.remoteName, updateOf(draft, view, this.#config()));
      this.view = result.mapping;
      // A name that a person added stays in the list when no board item uses it yet.
      this.draft = { ...draftOf(result.mapping, this.#config()), addedTypes: draft.addedTypes, addedStatuses: draft.addedStatuses };
      this.saved = result.changed;
      return true;
    } catch (error) {
      this.problem = problemOf(error);
      return false;
    } finally {
      this.busy = null;
    }
  }
}

function problemOf(error: unknown): { message: string; details: string[] } {
  return error instanceof ApiError
    ? { message: error.message, details: error.details }
    : { message: error instanceof Error ? error.message : String(error), details: [] };
}
