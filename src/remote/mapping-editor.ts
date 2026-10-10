/**
 * The mapping editor: what a tracker has, what the mapping says, and writing
 * what a person chose.
 *
 * `lpm remote add` drafts `remotes.<name>.mapping` offline, from the convention
 * of the provider. `lpm remote setup` corrects the spelling of a drafted name.
 * Neither lets a person choose. This module is the third step: it reads the
 * issue types, the workflow statuses and the period containers that the
 * tracker reports, beside the mapping as `.lpm/config.yml` holds it, and it
 * writes a whole choice back. The web dialog File ▸ Board configuration ▸
 * Remote board draws the two sides and sends the choice.
 *
 * ## Reading
 *
 * `readRemoteMapping` opens the remote with `lenient: true`, because a mapping
 * that is not complete is the reason to open the editor. It then asks the
 * connector four questions, each one optional on a connector:
 *
 *   - `reachable()` says whether the tracker can be seen with this credential.
 *   - `issueTypes()` lists the issue types with the hierarchy level of each.
 *     `vocabulary().types` is the fallback, and gives names without levels.
 *   - `vocabulary().statuses` lists the workflow statuses.
 *   - `listSprints()` lists the period containers.
 *
 * A question that throws does not stop the read. The reason goes into
 * `problems`, and the block is answered from the mapping alone. A provider
 * that has no list of its own (GitHub stores a type and a status as a label)
 * answers `fixed: false`, and the names that the mapping declares are the
 * items.
 *
 * ## Writing
 *
 * `writeRemoteMapping` edits the `yaml` document in place, as
 * `updateRemoteMapping` does. It keeps the shape of an entry that exists: a
 * mapping `{ remote: Done, closed: true }` keeps `closed`, and a plain name
 * stays a plain name. A new status entry gets `closed` from the `terminal`
 * flag of the board status, as the scaffold writes it. The call parses the
 * whole file and opens the remote strictly before it writes, so a choice that
 * leaves the remote unable to open is refused and nothing is written.
 *
 * A mapping change after the first sync changes the mapping fingerprint
 * (`fingerprint.ts`). The next sync then stops and asks for `lpm remote
 * rebase`. This module does not re-base. `linked` in the answer tells the
 * dialog to say so.
 */

import { readFileSync } from 'node:fs';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Document, YAMLMap, YAMLSeq } from 'yaml';
import type { LoadedBoard } from '../core/board/load.js';
import { remoteNamed } from '../core/config/lookup.js';
import { parseConfigText } from '../core/config/schema.js';
import { BoardError } from '../core/errors.js';
import { writeFileAtomic } from '../core/storage/atomic.js';
import { withBoardLock } from '../core/storage/lock.js';
import type {
  RemoteMappingDto,
  RemoteMappingUpdateDto,
  RemotePeriodItemDto,
  RemoteTypeItemDto,
} from '../shared/remote-api.js';
import { isProbe } from './capabilities.js';
import { loadLinkStore } from './links.js';
import { normalizeStatusMappings, normalizeTypeMappings, statusStatesOf } from './mapping.js';
import { normalizePeriodMapping } from './periods.js';
import type { Connector } from './provider.js';
import { buildConnector, openRemote } from './remotes.js';
import { isMarker } from './scaffold.js';

const reasonOf = (error: unknown): string =>
  error instanceof BoardError
    ? [error.message, ...error.details].join(' ')
    : error instanceof Error
      ? error.message
      : String(error);

const unique = (values: string[]): string[] => [...new Set(values)];

/** True for a name that somebody chose. A scaffold marker is a question and not a name. */
const named = (value: string): boolean => !isMarker(value);

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Board type name to the tracker name, without the entries that hold a scaffold marker. */
function typeMappingOf(mapping: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [type, entry] of Object.entries(normalizeTypeMappings(recordOf(mapping['types'])))) {
    if (named(entry.remote)) out[type] = entry.remote;
  }
  return out;
}

/** Board status id to its tracker states, the state that a push writes first. */
function statusMappingOf(mapping: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [status, entry] of Object.entries(normalizeStatusMappings(recordOf(mapping['statuses'])))) {
    const states = statusStatesOf(entry).filter(named);
    if (!states.length) continue;
    const first = entry.push !== undefined && states.includes(entry.push) ? entry.push : states[0]!;
    out[status] = unique([first, ...states]);
  }
  return out;
}

/**
 * Read what the tracker has and what the mapping says, for the remote `name`.
 *
 * Throws what `openRemote` throws for a remote that is not declared or whose
 * connection does not validate. Every failure after that is a line in
 * `problems`.
 */
export async function readRemoteMapping(board: LoadedBoard, name: string): Promise<RemoteMappingDto> {
  const remote = openRemote(board.config, name, { lenient: true });
  const declared = remoteNamed(board.config, name)!;
  const raw = declared.mapping;
  const types = typeMappingOf(raw);
  const statuses = statusMappingOf(raw);
  // The validated block, not the raw one: the schema of a provider with one
  // carrier stamps it, so `{ container: sprint }` on Jira reads `carrier: sprint`.
  const periodMapping = normalizePeriodMapping(remote.mapping['periods']);
  const periodsCell = remote.provider.capabilities.periods;

  const view: RemoteMappingDto = {
    remoteName: name,
    provider: declared.provider,
    types: {
      fixed: false,
      items: unique(Object.values(types)).map((entry) => ({ name: entry })),
      mapping: types,
    },
    statuses: { fixed: false, items: unique(Object.values(statuses).flat()), mapping: statuses },
    periods: {
      native: isProbe(periodsCell) ? true : periodsCell.native,
      carrier: periodMapping?.carrier ?? null,
      container: periodMapping && periodMapping.container !== '' ? periodMapping.container : null,
      items: null,
    },
    linked: loadLinkStore(board.paths, name).links.size,
    problems: [],
  };

  let connector: Connector;
  try {
    connector = buildConnector(remote, board.paths);
  } catch (error) {
    view.problems.push(`The tracker was not asked: ${reasonOf(error)}`);
    return view;
  }

  /** Ask one question. A failure becomes a line in `problems`, and the block keeps its offline answer. */
  const ask = async (what: string, question: () => Promise<void>): Promise<void> => {
    try {
      await question();
    } catch (error) {
      view.problems.push(`Could not read ${what}: ${reasonOf(error)}`);
    }
  };

  if (typeof connector.reachable === 'function') {
    await ask('whether the tracker is reachable', async () => {
      view.reachability = await connector.reachable!();
    });
    if (view.reachability && !view.reachability.reachable) return view;
  }

  const vocabulary = typeof connector.vocabulary === 'function' ? connector.vocabulary.bind(connector) : null;

  await ask('the issue types', async () => {
    let items: RemoteTypeItemDto[] | null = null;
    if (typeof connector.issueTypes === 'function') {
      items = (await connector.issueTypes()).map((type) => ({
        name: type.name,
        ...(type.hierarchyLevel !== undefined ? { level: type.hierarchyLevel } : {}),
        ...(type.subtask ? { subtask: true } : {}),
      }));
    } else if (vocabulary) {
      const names = (await vocabulary()).types;
      if (names !== undefined) items = names.map((entry) => ({ name: entry }));
    }
    if (items !== null) view.types = { ...view.types, fixed: true, items };
  });

  await ask('the workflow statuses', async () => {
    const names = vocabulary ? (await vocabulary()).statuses : undefined;
    if (names !== undefined) view.statuses = { ...view.statuses, fixed: true, items: [...names] };
  });

  if (view.periods.native && typeof connector.listSprints === 'function') {
    await ask('the sprints', async () => {
      const sprints = await connector.listSprints!();
      view.periods.items = sprints.map(
        (sprint): RemotePeriodItemDto => ({
          name: sprint.name,
          state: sprint.state,
          ...(sprint.starts !== undefined ? { starts: sprint.starts } : {}),
          ...(sprint.ends !== undefined ? { ends: sprint.ends } : {}),
        }),
      );
    });
  }

  return view;
}

// ---------------------------------------------------------------------------
// Writing

function requireMapping(doc: Document, name: string): YAMLMap {
  const remote = doc.getIn(['remotes', name], true);
  if (!isMap(remote)) {
    throw new BoardError(`No remote named "${name}"`, ['Nothing was written.']);
  }
  const existing = remote.get('mapping', true);
  if (isMap(existing)) return existing;
  const created = doc.createNode({}) as YAMLMap;
  remote.set('mapping', created);
  return created;
}

/** The mapping `block` under `mapping`, created in block style when it is absent or not a mapping. */
function blockOf(doc: Document, mapping: YAMLMap, block: string): YAMLMap {
  const existing = mapping.get(block, true);
  if (isMap(existing)) return existing;
  const created = doc.createNode({}) as YAMLMap;
  mapping.set(block, created);
  return created;
}

const flowSeq = (doc: Document, values: string[]): YAMLSeq => {
  const seq = doc.createNode(values) as YAMLSeq;
  seq.flow = true;
  return seq;
};

/** A node as the plain value that a `changed` line prints. */
const printed = (node: unknown): string => {
  if (node === undefined || node === null) return '(not mapped)';
  const value = isScalar(node) || isSeq(node) || isMap(node) ? node.toJSON() : node;
  return typeof value === 'string' ? value : JSON.stringify(value);
};

function writeTypes(
  doc: Document,
  mapping: YAMLMap,
  board: LoadedBoard,
  types: Record<string, string>,
  changed: string[],
): void {
  const declared = board.config.hierarchy.flat();
  const missing = declared.filter((type) => !types[type]?.trim());
  if (missing.length) {
    throw new BoardError('Not every issue type of the board is mapped', [
      `Not mapped: ${missing.join(', ')}`,
      'A push cannot file an issue whose type has no name on the tracker.',
    ]);
  }
  const block = blockOf(doc, mapping, 'types');
  for (const type of declared) {
    const value = types[type]!.trim();
    const entry = block.get(type, true);
    const before = typeMappingOf({ types: { [type]: isScalar(entry) || isMap(entry) || isSeq(entry) ? entry.toJSON() : entry } })[type];
    if (before === value) continue;
    // An entry in the object form keeps its other keys. Every other entry is one name.
    if (isMap(entry)) entry.set('remote', value);
    else block.set(type, value);
    changed.push(`types.${type}: ${before ?? '(not mapped)'} → ${value}`);
  }
  // A key for a type that the board no longer declares maps nothing.
  for (const pair of [...block.items]) {
    const key = String(isScalar(pair.key) ? pair.key.value : pair.key);
    if (declared.includes(key)) continue;
    block.delete(key);
    changed.push(`types.${key}: removed, the board has no such type`);
  }
}

function writeStatuses(
  doc: Document,
  mapping: YAMLMap,
  board: LoadedBoard,
  statuses: Record<string, string[]>,
  changed: string[],
): void {
  const wanted = (id: string): string[] =>
    unique((statuses[id] ?? []).map((state) => state.trim()).filter(Boolean));
  const declared = board.config.statuses;
  const missing = declared.filter((status) => wanted(status.id).length === 0);
  if (missing.length) {
    throw new BoardError('Not every status of the board is mapped', [
      `Not mapped: ${missing.map((status) => status.id).join(', ')}`,
      'A remote whose status mapping is not complete cannot be opened.',
    ]);
  }
  const block = blockOf(doc, mapping, 'statuses');
  for (const status of declared) {
    const states = wanted(status.id);
    const entry = block.get(status.id, true);
    const raw = isScalar(entry) || isMap(entry) || isSeq(entry) ? entry.toJSON() : entry;
    const before = statusMappingOf({ statuses: { [status.id]: raw } })[status.id] ?? [];
    if (before.join('\n') === states.join('\n')) continue;

    const remote = states.length === 1 ? states[0]! : flowSeq(doc, states);
    if (isMap(entry)) {
      entry.set('remote', remote);
      // The first state is the one a push writes, so an explicit `push` would
      // say the same thing twice, or contradict the new list.
      entry.delete('push');
    } else if (entry === undefined || entry === null) {
      block.set(status.id, doc.createNode({ remote, closed: status.terminal === true }));
    } else {
      block.set(status.id, remote);
    }
    changed.push(`statuses.${status.id}: ${printed(before.length ? before : undefined)} → ${printed(states)}`);
  }
  const ids = declared.map((status) => status.id);
  for (const pair of [...block.items]) {
    const key = String(isScalar(pair.key) ? pair.key.value : pair.key);
    if (ids.includes(key)) continue;
    block.delete(key);
    changed.push(`statuses.${key}: removed, the board has no such status`);
  }
}

function writePeriodContainer(
  doc: Document,
  mapping: YAMLMap,
  board: LoadedBoard,
  container: string,
  changed: string[],
): void {
  const declared = board.config.period_hierarchy.flat();
  if (!declared.includes(container)) {
    throw new BoardError(`"${container}" is not a period type of the board`, [
      declared.length ? `Period types: ${declared.join(', ')}` : 'This board declares no period types.',
    ]);
  }
  const entry = mapping.get('periods', true);
  const before = normalizePeriodMapping(isScalar(entry) || isMap(entry) ? entry.toJSON() : entry);
  if (before?.container === container) return;
  if (isMap(entry)) {
    entry.set('container', container);
  } else if (before) {
    // The shorthand `periods: milestones` names a carrier and no container.
    mapping.set('periods', doc.createNode({ container, carrier: before.carrier }));
  } else {
    mapping.set('periods', doc.createNode({ container }));
  }
  changed.push(`periods.container: ${before?.container || '(the deepest period type)'} → ${container}`);
}

/**
 * Write a chosen mapping into `remotes.<name>.mapping` of `.lpm/config.yml`.
 * Returns the lines that changed. Writes nothing when a block is not complete,
 * when the file would not parse, or when the remote would not open.
 */
export function writeRemoteMapping(
  board: LoadedBoard,
  name: string,
  update: RemoteMappingUpdateDto,
): { changed: string[] } {
  const { paths } = board;
  return withBoardLock(paths, `update remote mapping ${name}`, () => {
    const doc = parseDocument(readFileSync(paths.configPath, 'utf8'));
    const mapping = requireMapping(doc, name);
    const changed: string[] = [];

    if (update.types !== undefined) writeTypes(doc, mapping, board, update.types, changed);
    if (update.statuses !== undefined) writeStatuses(doc, mapping, board, update.statuses, changed);
    if (update.periodContainer !== undefined) {
      writePeriodContainer(doc, mapping, board, update.periodContainer, changed);
    }
    if (!changed.length) return { changed };

    const text = doc.toString();
    const parsed = parseConfigText(text);
    if (!parsed.config) {
      throw new BoardError(
        `Cannot update remote "${name}" — the resulting config would not load`,
        parsed.errors,
      );
    }
    // The strict open is the check that a sync runs. A mapping that the editor
    // wrote must pass it, or the editor saved a remote that cannot sync.
    openRemote(parsed.config, name);
    writeFileAtomic(paths.configPath, text);
    return { changed };
  });
}
