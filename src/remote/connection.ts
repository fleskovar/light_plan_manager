/**
 * Connecting a remote and storing its credential, for a caller with no
 * terminal to ask at — the web UI.
 *
 * `lpm remote connect` and `lpm remote login` gather their answers one question
 * at a time; a form sends them all at once. What both must refuse is the same,
 * and it lives here once:
 *
 *   - **A secret never lands in config.yml.** A credential key sent as a
 *     connection value is refused before anything is written — `addRemote`
 *     would otherwise draft it into a file that is committed.
 *   - **Only a declared credential key is stored**, exactly as `login` refuses
 *     a `--key` the provider does not have.
 *   - **A blank keeps what is there** — the form's equivalent of a bare Enter at
 *     the `login` prompt, so re-saving to replace one expired token does not
 *     demand the other half of the credential back.
 *   - **A remote that already mirrors documents is not re-pointed in place.**
 *     Changing its repo, site or project would leave every twin in its link
 *     store naming an issue in the old place. Pointing a board somewhere else
 *     is a remove and a new connect, deliberately, so it is refused here rather
 *     than reconciled.
 *
 * Nothing here returns a secret value. A credential's *state* comes from
 * `credentialStates`, which says where a value comes from and never what it is.
 */

import { remoteNamed, remoteNames } from '../core/config/lookup.js';
import { BoardError } from '../core/errors.js';
import type { BoardConfig, RemoteConfig } from '../core/model/types.js';
import { ensureLocalIgnored } from '../core/storage/local.js';
import type { BoardPaths } from '../core/storage/paths.js';
import {
  addRemote,
  connectionFlags,
  secretKeyNames,
  updateRemoteConnection,
  type AddRemoteResult,
  type MappingUpdateResult,
} from './config-file.js';
import { credentialStates, writeCredential, type CredentialState } from './credentials.js';
import { loadLinkStore } from './links.js';
import type { Provider } from './provider.js';
import { lookupProvider } from './registry.js';

/** A declared remote, or a `BoardError` naming the ones that are. */
function requireDeclared(config: BoardConfig, name: string): RemoteConfig {
  const declared = remoteNamed(config, name);
  if (!declared) {
    const names = remoteNames(config);
    throw new BoardError(`No remote named "${name}"`, [
      names.length > 0 ? `Declared remotes: ${names.join(', ')}` : 'This board declares no remotes',
    ]);
  }
  return declared;
}

/** Refuse a key that is a credential, sent where a connection value belongs. */
function refuseSecret(providerName: string, key: string): never {
  throw new BoardError(`"${key}" is a credential of provider "${providerName}", not a connection value`, [
    'Credentials are stored in .lpm/credentials.json, which is git-ignored — never in config.yml, which is committed.',
  ]);
}

/** Refuse a key the provider does not declare at all. */
function refuseUnknown(providerName: string, key: string, provider: Provider): never {
  const known = connectionFlags(provider).map((flag) => flag.name);
  throw new BoardError(`"${key}" is not a connection option for provider "${providerName}"`, [
    `Its connection options are: ${known.join(', ') || 'none'}`,
  ]);
}

/**
 * Refuse a credential key the provider does not declare — `login --key`'s rule,
 * for a caller that sends several keys at once.
 */
export function assertCredentialKeys(remote: string, providerName: string, keys: readonly string[]): void {
  if (keys.length === 0) return;
  const declared = secretKeyNames(lookupProvider(providerName));
  if (declared.length === 0) {
    throw new BoardError(`Remote "${remote}" (${providerName}) needs no credential`, [
      'This provider holds no secrets, so there is nothing to store.',
    ]);
  }
  for (const key of keys) {
    if (!declared.includes(key)) {
      throw new BoardError(`"${key}" is not a credential of provider "${providerName}"`, [
        `Its credential keys are: ${declared.join(', ')}`,
      ]);
    }
  }
}

/**
 * Store the credential values given, in `.lpm/credentials.json`.
 *
 * Every key is checked before any is written, so a refused key never leaves the
 * file half-updated. A blank value is skipped — it keeps what is already there.
 * Returns the keys actually written, never their values.
 */
export function storeCredentials(
  paths: BoardPaths,
  remote: string,
  providerName: string,
  values: Readonly<Record<string, string>>,
): string[] {
  assertCredentialKeys(remote, providerName, Object.keys(values));
  const written: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') continue;
    writeCredential(paths, remote, key, value);
    written.push(key);
  }
  if (written.length > 0) ensureLocalIgnored(paths);
  return written;
}

/** One declared remote's credential states — where each value comes from, never the value. */
export function remoteCredentialStates(paths: BoardPaths, config: BoardConfig, name: string): CredentialState[] {
  const declared = requireDeclared(config, name);
  const provider = lookupProvider(declared.provider);
  return credentialStates(name, declared.connection, provider.credentials?.secrets ?? {}, paths);
}

/** What `connectRemote` needs: the answers a connect form collected. */
export interface ConnectRemoteOptions {
  name: string;
  provider: string;
  /** Non-secret connection values. A blank is treated as not given. */
  connection: Readonly<Record<string, string | boolean>>;
  scope?: string;
  /** Credential values to store alongside. A blank is skipped. */
  credentials?: Readonly<Record<string, string>>;
  /** Replace a remote of the same name — the mapping is drafted again. */
  force?: boolean;
}

/** What `connectRemote` did: the declaration, and where each credential now stands. */
export interface ConnectRemoteResult extends AddRemoteResult {
  /** The credential keys this call stored. */
  stored: string[];
  credentials: CredentialState[];
}

/**
 * The connection values a form sent, checked against the provider: a secret is
 * refused (it would be written into a committed file), an undeclared key is
 * refused (a typo would otherwise be a silently missing value), and a blank is
 * dropped so the provider's default — or the schema's own "required" message —
 * applies. A boolean is written only when set, as `lpm remote add` does.
 */
function cleanConnection(
  providerName: string,
  provider: Provider,
  given: Readonly<Record<string, string | boolean>>,
): Record<string, unknown> {
  const secrets = new Set(secretKeyNames(provider));
  const known = new Set(connectionFlags(provider).map((flag) => flag.name));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(given)) {
    if (secrets.has(key)) refuseSecret(providerName, key);
    if (!known.has(key)) refuseUnknown(providerName, key, provider);
    if (typeof value === 'boolean') {
      if (value) out[key] = true;
      continue;
    }
    const trimmed = String(value).trim();
    if (trimmed !== '') out[key] = trimmed;
  }
  return out;
}

/**
 * Declare a remote and store its credential in one call — `lpm remote connect`
 * with every question answered up front.
 *
 * Everything that can be refused is refused before anything is written: the
 * name, the connection keys and the credential keys. `addRemote` then validates
 * the connection against the provider's schema and drafts the mapping, exactly
 * as it does for the CLI.
 */
export function connectRemote(
  paths: BoardPaths,
  config: BoardConfig,
  options: ConnectRemoteOptions,
): ConnectRemoteResult {
  const provider = lookupProvider(options.provider);
  if (remoteNames(config).includes(options.name) && options.force !== true) {
    throw new BoardError(`This board already has a remote named "${options.name}"`, [
      'Choose another name, or replace it deliberately — its mapping is drafted again, and its link store is kept.',
    ]);
  }
  const connection = cleanConnection(options.provider, provider, options.connection);
  const credentials = options.credentials ?? {};
  assertCredentialKeys(options.name, options.provider, Object.keys(credentials));

  const result = addRemote(paths, {
    name: options.name,
    provider: options.provider,
    connection,
    ...(options.scope !== undefined && options.scope.trim() !== '' ? { scope: options.scope.trim() } : {}),
    force: options.force === true,
  });
  const stored = storeCredentials(paths, result.name, options.provider, credentials);

  return {
    ...result,
    stored,
    credentials: credentialStates(result.name, result.connection, provider.credentials?.secrets ?? {}, paths),
  };
}

/**
 * Change connection values on a declared remote.
 *
 * A gap is always filled, and an optional value may be removed by sending a
 * blank. Changing a value that is already set is **re-pointing** the remote,
 * and a remote that already mirrors documents cannot be re-pointed in place —
 * with one exception decided by the provider, not by this file: a key the
 * provider declares as *conditional* (Jira's Agile board, which says where
 * sprints live and never where issues are) may be corrected at any time, and so
 * may a boolean switch. A switch is only ever set to `true` or removed.
 */
export function setRemoteConnection(
  paths: BoardPaths,
  config: BoardConfig,
  name: string,
  values: Readonly<Record<string, string | boolean>>,
): MappingUpdateResult {
  const declared = requireDeclared(config, name);
  const provider = lookupProvider(declared.provider);
  const secrets = new Set(secretKeyNames(provider));
  const flags = new Map(connectionFlags(provider).map((flag) => [flag.name, flag]));
  const conditional = new Set((provider.conditionalConnection ?? []).map((need) => need.key));
  const current = declared.connection as Record<string, unknown>;

  const changes: Record<string, string | boolean> = {};
  const repointed: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (secrets.has(key)) refuseSecret(declared.provider, key);
    const flag = flags.get(key);
    if (flag === undefined) refuseUnknown(declared.provider, key, provider);

    // A switch is set or removed, never written `false`. Absent is every
    // switch's schema default, and for Jira's `tls_verify` an explicit `false`
    // is what turns certificate checking *off* — a "loud, never-default
    // fallback" that must be typed into config.yml on purpose, not reached by
    // unticking a box. Removing the key restores the default instead.
    const value = raw === false ? '' : typeof raw === 'boolean' ? raw : String(raw).trim();
    const before = current[key];
    const had = before !== undefined && before !== null && String(before) !== '';

    if (value === '' && flag.required) {
      throw new BoardError(`${key} is required for provider "${declared.provider}"`, [
        'The remote cannot be reached without it, so it can be changed but not removed.',
      ]);
    }
    if (had && String(before) === String(value)) continue;
    // An explicit `false` written by hand is a decision somebody made in the
    // file; a form's untick does not overrule it.
    if (raw === false && String(before) === 'false') continue;
    if (!had && value === '') continue;
    if (had && typeof value === 'string' && !conditional.has(key)) repointed.push(key);
    changes[key] = value;
  }
  if (Object.keys(changes).length === 0) return { changed: [] };

  if (repointed.length > 0) {
    const linked = loadLinkStore(paths, name).links.size;
    if (linked > 0) {
      throw new BoardError(
        `Remote "${name}" already mirrors ${linked} document${linked === 1 ? '' : 's'}, so ${repointed.join(
          ', ',
        )} cannot change in place`,
        [
          'Every twin in its link store names an issue where the remote points now — pointing it elsewhere would leave them naming issues that are not there.',
          'To point this board at a different project, remove the remote and connect it again.',
        ],
      );
    }
  }

  return updateRemoteConnection(paths, name, changes, { overwrite: true });
}
