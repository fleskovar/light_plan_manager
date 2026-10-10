import { existsSync, readFileSync, renameSync } from 'node:fs';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Document, Pair, YAMLMap, YAMLSeq } from 'yaml';
import type { ConfigEdit, ConfigEditResultDto, ConfigNamespace } from '../../shared/board-config.js';
import { isConfigName } from '../../shared/board-config.js';
import type { LoadedBoard } from '../board/load.js';
import { loadBoard } from '../board/load.js';
import { nodesOf } from '../board/query.js';
import { hierarchyFor, kindOfType, typesFor } from '../config/lookup.js';
import { NAMESPACE_KEYS, parseConfigText } from '../config/schema.js';
import { BoardError } from '../errors.js';
import type { AnyNode, BoardConfig, TypeDef } from '../model/types.js';
import { ATTRIBUTE_TYPES, TEMPLATE_FOLDER_TYPE, reservedFieldsFor } from '../model/types.js';
import { writeFileAtomic } from '../storage/atomic.js';
import type { BoardPaths } from '../storage/paths.js';
import { CONFIG_FILE, LPM_DIR } from '../storage/paths.js';
import { contextTemplatePath } from '../storage/templates.js';
import { writeBoardIndex } from './board-index.js';
import { withBoardWrite } from './git-sync.js';
import { requireUnchanged, writeDocument } from './shared.js';

/**
 * Changing the vocabulary of a board: its types, its statuses and its
 * attributes.
 *
 * `editBoardConfig` applies a list of `ConfigEdit` to `.lpm/config.yml`. An
 * edit that renames or removes a name also rewrites each file that holds the
 * name:
 *
 * - A new type name rewrites the field `type` of every document of the type.
 *   For an issue type, the templates of `.lpm/registry` count as documents.
 * - A new status id rewrites the field `status` of every issue in the status.
 * - A new attribute name moves the value in every document of the type. A
 *   removed attribute deletes the value from every document of the type.
 * - The keys of `mapping.types`, `mapping.statuses`, `mapping.attributes` and
 *   `fields` of every remote under `remotes` and `remotes_off` follow.
 * - The context template `.lpm/templates/context/<type>.md` is renamed with
 *   its issue type.
 *
 * The edits do not reach a developer profile, because a profile is a file
 * outside `.lpm`. They do not reach the text of a body or of a context
 * template. `ConfigEditResultDto.notes` lists what the caller must check.
 * The view files in `.lpm/views` belong to the server, which renames the keys
 * of `display` from `renamedTypes`.
 *
 * The field `updated` of a rewritten document does not change: the document
 * says what it said before, in other words.
 *
 * The config is edited as a `yaml` document, so comments and key order stay.
 * After each edit the text is parsed again with `parseConfigText`. An edit
 * whose result does not validate is refused, and nothing is written.
 *
 * The board is loaded inside the board lock, as `claimIssue` does. The caller
 * passes paths and no board handle, so no handle can be stale. On a board
 * shared through git, `withBoardWrite` commits the config and every rewritten
 * document in one commit.
 */

/** The state that the edits of one call share. Nothing is on disk until the last edit passed. */
interface Work {
  paths: BoardPaths;
  doc: Document;
  /** The config that `doc` holds now. */
  config: BoardConfig;
  board: LoadedBoard;
  /** The documents whose frontmatter changed in memory. */
  changed: Set<AnyNode>;
  renamedTypes: Record<string, string>;
  /** Context template files to rename, old path and new path. */
  moves: Array<[string, string]>;
  notes: string[];
  /**
   * Each type that lost the attribute that `priority_attribute` or
   * `effort_attribute` names, because a rename gave the attribute another name
   * on that type only. Reported at the end, when the key still names `from`.
   */
  unranked: Array<{ key: 'priority_attribute' | 'effort_attribute'; type: string; from: string }>;
}

const stringify = (doc: Document): string =>
  doc.toString({ lineWidth: 0, flowCollectionPadding: false });

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** A count with its noun and its verb: `1 issue has`, `3 issues have`. */
const subject = (count: number, noun: string, one: string, many: string): string =>
  `${plural(count, noun)} ${count === 1 ? one : many}`;

// -- the yaml document -------------------------------------------------------

function keyOf(pair: Pair): string {
  return String(isScalar(pair.key) ? pair.key.value : pair.key);
}

function mapAt(doc: Document, path: string[]): YAMLMap | null {
  const node = doc.getIn(path, true);
  return isMap(node) ? node : null;
}

function requireMap(doc: Document, path: string[]): YAMLMap {
  const map = mapAt(doc, path);
  if (!map) throw new BoardError(`${LPM_DIR}/${CONFIG_FILE} has no mapping at ${path.join('.')}`);
  return map;
}

/** Give the key `from` of a mapping the name `to`. The value, the position and the comments stay. */
function renameKey(map: YAMLMap | null, from: string, to: string): boolean {
  const pair = map?.items.find((entry) => keyOf(entry) === from);
  if (!pair) return false;
  if (isScalar(pair.key)) pair.key.value = to;
  else pair.key = to;
  return true;
}

/** Set a scalar in place, so a comment on its line stays. */
function setScalar(map: YAMLMap, key: string, value: string): void {
  const node = map.get(key, true);
  if (isScalar(node)) node.value = value;
  else map.set(key, value);
}

function flowSeq(doc: Document, values: string[]): YAMLSeq {
  const seq = doc.createNode(values) as YAMLSeq;
  seq.flow = true;
  return seq;
}

/** The names that one item of a hierarchy list holds: `epic`, or `[story, bug]`. */
function levelNames(item: unknown): string[] {
  if (isScalar(item)) return [String(item.value)];
  if (isSeq(item)) return item.items.map((entry) => String(isScalar(entry) ? entry.value : entry));
  return [];
}

function hierarchySeq(work: Work, kind: ConfigNamespace): YAMLSeq {
  const key = NAMESPACE_KEYS[kind].hierarchy;
  const seq = work.doc.get(key, true);
  if (!isSeq(seq)) throw new BoardError(`${LPM_DIR}/${CONFIG_FILE} has no list at ${key}`);
  return seq;
}

/** Each remote declaration, turned on or off, with the path of its block for a note. */
function remoteBlocks(doc: Document): Array<{ where: string; remote: YAMLMap }> {
  const blocks: Array<{ where: string; remote: YAMLMap }> = [];
  for (const block of ['remotes', 'remotes_off']) {
    for (const pair of mapAt(doc, [block])?.items ?? []) {
      if (isMap(pair.value)) blocks.push({ where: `${block}.${keyOf(pair)}`, remote: pair.value });
    }
  }
  return blocks;
}

const mappingOf = (remote: YAMLMap, block: string): YAMLMap | null => {
  const node = remote.getIn(['mapping', block], true);
  return isMap(node) ? node : null;
};

/** Rename, or with `to` null remove, the key `from` in one block of every remote. */
function followInRemotes(work: Work, block: 'types' | 'statuses' | 'attributes' | 'fields', from: string, to: string | null): void {
  for (const { where, remote } of remoteBlocks(work.doc)) {
    const node = block === 'fields' ? remote.get('fields', true) : mappingOf(remote, block);
    const map = isMap(node) ? node : null;
    if (!map?.has(from)) continue;
    const path = block === 'fields' ? `${where}.fields` : `${where}.mapping.${block}`;
    if (to === null) {
      map.delete(from);
      work.notes.push(`Removed the key "${from}" from ${path}.`);
    } else {
      renameKey(map, from, to);
      work.notes.push(`Renamed the key "${from}" to "${to}" in ${path}.`);
    }
  }
}

// -- shared guards -----------------------------------------------------------

function requireName(value: string, what: string): void {
  if (!isConfigName(value)) {
    throw new BoardError(`Invalid ${what} "${value}"`, [
      'Use lower-case letters, digits and "_", starting with a letter (for example user_story).',
    ]);
  }
}

function requireLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) throw new BoardError('A label cannot be empty');
  return trimmed;
}

/** The documents that carry the types of a namespace. The registry carries issue types. */
function documentsOf(work: Work, kind: ConfigNamespace): AnyNode[] {
  const own = nodesOf(work.board, kind) as AnyNode[];
  return kind === 'issue' ? [...own, ...work.board.templates] : own;
}

function requireType(work: Work, kind: ConfigNamespace, type: string): TypeDef {
  const def = typesFor(work.config, kind)[type];
  if (!def) {
    const names = Object.keys(typesFor(work.config, kind));
    throw new BoardError(`No ${kind} type called "${type}"`, [
      names.length ? `Declared ${kind} types: ${names.join(', ')}` : `This board declares no ${kind} types.`,
    ]);
  }
  return def;
}

function requireFreeTypeName(work: Work, name: string): void {
  requireName(name, 'type name');
  if (name === TEMPLATE_FOLDER_TYPE) {
    throw new BoardError(`"${name}" is reserved for the template registry`);
  }
  const owner = kindOfType(work.config, name);
  if (owner) throw new BoardError(`A type called "${name}" already exists (${owner} type)`);
}

// -- types -------------------------------------------------------------------

function addType(work: Work, edit: Extract<ConfigEdit, { op: 'add-type' }>): void {
  const keys = NAMESPACE_KEYS[edit.kind];
  const levels = hierarchyFor(work.config, edit.kind);
  if (!levels.length) {
    throw new BoardError(`This board declares no ${edit.kind} types`, [
      `Add ${keys.prefix}, ${keys.types} and ${keys.hierarchy} to ${LPM_DIR}/${CONFIG_FILE} by hand first.`,
    ]);
  }
  requireFreeTypeName(work, edit.name);
  const label = requireLabel(edit.label);
  const seq = hierarchySeq(work, edit.kind);

  if (edit.placement === 'join') {
    const item = seq.items[edit.level];
    if (!Number.isInteger(edit.level) || item === undefined) {
      throw new BoardError(`The ${edit.kind} hierarchy has no level ${edit.level}`);
    }
    if (isSeq(item)) {
      item.add(work.doc.createNode(edit.name));
    } else {
      const joined = flowSeq(work.doc, [...levelNames(item), edit.name]);
      if (isScalar(item)) {
        joined.commentBefore = item.commentBefore;
        joined.comment = item.comment;
      }
      seq.items[edit.level] = joined;
    }
  } else {
    if (!Number.isInteger(edit.level) || edit.level < 0 || edit.level > levels.length) {
      throw new BoardError(`A new level must sit at an index from 0 to ${levels.length}`);
    }
    // A new level moves each level from that index one level down. A document
    // keeps its folder, so each document at that depth or deeper then sits one
    // level above the level of its type.
    const displaced = documentsOf(work, edit.kind).filter((node) => node.depth >= edit.level);
    if (displaced.length) {
      throw new BoardError(`Cannot insert a level at index ${edit.level} of the ${edit.kind} hierarchy`, [
        `${subject(displaced.length, 'document', 'sits', 'sit')} at that level or deeper, for example ${displaced[0]!.id}.`,
        'A new level there needs a new parent document above each one, and this command creates no document.',
        'Add the type to an existing level, or add a level below the deepest level.',
      ]);
    }
    seq.items.splice(edit.level, 0, work.doc.createNode(edit.name));
  }

  requireMap(work.doc, [keys.types]).set(
    edit.name,
    work.doc.createNode({ label, attributes: {}, body: '' }),
  );
}

function renameType(work: Work, kind: ConfigNamespace, from: string, to: string): void {
  requireFreeTypeName(work, to);
  const keys = NAMESPACE_KEYS[kind];
  renameKey(requireMap(work.doc, [keys.types]), from, to);
  for (const item of hierarchySeq(work, kind).items) {
    for (const entry of isSeq(item) ? item.items : [item]) {
      if (isScalar(entry) && entry.value === from) entry.value = to;
    }
  }

  for (const node of documentsOf(work, kind)) {
    if (node.type !== from) continue;
    node.type = to;
    work.changed.add(node);
  }

  if (kind === 'period') {
    // `mapping.periods.container` names the period type that a remote stores natively.
    for (const { where, remote } of remoteBlocks(work.doc)) {
      const periods = mappingOf(remote, 'periods');
      const container = periods?.get('container', true);
      if (periods && isScalar(container) && container.value === from) {
        container.value = to;
        work.notes.push(`Renamed "${from}" to "${to}" in ${where}.mapping.periods.container.`);
      }
    }
  }
  if (kind !== 'issue') return;

  followInRemotes(work, 'types', from, to);
  // A type renamed twice in one call is recorded once, first name to last name.
  const first = Object.keys(work.renamedTypes).find((name) => work.renamedTypes[name] === from) ?? from;
  work.renamedTypes[first] = to;

  const oldFile = contextTemplatePath(work.paths, from);
  const newFile = contextTemplatePath(work.paths, to);
  if (existsSync(oldFile) && !existsSync(newFile)) work.moves.push([oldFile, newFile]);
  work.notes.push(
    `A developer profile that lists "${from}" under scope.types still names the old type. Edit that file by hand.`,
  );
}

function updateType(work: Work, edit: Extract<ConfigEdit, { op: 'update-type' }>): void {
  requireType(work, edit.kind, edit.type);
  if (edit.label !== undefined) {
    const typeNode = requireMap(work.doc, [NAMESPACE_KEYS[edit.kind].types, edit.type]);
    setScalar(typeNode, 'label', requireLabel(edit.label));
  }
  if (edit.name !== undefined && edit.name !== edit.type) {
    renameType(work, edit.kind, edit.type, edit.name);
  }
}

function removeType(work: Work, edit: Extract<ConfigEdit, { op: 'remove-type' }>): void {
  requireType(work, edit.kind, edit.type);
  const documents = documentsOf(work, edit.kind);
  const users = documents.filter((node) => node.type === edit.type);
  if (users.length) {
    throw new BoardError(`Cannot remove the type "${edit.type}"`, [
      `${subject(users.length, 'document', 'has', 'have')} this type, for example ${users[0]!.id}.`,
      'Convert or delete those documents first.',
    ]);
  }

  const seq = hierarchySeq(work, edit.kind);
  const level = seq.items.findIndex((item) => levelNames(item).includes(edit.type));
  const item = seq.items[level];
  if (isSeq(item) && item.items.length > 1) {
    item.items = item.items.filter((entry) => !(isScalar(entry) && entry.value === edit.type));
  } else {
    // The type was alone at its level, so the level goes, and each deeper level moves up.
    const deeper = documents.filter((node) => node.depth > level);
    if (deeper.length) {
      throw new BoardError(`Cannot remove the type "${edit.type}"`, [
        `It is the only type at level ${level}, and ${subject(deeper.length, 'document', 'sits', 'sit')} below that level.`,
      ]);
    }
    seq.items.splice(level, 1);
  }
  requireMap(work.doc, [NAMESPACE_KEYS[edit.kind].types]).delete(edit.type);
  if (edit.kind === 'issue') followInRemotes(work, 'types', edit.type, null);
}

// -- statuses ----------------------------------------------------------------

function statusSeq(work: Work): YAMLSeq {
  const seq = work.doc.get('statuses', true);
  if (!isSeq(seq)) throw new BoardError(`${LPM_DIR}/${CONFIG_FILE} has no list at statuses`);
  return seq;
}

function statusNode(work: Work, id: string): YAMLMap {
  const node = statusSeq(work).items.find((item) => isMap(item) && item.get('id') === id);
  if (!isMap(node)) {
    throw new BoardError(`No status with the id "${id}"`, [
      `Declared statuses: ${work.config.statuses.map((status) => status.id).join(', ')}`,
    ]);
  }
  return node;
}

function requireFreeStatusId(work: Work, id: string): void {
  requireName(id, 'status id');
  if (work.config.statuses.some((status) => status.id === id)) {
    throw new BoardError(`A status with the id "${id}" already exists`);
  }
}

function addStatus(work: Work, edit: Extract<ConfigEdit, { op: 'add-status' }>): void {
  requireFreeStatusId(work, edit.id);
  const seq = statusSeq(work);
  const index = edit.index ?? seq.items.length;
  if (!Number.isInteger(index) || index < 0 || index > seq.items.length) {
    throw new BoardError(`A new status must sit at an index from 0 to ${seq.items.length}`);
  }
  seq.items.splice(index, 0, work.doc.createNode({ id: edit.id, label: requireLabel(edit.label) }));
  // Without the key `default_status`, the first status is the default. A new
  // first status must not change the default, so the key is written.
  if (index === 0 && !work.doc.has('default_status')) {
    work.doc.set('default_status', work.config.default_status);
  }
}

function updateStatus(work: Work, edit: Extract<ConfigEdit, { op: 'update-status' }>): void {
  const node = statusNode(work, edit.status);
  if (edit.label !== undefined) setScalar(node, 'label', requireLabel(edit.label));
  if (edit.id === undefined || edit.id === edit.status) return;

  requireFreeStatusId(work, edit.id);
  setScalar(node, 'id', edit.id);
  if (work.doc.get('default_status') === edit.status) {
    setScalar(work.doc.contents as YAMLMap, 'default_status', edit.id);
  }
  for (const issue of work.board.issues) {
    if (issue.status !== edit.status) continue;
    issue.status = edit.id;
    work.changed.add(issue);
  }
  followInRemotes(work, 'statuses', edit.status, edit.id);
}

function removeStatus(work: Work, edit: Extract<ConfigEdit, { op: 'remove-status' }>): void {
  const node = statusNode(work, edit.status);
  const holders = work.board.issues.filter((issue) => issue.status === edit.status);
  if (holders.length) {
    throw new BoardError(`Cannot remove the status "${edit.status}"`, [
      `${subject(holders.length, 'issue', 'has', 'have')} this status, for example ${holders[0]!.id}.`,
      'Move those issues to another status first.',
    ]);
  }
  if (work.config.default_status === edit.status) {
    throw new BoardError(`Cannot remove the status "${edit.status}"`, [
      'It is the default status, which each new issue gets.',
      `Set default_status in ${LPM_DIR}/${CONFIG_FILE} to another status first.`,
    ]);
  }
  const seq = statusSeq(work);
  seq.items.splice(seq.items.indexOf(node), 1);
  followInRemotes(work, 'statuses', edit.status, null);
}

// -- attributes --------------------------------------------------------------

/** The mapping `attributes` of a type, in block style so that a new entry gets its own lines. */
function attributesMap(work: Work, kind: ConfigNamespace, type: string): YAMLMap {
  const typeNode = requireMap(work.doc, [NAMESPACE_KEYS[kind].types, type]);
  const existing = typeNode.get('attributes', true);
  if (isMap(existing)) {
    existing.flow = false;
    return existing;
  }
  const created = work.doc.createNode({}) as YAMLMap;
  typeNode.set('attributes', created);
  return created;
}

function requireAttribute(work: Work, kind: ConfigNamespace, type: string, attribute: string): void {
  const def = requireType(work, kind, type);
  if (!def.attributes[attribute]) {
    const names = Object.keys(def.attributes);
    throw new BoardError(`The type "${type}" has no attribute "${attribute}"`, [
      names.length ? `Declared attributes: ${names.join(', ')}` : 'It declares no attributes.',
    ]);
  }
}

function requireFreeAttributeName(work: Work, kind: ConfigNamespace, type: string, name: string): void {
  requireName(name, 'attribute name');
  if (reservedFieldsFor(kind).includes(name)) {
    throw new BoardError(`"${name}" is a reserved field name`, ['Choose another attribute name.']);
  }
  if (requireType(work, kind, type).attributes[name]) {
    throw new BoardError(`The type "${type}" already has an attribute "${name}"`);
  }
}

function cleanValues(values: string[]): string[] {
  const cleaned = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (!cleaned.length) throw new BoardError('An enum attribute needs at least one value');
  return cleaned;
}

/** True when another type of the namespace declares an attribute of this name. */
function declaredElsewhere(work: Work, kind: ConfigNamespace, type: string, attribute: string): boolean {
  return Object.entries(typesFor(work.config, kind)).some(
    ([name, def]) => name !== type && def.attributes[attribute] !== undefined,
  );
}

function addAttribute(work: Work, edit: Extract<ConfigEdit, { op: 'add-attribute' }>): void {
  requireFreeAttributeName(work, edit.kind, edit.type, edit.name);
  const { type, description, values } = edit.attribute;
  if (!(ATTRIBUTE_TYPES as readonly string[]).includes(type)) {
    throw new BoardError(`Unknown attribute type "${type}"`, [`Attribute types: ${ATTRIBUTE_TYPES.join(', ')}`]);
  }
  const node = work.doc.createNode({
    type,
    ...(description?.trim() ? { description: description.trim() } : {}),
  }) as YAMLMap;
  if (type === 'enum') node.set('values', flowSeq(work.doc, cleanValues(values ?? [])));
  attributesMap(work, edit.kind, edit.type).set(edit.name, node);
}

function renameAttribute(work: Work, kind: ConfigNamespace, type: string, from: string, to: string): void {
  requireFreeAttributeName(work, kind, type, to);
  renameKey(attributesMap(work, kind, type), from, to);
  for (const node of documentsOf(work, kind)) {
    if (node.type !== type || !(from in node.attributes)) continue;
    node.attributes[to] = node.attributes[from];
    delete node.attributes[from];
    work.changed.add(node);
  }
  if (kind !== 'issue') return;

  for (const key of ['priority_attribute', 'effort_attribute'] as const) {
    if (work.config[key] !== from) continue;
    if (declaredElsewhere(work, kind, type, from)) {
      work.unranked.push({ key, type, from });
    } else {
      setScalar(work.doc.contents as YAMLMap, key, to);
    }
  }
  if (!declaredElsewhere(work, kind, type, from)) {
    followInRemotes(work, 'attributes', from, to);
    followInRemotes(work, 'fields', from, to);
  }
}

function updateAttribute(work: Work, edit: Extract<ConfigEdit, { op: 'update-attribute' }>): void {
  requireAttribute(work, edit.kind, edit.type, edit.attribute);
  const def = work.config[NAMESPACE_KEYS[edit.kind].types][edit.type]!.attributes[edit.attribute]!;
  const node = attributesMap(work, edit.kind, edit.type).get(edit.attribute, true);
  if (!isMap(node)) throw new BoardError(`The attribute "${edit.attribute}" is not a mapping in the config`);

  if (edit.description !== undefined) {
    if (edit.description.trim()) setScalar(node, 'description', edit.description.trim());
    else node.delete('description');
  }

  if (edit.values !== undefined) {
    if (def.type !== 'enum') {
      throw new BoardError(`"${edit.attribute}" is of the type ${def.type}; only an enum attribute has values`);
    }
    const values = cleanValues(edit.values);
    const dropped = (def.values ?? []).filter((value) => !values.includes(value));
    const holders = documentsOf(work, edit.kind).filter(
      (document) =>
        document.type === edit.type && dropped.includes(String(document.attributes[edit.attribute])),
    );
    if (holders.length) {
      throw new BoardError(`Cannot remove ${dropped.map((value) => `"${value}"`).join(', ')} from "${edit.attribute}"`, [
        `${plural(holders.length, 'document')} of the type "${edit.type}" ${holders.length === 1 ? 'holds' : 'hold'} a removed value, for example ${holders[0]!.id}.`,
        'Give those documents another value first.',
      ]);
    }
    node.set('values', flowSeq(work.doc, values));
  }

  if (edit.name !== undefined && edit.name !== edit.attribute) {
    renameAttribute(work, edit.kind, edit.type, edit.attribute, edit.name);
  }
}

function removeAttribute(work: Work, edit: Extract<ConfigEdit, { op: 'remove-attribute' }>): void {
  requireAttribute(work, edit.kind, edit.type, edit.attribute);
  attributesMap(work, edit.kind, edit.type).delete(edit.attribute);
  for (const node of documentsOf(work, edit.kind)) {
    if (node.type !== edit.type || !(edit.attribute in node.attributes)) continue;
    delete node.attributes[edit.attribute];
    work.changed.add(node);
  }
  if (edit.kind === 'issue' && !declaredElsewhere(work, edit.kind, edit.type, edit.attribute)) {
    followInRemotes(work, 'attributes', edit.attribute, null);
    followInRemotes(work, 'fields', edit.attribute, null);
  }
}

// -- the operation -----------------------------------------------------------

function applyEdit(work: Work, edit: ConfigEdit): void {
  switch (edit.op) {
    case 'add-type':
      return addType(work, edit);
    case 'update-type':
      return updateType(work, edit);
    case 'remove-type':
      return removeType(work, edit);
    case 'add-status':
      return addStatus(work, edit);
    case 'update-status':
      return updateStatus(work, edit);
    case 'remove-status':
      return removeStatus(work, edit);
    case 'add-attribute':
      return addAttribute(work, edit);
    case 'update-attribute':
      return updateAttribute(work, edit);
    case 'remove-attribute':
      return removeAttribute(work, edit);
    default:
      throw new BoardError(`Unknown config edit "${(edit as { op?: unknown }).op}"`);
  }
}

/** What an edit does, for an error message and for the commit message of a shared board. */
export function describeConfigEdit(edit: ConfigEdit): string {
  switch (edit.op) {
    case 'add-type':
      return `add the ${edit.kind} type ${edit.name}`;
    case 'update-type':
      return edit.name !== undefined && edit.name !== edit.type
        ? `rename the ${edit.kind} type ${edit.type} to ${edit.name}`
        : `relabel the ${edit.kind} type ${edit.type}`;
    case 'remove-type':
      return `remove the ${edit.kind} type ${edit.type}`;
    case 'add-status':
      return `add the status ${edit.id}`;
    case 'update-status':
      return edit.id !== undefined && edit.id !== edit.status
        ? `rename the status ${edit.status} to ${edit.id}`
        : `relabel the status ${edit.status}`;
    case 'remove-status':
      return `remove the status ${edit.status}`;
    case 'add-attribute':
      return `add the attribute ${edit.name} to ${edit.type}`;
    case 'update-attribute':
      return edit.name !== undefined && edit.name !== edit.attribute
        ? `rename the attribute ${edit.attribute} of ${edit.type} to ${edit.name}`
        : `change the attribute ${edit.attribute} of ${edit.type}`;
    case 'remove-attribute':
      return `remove the attribute ${edit.attribute} from ${edit.type}`;
    default:
      return 'edit the board config';
  }
}

/**
 * Apply `edits` to `.lpm/config.yml`, in order, and rewrite every document
 * that holds a renamed or removed name. The call writes everything or nothing:
 * each edit is checked against the result of the edits before it, and the
 * first write happens after the last check.
 */
export function editBoardConfig(paths: BoardPaths, edits: ConfigEdit[]): ConfigEditResultDto {
  if (!edits.length) return { rewritten: 0, renamedTypes: {}, notes: [] };
  const what =
    edits.length === 1 ? describeConfigEdit(edits[0]!) : `${describeConfigEdit(edits[0]!)} and ${edits.length - 1} more config edits`;

  return withBoardWrite(paths, what, () => {
    const board = loadBoard(paths);
    const work: Work = {
      paths,
      doc: parseDocument(readFileSync(paths.configPath, 'utf8')),
      config: board.config,
      board,
      changed: new Set(),
      renamedTypes: {},
      moves: [],
      notes: [],
      unranked: [],
    };

    for (const edit of edits) {
      applyEdit(work, edit);
      const parsed = parseConfigText(stringify(work.doc));
      if (!parsed.config) {
        throw new BoardError(`Cannot ${describeConfigEdit(edit)}: ${LPM_DIR}/${CONFIG_FILE} would not validate`, parsed.errors);
      }
      work.config = parsed.config;
    }

    for (const { key, type, from } of work.unranked) {
      if (work.config[key] !== from) continue;
      work.notes.push(`${key} still names "${from}". The type "${type}" no longer has an attribute of that name.`);
    }
    for (const node of work.changed) requireUnchanged(board, node);

    writeFileAtomic(paths.configPath, stringify(work.doc));
    // `writeDocument` orders the attributes of a document by the config, so the
    // handle must hold the config that was just written.
    board.config = work.config;
    for (const node of work.changed) writeDocument(board, node);
    for (const [from, to] of work.moves) {
      renameSync(from, to);
      work.notes.push(`Renamed the context template ${pathTail(from)} to ${pathTail(to)}.`);
    }
    writeBoardIndex(loadBoard(paths));

    return {
      rewritten: work.changed.size,
      renamedTypes: work.renamedTypes,
      notes: [...new Set(work.notes)],
    };
  });
}

/** The last two segments of a path, which is how a context template is named in a note. */
function pathTail(file: string): string {
  return file.split(/[\\/]/).slice(-2).join('/');
}
