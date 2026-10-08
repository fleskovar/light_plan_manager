/**
 * Credential resolution (LP-295).
 *
 * A connection block names *where* a secret comes from, never the secret: the
 * config is committed, so a token written into it travels to every clone. The
 * resolver turns a connection value into the actual secret at sync time, in
 * this order:
 *
 *   1. `${VAR}`                        — an explicit reference into the
 *                                        environment;
 *   2. `.lpm/credentials.json`          — git-ignored, written by
 *                                        `lpm remote login`;
 *   3. the platform's own env var       — `GITHUB_TOKEN`, `JIRA_API_TOKEN`, …;
 *   4. fail, naming all three options.
 *
 * A literal secret in the connection is refused here — and reported by the
 * check — because a secret in the committed config is the one mistake a shared
 * repo cannot recover from. Nothing here prints the value: a resolved secret
 * travels only into the connector, and errors name the *where*, never the
 * secret itself.
 */

import { chmodSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '../core/storage/atomic.js';
import { BoardError } from '../core/errors.js';
import type { BoardPaths } from '../core/storage/paths.js';
import { displayPath } from '../core/storage/paths.js';

/** A `${VAR}` reference — the whole value and nothing else. */
const REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** True when a connection value is an explicit `${VAR}` reference. */
export function isEnvReference(value: unknown): value is string {
  return typeof value === 'string' && REF_RE.test(value.trim());
}

/** The variable name an env reference points at. Call only when `isEnvReference`. */
export function envReferenceName(value: string): string {
  return REF_RE.exec(value.trim())![1]!;
}

/**
 * True when a connection value is a literal secret: a non-empty string that is
 * not a `${VAR}` reference. The check reports these and the resolver refuses
 * them — one predicate, so the two cannot disagree about what "literal" means.
 */
export function isLiteralSecret(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && !isEnvReference(value);
}

/** One resolved secret: the value, plus the name and source a 401 can mention. */
export interface ResolvedSecret {
  value: string;
  /** The credential's name — `GITHUB_TOKEN` from the env, or the connection key. */
  name: string;
  /** Where the value came from, a phrase like `the environment`. */
  source: string;
}

/** `.lpm/credentials.json`: remote name → connection key → secret value. */
type CredentialsFile = Record<string, Record<string, string>>;

/** Normalize a parsed credentials document into `CredentialsFile`. */
function normalizeCredentials(parsed: unknown): CredentialsFile {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: CredentialsFile = {};
  for (const [remote, entry] of Object.entries(parsed)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === 'string' && value.trim() !== '') values[key] = value;
    }
    out[remote] = values;
  }
  return out;
}

/** Read `.lpm/credentials.json`; `{}` when absent, `BoardError` when malformed. */
export function readCredentialsFile(paths: BoardPaths): CredentialsFile {
  let text: string;
  try {
    text = readFileSync(paths.credentialsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BoardError(`Cannot read ${displayPath(paths, paths.credentialsPath)}`, [
      `The file exists but is not valid JSON: ${(error as Error).message}`,
      'Recreate it with: lpm remote login <name>',
    ]);
  }
  return normalizeCredentials(parsed);
}

/**
 * Read `.lpm/credentials.json` the way `lpm remote login` does: a malformed
 * file is treated as empty, because login is the fix for one.
 */
function readCredentialsFileLenient(paths: BoardPaths): CredentialsFile {
  try {
    return readCredentialsFile(paths);
  } catch {
    return {};
  }
}

/** The credential `.lpm/credentials.json` holds for one remote and key, if any. */
export function readCredential(
  paths: BoardPaths,
  remote: string,
  key: string,
): string | undefined {
  return readCredentialsFile(paths)[remote]?.[key];
}

/**
 * Write one secret into `.lpm/credentials.json`, preserving every other
 * remote and key. The file is written owner-only (0600) and healed into
 * `.lpm/.gitignore`, so it can never be committed by accident.
 */
export function writeCredential(
  paths: BoardPaths,
  remote: string,
  key: string,
  value: string,
): void {
  const file = readCredentialsFileLenient(paths);
  file[remote] = { ...(file[remote] ?? {}), [key]: value };
  writeFileAtomic(paths.credentialsPath, `${JSON.stringify(file, null, 2)}\n`);
  chmodSync(paths.credentialsPath, 0o600);
}

/** Resolve one connection value into a secret, following the LP-295 order. */
export function resolveSecret(opts: {
  /** The remote's name, for the error message and the credentials lookup. */
  remote: string;
  /** The connection key holding the secret, e.g. `token`. */
  key: string;
  /** The platform's own env var, e.g. `GITHUB_TOKEN`. */
  conventionalEnv?: string;
  /** The raw connection value: `${VAR}`, a literal, or undefined. */
  configured: unknown;
  paths: BoardPaths;
}): ResolvedSecret {
  const { remote, key, conventionalEnv, configured, paths } = opts;

  if (typeof configured === 'string' && configured.trim() !== '') {
    const value = configured.trim();
    if (isEnvReference(value)) {
      const name = envReferenceName(value);
      const fromEnv = process.env[name];
      if (fromEnv === undefined || fromEnv === '') {
        throw new BoardError(`The credential for remote "${remote}" is not set`, [
          `connection.${key} references \${${name}}, which is not in the environment`,
          `Set it with: export ${name}=...`,
        ]);
      }
      return { value: fromEnv, name, source: 'the environment' };
    }
    throw new BoardError(`Remote "${remote}" has a literal credential in config.yml`, [
      `connection.${key} holds a secret; the config is committed and must never carry one`,
      `Use connection.${key}: \${${conventionalEnv ?? 'TOKEN'}} instead, or omit it and run: lpm remote login ${remote}`,
    ]);
  }

  const fromFile = readCredential(paths, remote, key);
  if (fromFile !== undefined) {
    return { value: fromFile, name: key, source: '.lpm/credentials.json' };
  }

  if (conventionalEnv) {
    const fromEnv = process.env[conventionalEnv];
    if (fromEnv !== undefined && fromEnv !== '') {
      return { value: fromEnv, name: conventionalEnv, source: 'the environment' };
    }
  }

  const options = [
    `${displayPath(paths, paths.credentialsPath)} — write it with: lpm remote login ${remote}`,
  ];
  if (conventionalEnv) options.push(`the ${conventionalEnv} environment variable`);
  options.push(`an explicit connection.${key}: \${VAR} reference in config.yml`);
  throw new BoardError(`No credential for remote "${remote}"`, options);
}

/** One secret key's state, without resolving (or printing) the value itself. */
export interface CredentialState {
  /** The connection key that holds the secret, e.g. `token`. */
  key: string;
  /** The platform's conventional environment variable, when it has one. */
  env?: string;
  /** Where the value would come from, or `undefined` when nothing holds one. */
  source?: string;
  /** The `${VAR}` name the config points at, when it points at one. */
  reference?: string;
}

/**
 * Report which of a remote's secrets are already available and from where —
 * the read-only twin of `resolveSecret`, for a command that wants to *tell a
 * person what to do next* rather than make a request.
 *
 * `resolveSecret` throws when nothing holds the value, which is right for a
 * sync and wrong for `lpm remote add`: a person who has just declared a remote
 * needs the instructions, not a stack of errors. So this answers the same
 * question without the failure, and without ever reading the value into a
 * place it could be printed — only its *source*.
 */
export function credentialStates(
  remote: string,
  connection: Record<string, unknown>,
  secrets: Record<string, string>,
  paths: BoardPaths,
): CredentialState[] {
  const states: CredentialState[] = [];
  for (const [key, env] of Object.entries(secrets)) {
    const configured = connection[key];
    const state: CredentialState = { key, ...(env ? { env } : {}) };
    if (isEnvReference(configured)) {
      const name = envReferenceName(configured);
      state.reference = name;
      const value = process.env[name];
      if (value !== undefined && value !== '') state.source = `$${name}`;
    } else if (isLiteralSecret(configured)) {
      // A literal secret is refused by the resolver; report it as unset rather
      // than as available, so the guidance says what to do instead.
      states.push(state);
      continue;
    }
    if (state.source === undefined && readCredential(paths, remote, key) !== undefined) {
      state.source = displayPath(paths, paths.credentialsPath);
    }
    if (state.source === undefined && env !== undefined) {
      const value = process.env[env];
      if (value !== undefined && value !== '') state.source = `$${env}`;
    }
    states.push(state);
  }
  return states;
}

/**
 * Resolve every secret key of a connection block, returning a copy with the
 * values filled in. Non-secret keys pass through untouched. A secret the
 * config omits entirely is still resolved through the fallback chain, so a
 * connector never sees `undefined` where it expected a token.
 */
export function resolveConnectionSecrets(
  remote: string,
  connection: Record<string, unknown>,
  secrets: Record<string, string>,
  paths: BoardPaths,
): Record<string, unknown> {
  const resolved = { ...connection };
  for (const [key, conventionalEnv] of Object.entries(secrets)) {
    resolved[key] = resolveSecret({
      remote,
      key,
      conventionalEnv,
      configured: connection[key],
      paths,
    }).value;
  }
  return resolved;
}
