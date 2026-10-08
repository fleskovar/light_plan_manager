/**
 * Reading and writing the `remotes:` block of config.yml in place.
 *
 * `init` is the only other command that writes config.yml, and it writes a
 * fresh file. `lpm remote add` and `lpm remote rm` edit an existing one, so
 * they must not destroy what is already there: a config full of the user's own
 * notes is a config they trust. The `yaml` package's document API reads the
 * file into a `Document` that keeps every comment and the key order, and
 * writes it back with only the `remotes:` block changed — never a
 * parse-and-restringify, which would drop the comments (LP-340's note).
 *
 * The whole file is re-validated with `parseConfigText` before anything is
 * written, so an `add` that would leave the board unable to load — a name that
 * collides, a scope that overlaps another remote's — is refused while the old
 * config is still on disk.
 */

import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isMap, parseDocument, YAMLMap } from 'yaml';
import type { Document } from 'yaml';
import { loadBoard } from '../core/board/load.js';
import { declaredScopes, scopeOverlaps } from '../core/board/remote-scopes.js';
import { parseConfigText } from '../core/config/schema.js';
import { remoteNamed, remoteNames } from '../core/config/lookup.js';
import { BoardError } from '../core/errors.js';
import { formatZodIssues } from '../core/model/zod.js';
import type { BoardConfig, RemoteDirection } from '../core/model/types.js';
import { writeFileAtomic } from '../core/storage/atomic.js';
import { withBoardLock } from '../core/storage/lock.js';
import type { BoardPaths } from '../core/storage/paths.js';
import { displayPath } from '../core/storage/paths.js';
import { staticCapabilities } from './capabilities.js';
import { linksPath } from './links.js';
import type { Provider } from './provider.js';
import { lookupProvider, providers } from './registry.js';
import { scaffoldMapping, type MappingMarker } from './scaffold.js';

/** Remote names follow core's IDENT_RE — the one rule the config also checks. */
const NAME_RE = /^[a-z][a-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Config document I/O
// ---------------------------------------------------------------------------

/** Read config.yml as a YAML `Document` — comments and key order intact. */
function readConfigDocument(paths: BoardPaths): Document {
  return parseDocument(readFileSync(paths.configPath, 'utf8'));
}

/** Write a YAML `Document` back to config.yml, atomically. */
function writeConfigDocument(paths: BoardPaths, doc: Document): void {
  writeFileAtomic(paths.configPath, doc.toString());
}

/**
 * The `remotes:` map at the root of a config document, creating it when it is
 * absent. A `remotes:` key that is not a map is a `BoardError` — the file has
 * been edited into a shape this command cannot safely extend.
 */
function remotesMapOf(root: YAMLMap, doc: Document, paths: BoardPaths): YAMLMap {
  const existing = root.get('remotes', true);
  if (existing === undefined || existing === null) {
    const created = doc.createNode({}) as YAMLMap;
    root.set('remotes', created);
    return created;
  }
  if (!isMap(existing)) {
    throw new BoardError(`The "remotes:" key in ${displayPath(paths, paths.configPath)} is not a mapping`, [
      'It must map remote names to remote declarations, e.g. remotes: { upstream: { provider: github, ... } }.',
    ]);
  }
  return existing;
}

/** Refuse a remote name that would make the board unloadable. */
function validateRemoteName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new BoardError(`Invalid remote name "${name}"`, [
      'Remote names must be lower_snake_case: letters, digits and underscores, starting with a letter.',
      'e.g. upstream, jira, gitlab_prod',
    ]);
  }
}

// ---------------------------------------------------------------------------
// Provider connection keys
// ---------------------------------------------------------------------------

/** The connection shape a provider's schema declares, keyed in declaration order. */
function connectionShapeOf(provider: Provider): Record<string, unknown> {
  const schema = provider.config as unknown as {
    shape?: { connection?: { shape?: Record<string, unknown> } };
  };
  return schema.shape?.connection?.shape ?? {};
}

/** The connection keys a provider's schema declares, in declaration order. */
export function connectionKeyNames(provider: Provider): string[] {
  return Object.keys(connectionShapeOf(provider));
}

/**
 * The `mapping` keys a provider's schema declares, in declaration order — read
 * off the schema exactly as the connection keys above are.
 *
 * This is what keeps the mapping scaffold honest about one provider at a time.
 * A key a provider does not declare is *stripped* by its schema on the way in
 * (a zod object is not strict here on purpose — an older spelling must still
 * parse), so drafting one into config.yml writes a mapping that has no effect
 * and reads as though it does: `jsonfile` declares no `accounts` and no
 * `periods`, and a `periods: { container: sprint }` under it claims sprints map
 * onto a remote container the file tracker has never had.
 *
 * An empty result means the shape could not be read, which is the same answer
 * as "unknown" — the caller drafts every block rather than none.
 */
export function mappingKeyNames(provider: Provider): string[] {
  const schema = provider.config as unknown as {
    shape?: { mapping?: { shape?: Record<string, unknown> } };
  };
  return Object.keys(schema.shape?.mapping?.shape ?? {});
}

/** The connection keys that hold secrets — never accepted as `add` flags. */
export function secretKeyNames(provider: Provider): string[] {
  return Object.keys(provider.credentials?.secrets ?? {});
}

/**
 * One connection key as a `lpm remote add` flag.
 *
 * `type` is what `util.parseArgs` needs (a `--tls_verify` that takes no value
 * is a different option from a `--file` that does), and `required` is what the
 * help line brackets. Both are read off the provider's own zod schema, so a
 * new provider is a folder and a registry line — never an edit here.
 */
export interface ConnectionFlag {
  name: string;
  type: 'string' | 'boolean';
  required: boolean;
}

/**
 * Unwrap the zod wrappers a connection key may be declared behind and report
 * the innermost type name. `optional`, `default`, `nullable` and `readonly`
 * hold an `innerType`; a `.transform()` compiles to a `pipe` whose `in` is the
 * declared schema — Jira's `board` is the worked example, a union piped
 * through a transform.
 */
function innerTypeOf(schema: unknown): { type: string; optional: boolean } {
  let def = (schema as { def?: Record<string, unknown> })?.def;
  let optional = false;
  for (let depth = 0; depth < 10; depth += 1) {
    const kind = def?.type;
    if (kind === 'optional' || kind === 'default' || kind === 'nullable' || kind === 'readonly') {
      if (kind === 'optional' || kind === 'default') optional = true;
      def = (def!.innerType as { def?: Record<string, unknown> })?.def;
      continue;
    }
    if (kind === 'pipe') {
      def = (def!.in as { def?: Record<string, unknown> })?.def;
      continue;
    }
    return { type: typeof kind === 'string' ? kind : 'unknown', optional };
  }
  return { type: 'unknown', optional };
}

/**
 * The connection keys a provider fills in for itself, given the remote's name
 * (`Provider.defaultConnection`) — `jsonfile`'s `file` is the worked example.
 * The name passed here is a placeholder: the contract is that the *key set*
 * does not depend on it, only the values do.
 */
function defaultedKeyNames(provider: Provider): string[] {
  return Object.keys(provider.defaultConnection?.('example') ?? {});
}

/**
 * The flags `lpm remote add` accepts for one provider: its connection keys,
 * minus the secrets (a token is never a flag — it resolves at sync time), each
 * with the `parseArgs` type and the required/optional split its schema states.
 *
 * A key the provider can default for itself is reported *optional* however the
 * schema declares it: the schema states what a fully declared remote must
 * carry, which is not the same question as what a person has to type. Getting
 * that wrong would print `--file <file>` as required for `jsonfile`, whose
 * whole point is that nobody should have to name the path.
 */
export function connectionFlags(provider: Provider): ConnectionFlag[] {
  const secrets = new Set(secretKeyNames(provider));
  const defaulted = new Set(defaultedKeyNames(provider));
  const flags: ConnectionFlag[] = [];
  for (const [name, schema] of Object.entries(connectionShapeOf(provider))) {
    if (secrets.has(name)) continue;
    const { type, optional } = innerTypeOf(schema);
    flags.push({
      name,
      type: type === 'boolean' ? 'boolean' : 'string',
      required: !optional && !defaulted.has(name),
    });
  }
  return flags;
}

/**
 * Every connection flag across every registered provider — what `add` must be
 * able to *parse* before it can tell one provider's key from another's.
 *
 * `parseArgs` needs one type per flag name, so two providers declaring the
 * same key with different types would be unrepresentable; a key that is
 * boolean for one provider and a string for another is reported here rather
 * than resolved silently, because the winner would depend on registry order.
 * `test/remote-config-file.test.ts` asserts the registry never does that.
 */
export function allConnectionFlags(): ConnectionFlag[] {
  const byName = new Map<string, ConnectionFlag>();
  for (const provider of Object.values(providers)) {
    for (const flag of connectionFlags(provider)) {
      const seen = byName.get(flag.name);
      if (!seen) {
        // `required` is per provider and meaningless in the union — an `add`
        // for provider A must still parse provider B's required key so the
        // mismatch is reported as "not a connection option for A".
        byName.set(flag.name, { ...flag, required: false });
        continue;
      }
      if (seen.type !== flag.type) {
        throw new BoardError(
          `Two providers declare the connection key "${flag.name}" with different types`,
          [
            `One declares it ${seen.type}, another ${flag.type}; \`lpm remote add\` can only parse one.`,
            'Rename one of the keys, or give them the same type.',
          ],
        );
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

/** What `addRemote` needs from its caller. */
export interface AddRemoteOptions {
  /** The remote's name, e.g. `upstream`. */
  name: string;
  /** The provider name, e.g. `github`. */
  provider: string;
  /**
   * The connection block, in the provider's own vocabulary, already gathered
   * from flags. Secret keys are absent — credentials never sit in the config.
   */
  connection: Record<string, unknown>;
  /** The subtree this remote mirrors; absent means the whole board. */
  scope?: string;
  /** Overwrite a remote of the same name. */
  force?: boolean;
}

/**
 * Render each `types:` and `statuses:` entry on one line.
 *
 * Both blocks are one-per-board-word and shaped alike (`remote:` plus a flag
 * or two), so block style spends three or four lines saying `epic: epic`. In
 * flow style the two read as the table they are — and read *alike*, which is
 * the point of their sharing a shape:
 *
 *     types:
 *       epic: { remote: [epic] }
 *     statuses:
 *       done: { remote: [Done], closed: true }
 *
 * Cosmetic only: the same YAML either way, and a person editing the file may
 * expand it back to block style whenever they like.
 */
function compactMappingEntries(node: unknown): void {
  const mapping = isMap(node) ? node.get('mapping', true) : undefined;
  if (!isMap(mapping)) return;
  for (const section of ['types', 'statuses']) {
    const block = mapping.get(section, true);
    if (!isMap(block)) continue;
    for (const pair of block.items) {
      const entry = pair.value;
      if (isMap(entry)) entry.flow = true;
    }
  }
}

/**
 * Refuse a remote that would mirror work another remote already mirrors.
 *
 * Two remotes may never claim the same document: it would be filed twice,
 * closed twice and edited from two directions, and neither remote can see the
 * other to sort it out. `parseConfigText` already refuses the half it can see
 * from the config alone (an equal scope, or either remote claiming the whole
 * board), and that check runs below on the edited text. This is the half that
 * needs the board tree — a scope *nested* inside another one — so it is the
 * only place `add` loads the board.
 *
 * The load is skipped unless some other remote is already declared with a
 * scope, which is the common case: the first remote on a board has nothing to
 * overlap with, and a board load is not free.
 */
function refuseOverlappingScope(
  paths: BoardPaths,
  config: BoardConfig,
  options: AddRemoteOptions,
): void {
  const scope = options.scope !== undefined && options.scope !== '' ? options.scope : undefined;
  if (scope === undefined) return; // a whole-board claim is caught by the config check

  const others = declaredScopes(config.remotes).filter(
    (remote) => remote.name !== options.name && remote.scope !== undefined,
  );
  if (others.length === 0) return;

  const board = loadBoard(paths);
  const overlaps = scopeOverlaps(board.issues, [...others, { name: options.name, scope }]);
  const mine = overlaps.filter(
    (overlap) => overlap.inner === options.name || overlap.outer === options.name,
  );
  if (mine.length === 0) return;

  throw new BoardError(
    `Cannot add remote "${options.name}" — its scope overlaps a remote that already exists`,
    [
      ...mine.map((overlap) =>
        overlap.inner === options.name
          ? `${scope} is inside "${overlap.outer}"'s scope (${overlap.outerScope}), which already mirrors it.`
          : `"${overlap.inner}"'s scope (${overlap.innerScope}) is inside ${scope}, so this remote would mirror it too.`,
      ),
      'Two remotes may not mirror the same work — it would be filed and closed twice, from two directions.',
      'Pick a scope outside the other remote, or `lpm remote rm` the one you are replacing.',
    ],
  );
}

/** What `addRemote` reports back, for the command to print. */
export interface AddRemoteResult {
  name: string;
  provider: string;
  /** The human-readable target the connection names. */
  target: string;
  /**
   * The connection block as written, defaults included — what the caller needs
   * to report which credentials are already resolvable and which are not.
   * Holds no secret: a secret key is never an `add` flag and never written here.
   */
  connection: Record<string, unknown>;
  /** True when an existing remote of the same name was replaced. */
  replaced: boolean;
  /**
   * Every decision the drafted mapping could not make on its own — a status
   * or type with no obvious remote counterpart, an account attribute to pick.
   * Empty means the mapping is ready to sync as drafted. `openRemote` refuses
   * the remote while any of these are still unresolved in config.yml.
   */
  markers: MappingMarker[];
}

/**
 * Add (or, with `--force`, replace) one remote in config.yml.
 *
 * The connection is validated by the provider's own schema before anything is
 * written, so a missing `repo` or a malformed `site` is refused while the old
 * config is still on disk. The written block carries the conservative policy
 * defaults — `on_delete: unlink`, `conflict: manual` — so a remote that has not
 * been given a mapping yet still parses, and never deletes anything on its own.
 *
 * `mapping` is drafted, not left empty: `scaffoldMapping` (LP-369) already
 * knows how to turn this board's own types, statuses and attributes into a
 * starting mapping against the provider's capabilities — asking a person to
 * retype that cross-product by hand was the actual UX bug, not a deliberate
 * "come back later" gap. There is no live connector at `add` time (no
 * credential has even been resolved yet), so the capability table is drafted
 * from `staticCapabilities` rather than a live probe: every fact the provider
 * states outright is used as-is, and every fact that can only be confirmed
 * live is resolved to the least-capable reading, never a guess that could
 * overclaim what the remote can hold. Whatever the scaffold could not decide
 * on its own is a `TODO:` marker in the written mapping and comes back in
 * `markers`, exactly as `findMarkers` would report it later — never a guess
 * and never a silent omission.
 *
 * A connection key the provider can work out from the remote's name alone
 * (`Provider.defaultConnection` — `jsonfile`'s `file`) is filled in here when
 * the caller did not pass it, so the flag is a override rather than a chore.
 * What the caller *did* pass always wins.
 */
export function addRemote(paths: BoardPaths, options: AddRemoteOptions): AddRemoteResult {
  validateRemoteName(options.name);

  const provider = lookupProvider(options.provider);
  const connection = {
    ...provider.defaultConnection?.(options.name),
    ...options.connection,
  };

  return withBoardLock(paths, `add remote ${options.name}`, () => {
    const doc = readConfigDocument(paths);
    const root = doc.contents;
    if (!isMap(root)) {
      throw new BoardError(`${displayPath(paths, paths.configPath)} is not a YAML mapping`, [
        'A light-plan config is a map of keys; this file has something else at its root.',
      ]);
    }

    // The board config this remote will mirror — parsed from the same text
    // we are about to edit, before the edit — is exactly what a mapping
    // scaffold needs (its types, statuses and attributes) and exactly what
    // must already be valid for `add` to have anything to draft against.
    const currentBoard = parseConfigText(doc.toString());
    if (!currentBoard.config) {
      throw new BoardError(
        `Cannot add remote "${options.name}" — ${displayPath(paths, paths.configPath)} does not currently validate`,
        currentBoard.errors,
      );
    }

    // A board shared through git cannot also mirror onto a tracker: git
    // replicates the whole folder, so ownership is decided for the whole board.
    if (currentBoard.config.git_sync) {
      throw new BoardError(
        `Cannot add remote "${options.name}" — this board is shared through git`,
        [
          'A board syncs through git or mirrors onto trackers, never both.',
          'Turn git sync off first with `lpm git off`, then add the tracker.',
        ],
      );
    }

    const mappingKeys = mappingKeyNames(provider);
    const scaffold = scaffoldMapping(currentBoard.config, staticCapabilities(provider.capabilities), {
      provider: options.provider,
      ...(provider.standardVocabulary !== undefined
        ? { vocabulary: provider.standardVocabulary }
        : {}),
      ...(mappingKeys.length > 0 ? { mappingKeys } : {}),
    });

    const parsed = provider.config.safeParse({ connection, mapping: scaffold.mapping });
    if (!parsed.success) {
      throw new BoardError(
        `Remote "${options.name}" (${options.provider}) is not configured correctly`,
        formatZodIssues(parsed.error).map((line) =>
          line.replace(/^connection\.([a-z_]+):/, (_match, key: string) => `--${key}:`),
        ),
      );
    }

    const remotes = remotesMapOf(root, doc, paths);
    const exists = remotes.has(options.name);
    if (exists && options.force !== true) {
      throw new BoardError(`A remote named "${options.name}" already exists`, [
        `Pass --force to replace it, or \`lpm remote rm ${options.name}\` to remove it first.`,
      ]);
    }

    refuseOverlappingScope(paths, currentBoard.config, options);

    const block: Record<string, unknown> = {
      provider: options.provider,
      on_delete: 'unlink',
      conflict: 'manual',
    };
    if (options.scope !== undefined && options.scope !== '') block.scope = options.scope;
    block.connection = connection;
    block.mapping = scaffold.mapping;

    const node = doc.createNode(block);
    compactMappingEntries(node);
    remotes.set(options.name, node);

    const text = doc.toString();
    const check = parseConfigText(text);
    if (!check.config) {
      throw new BoardError(
        `Cannot add remote "${options.name}" — the resulting config would not load`,
        check.errors,
      );
    }

    writeConfigDocument(paths, doc);
    return {
      name: options.name,
      provider: options.provider,
      target: describeTarget(options.provider, connection),
      connection,
      replaced: exists,
      markers: scaffold.markers,
    };
  });
}

// ---------------------------------------------------------------------------
// mapping corrections
// ---------------------------------------------------------------------------

/** The rewrites `updateRemoteMapping` applies, per mapping block. */
export interface MappingCorrections {
  /** `board type name → the remote's own spelling`. */
  types?: Record<string, string>;
  /** `board status id → the remote's own spelling`. */
  statuses?: Record<string, string>;
}

/** What `updateRemoteMapping` changed, as `<block>.<key>: old → new` lines. */
export interface MappingUpdateResult {
  changed: string[];
}

/**
 * Rewrite the `remote:` name of individual `mapping.types` / `mapping.statuses`
 * entries in place — what `lpm remote setup` does once it has asked the remote
 * what its words actually are.
 *
 * Surgical on purpose. It sets the one scalar under an existing entry and
 * touches nothing else: not the entry's `closed` flag, not the block's other
 * keys, not the comments a person wrote next to them, and not any part of the
 * file outside `remotes.<name>.mapping`. Re-drafting the whole block from the
 * scaffold would have been less code and would have thrown away every edit the
 * person had made since `add` — which is the thing a setup command must never
 * do, because the edits it discards are the ones it could not have made itself.
 *
 * A key the mapping does not declare is ignored rather than created: the
 * mapping's key set is the board's own vocabulary, and a remote reporting a word
 * for something this board does not have is not a reason to add a mapping entry.
 *
 * Runs under the board lock and re-validates the whole file before writing,
 * exactly as `addRemote` does.
 */
export function updateRemoteMapping(
  paths: BoardPaths,
  name: string,
  corrections: MappingCorrections,
): MappingUpdateResult {
  return withBoardLock(paths, `update remote mapping ${name}`, () => {
    const doc = readConfigDocument(paths);
    const root = doc.contents;
    if (!isMap(root)) {
      throw new BoardError(`${displayPath(paths, paths.configPath)} is not a YAML mapping`, [
        'A light-plan config is a map of keys; this file has something else at its root.',
      ]);
    }
    const remotes = root.get('remotes', true);
    if (!isMap(remotes)) {
      throw new BoardError(`No remote named "${name}"`, ['This board declares no remotes']);
    }
    const remote = remotes.get(name, true);
    if (!isMap(remote)) {
      throw new BoardError(`No remote named "${name}"`, [
        `Declared remotes: ${remotes.items
          .map((pair) => String((pair.key as { value?: unknown })?.value ?? ''))
          .filter((key) => key !== '')
          .join(', ')}`,
      ]);
    }
    const mapping = remote.get('mapping', true);
    if (!isMap(mapping)) {
      throw new BoardError(`Remote "${name}" has no mapping block to correct`, [
        `Run \`lpm remote add ${name} --provider <p> --force\` to draft one.`,
      ]);
    }

    const changed: string[] = [];
    for (const section of ['types', 'statuses'] as const) {
      const rewrites = corrections[section];
      if (!rewrites) continue;
      const block = mapping.get(section, true);
      if (!isMap(block)) continue;
      for (const [key, value] of Object.entries(rewrites)) {
        const entry = block.get(key, true);
        if (isMap(entry)) {
          const before = entry.get('remote');
          if (before === value) continue;
          entry.set('remote', value);
          changed.push(`${section}.${key}: ${String(before)} → ${value}`);
          continue;
        }
        // The shorthand spelling (`done: Done`). Keep it short rather than
        // expanding it to the object form — the file is somebody's to read.
        if (entry !== undefined && entry !== null) {
          const before = (entry as { value?: unknown }).value ?? entry;
          if (String(before) === value) continue;
          block.set(key, value);
          changed.push(`${section}.${key}: ${String(before)} → ${value}`);
        }
      }
    }

    if (changed.length === 0) return { changed };

    const text = doc.toString();
    const check = parseConfigText(text);
    if (!check.config) {
      throw new BoardError(
        `Cannot update remote "${name}" — the resulting config would not load`,
        check.errors,
      );
    }
    writeConfigDocument(paths, doc);
    return { changed };
  });
}

/**
 * Set one `connection` key on a declared remote, in place — what setup does
 * once it has asked the remote a question the person could not answer, such as
 * which Agile board a Jira project's sprints live on.
 *
 * Surgical, exactly like `updateRemoteMapping`: it sets the one scalar and
 * touches nothing else in the file. A key that already has a value is left
 * alone — discovery fills gaps, it never overrules a decision somebody wrote
 * down — and the whole file is re-validated before it is written.
 */
export function updateRemoteConnection(
  paths: BoardPaths,
  name: string,
  values: Readonly<Record<string, string | boolean>>,
  options: {
    /**
     * Replace a value that is already set, and let a blank remove an optional
     * key. Off by default, because discovery fills gaps and must never overrule
     * a decision somebody wrote down; an edit form is the caller that turns it
     * on, after `setRemoteConnection` has decided the change is safe.
     */
    overwrite?: boolean;
  } = {},
): MappingUpdateResult {
  return withBoardLock(paths, `update remote connection ${name}`, () => {
    const doc = readConfigDocument(paths);
    const root = doc.contents;
    if (!isMap(root)) {
      throw new BoardError(`${displayPath(paths, paths.configPath)} is not a YAML mapping`, [
        'A light-plan config is a map of keys; this file has something else at its root.',
      ]);
    }
    const remotes = root.get('remotes', true);
    const remote = isMap(remotes) ? remotes.get(name, true) : undefined;
    if (!isMap(remote)) {
      throw new BoardError(`No remote named "${name}"`, ['This board declares no remotes']);
    }
    const connection = remote.get('connection', true);
    if (!isMap(connection)) {
      throw new BoardError(`Remote "${name}" has no connection block`, [
        `Declare it again: lpm remote connect <provider> --name ${name} --force`,
      ]);
    }

    const changed: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      const before = connection.get(key);
      const had = before !== undefined && before !== null && String(before) !== '';
      if (had && options.overwrite !== true) continue;
      if (value === '') {
        if (!had) continue;
        connection.delete(key);
        changed.push(`connection.${key}: removed`);
        continue;
      }
      if (had && String(before) === String(value)) continue;
      connection.set(key, typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
      changed.push(`connection.${key}: ${String(value)}`);
    }
    if (changed.length === 0) return { changed };

    const check = parseConfigText(doc.toString());
    if (!check.config) {
      throw new BoardError(
        `Cannot update remote "${name}" — the resulting config would not load`,
        check.errors,
      );
    }
    writeConfigDocument(paths, doc);
    return { changed };
  });
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/** What `removeRemote` needs from its caller. */
export interface RemoveRemoteOptions {
  name: string;
  /** Also remove the per-remote state under `.lpm/remotes/<name>/`. */
  purge?: boolean;
}

/** What `removeRemote` reports back. */
export interface RemoveRemoteResult {
  name: string;
  /** True when the per-remote folder was removed. */
  purged: boolean;
}

/**
 * Remove one remote's declaration from config.yml. The per-remote state — the
 * link store, mapping fingerprint, caches, resolutions and audit log — is kept
 * unless `--purge`, because dropping the declaration is an edit a person may
 * undo; the state is the expensive half to rebuild.
 */
export function removeRemote(paths: BoardPaths, options: RemoveRemoteOptions): RemoveRemoteResult {
  return withBoardLock(paths, `remove remote ${options.name}`, () => {
    const doc = readConfigDocument(paths);
    const root = doc.contents;
    if (!isMap(root)) {
      throw new BoardError(`${displayPath(paths, paths.configPath)} is not a YAML mapping`, [
        'A light-plan config is a map of keys; this file has something else at its root.',
      ]);
    }

    // A turned-off remote is still a declared one, and removing it for good is
    // the one thing turning it off deliberately does not do.
    const block = (['remotes', 'remotes_off'] as const)
      .map((key) => root.get(key, true))
      .find((map) => isMap(map) && map.has(options.name));
    if (!isMap(block)) {
      throw new BoardError(`No remote named "${options.name}"`, [
        'Nothing was removed. `lpm remote` lists the declared remotes.',
      ]);
    }

    block.delete(options.name);
    if (block.items.length === 0 && root.get('remotes_off', true) === block) root.delete('remotes_off');

    const text = doc.toString();
    const check = parseConfigText(text);
    if (!check.config) {
      throw new BoardError(
        `Cannot remove remote "${options.name}" — the resulting config would not load`,
        check.errors,
      );
    }

    writeConfigDocument(paths, doc);

    if (options.purge === true) {
      rmSync(path.join(paths.remotesDir, options.name), { recursive: true, force: true });
    }

    return { name: options.name, purged: options.purge === true };
  });
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** One remote as `lpm remote` lists it. */
export interface RemoteSummary {
  name: string;
  provider: string;
  direction: RemoteDirection;
  /** The connection value that names where the issues live. */
  target: string;
  /** The most recent sync across links, or undefined when never synced. */
  lastSync?: string;
}

/**
 * The human-readable target of a remote: the one connection value that names
 * where its issues live. Known per provider; a provider this table does not
 * know falls back to the provider name, so a new adapter still lists.
 */
export function describeTarget(provider: string, connection: Record<string, unknown>): string {
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = connection[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return undefined;
  };

  switch (provider) {
    case 'github':
      return first('repo') ?? provider;
    case 'jira': {
      const site = first('site');
      const project = first('project');
      if (site !== undefined && project !== undefined) {
        const host = site.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        return `${project} @ ${host}`;
      }
      return project ?? site ?? provider;
    }
    case 'jsonfile':
      return first('file') ?? provider;
    case 'linear':
      return first('team') ?? provider;
    default:
      return provider;
  }
}

/**
 * The most recent sync timestamp across a remote's link store, or `undefined`
 * when it has never synced. Read leniently: a missing or unparseable store is
 * "never", because a listing must not fall over on one broken remote.
 */
export function lastSyncOf(paths: BoardPaths, name: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(linksPath(paths, name), 'utf8');
  } catch {
    return undefined;
  }

  let latest: string | undefined;
  try {
    const parsed = JSON.parse(raw) as {
      links?: Record<string, { syncedAt?: unknown }>;
      tombstones?: Record<string, { at?: unknown }>;
    };
    const consider = (value: unknown): void => {
      if (typeof value === 'string' && value !== '' && (latest === undefined || value > latest)) {
        latest = value;
      }
    };
    for (const entry of Object.values(parsed.links ?? {})) consider(entry?.syncedAt);
    for (const entry of Object.values(parsed.tombstones ?? {})) consider(entry?.at);
  } catch {
    return undefined;
  }
  return latest;
}

/** Every declared remote, in sorted-name order, for `lpm remote` to list. */
export function summarizeRemotes(paths: BoardPaths, config: BoardConfig): RemoteSummary[] {
  return remoteNames(config).map((name) => {
    const remote = remoteNamed(config, name)!;
    return {
      name,
      provider: remote.provider,
      direction: remote.direction,
      target: describeTarget(remote.provider, remote.connection),
      lastSync: lastSyncOf(paths, name),
    };
  });
}
