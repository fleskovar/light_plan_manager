/**
 * The resolution store (LP-287) — pending conflict decisions recorded by
 * `lpm remote resolve`, applied by the next sync.
 *
 * A conflict is a field both sides edited against the base snapshot.  The
 * merge (`merge.ts`) ends at the four-case table and names the disagreement;
 * the policy (`policy.ts`) decides it from the remote's config.  This file
 * holds the *third* layer: a decision a person made about one document, which
 * outranks the config policy but is recorded rather than acted on — resolving
 * does not itself write to the remote or to the board.
 *
 * ## The mental model
 *
 * `lpm remote resolve LP-12 --local` records "for LP-12, the local side wins".
 * It is a decision *about the base*: the next sync reads it, breaks the
 * conflict in the named direction (push the local value, or pull the remote
 * one), updates the base from the winning side, and clears the decision.  A
 * resolution therefore never makes a request of its own — `resolve` is offline
 * and testable, and the sync is where the decision lands.
 *
 * ## Shape
 *
 * Lives under `.lpm/remotes/<name>/resolutions.json`, beside `links.json`.
 * A resolution is per document and per field: a whole-document `default`
 * (what `--local` / `--remote` write) plus per-field overrides (what
 * `--field status --remote` writes).  The most specific wins: a field named in
 * `fields` beats the document's `default`, which beats the remote's config
 * policy.  A sibling `audit.log` (JSONL) keeps the human-readable trail of
 * every decision, so a board can answer "who settled what and when".
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from '../core/storage/paths.js';
import { BoardError } from '../core/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which side a resolution names as the winner. */
export type ResolutionOwner = 'local' | 'remote';

/** One document's pending decisions. */
export interface DocumentResolution {
  /** The decision for every field not named in `fields`. */
  default?: ResolutionOwner;
  /** Per-field decisions, most specific first. */
  fields?: Record<string, ResolutionOwner>;
}

/** What lives on disk inside `.lpm/remotes/<name>/resolutions.json`. */
export interface ResolutionFile {
  version: 1;
  /** Every document with at least one pending decision, keyed by local id. */
  resolutions: Record<string, DocumentResolution>;
}

/** The resolution store in memory. */
export interface ResolutionStore {
  version: number;
  resolutions: Map<string, DocumentResolution>;
}

/** One line of the audit log: a decision, as it was recorded. */
export interface ResolveAuditEntry {
  /** ISO timestamp. */
  at: string;
  /** Whoever `lpm me` / the environment said was driving. */
  author: string;
  /** The document the decision is about. */
  localId: string;
  /** The whole-document winner, when one was recorded. */
  default?: ResolutionOwner;
  /** The per-field winners, when any were recorded. */
  fields?: Record<string, ResolutionOwner>;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** The path to one remote's resolution store. */
export function resolutionsPath(paths: BoardPaths, remoteName: string): string {
  return path.join(paths.remotesDir, remoteName, 'resolutions.json');
}

/** The path to one remote's append-only audit log. */
export function auditLogPath(paths: BoardPaths, remoteName: string): string {
  return path.join(paths.remotesDir, remoteName, 'audit.log');
}

function emptyStore(): ResolutionStore {
  return { version: 1, resolutions: new Map() };
}

/**
 * Read the resolution store from disk.  A missing file is a valid empty store
 * — no decisions have been recorded.  A file that exists but is malformed is a
 * `BoardError` naming the path and the offending key, like the link store.
 */
export function loadResolutions(paths: BoardPaths, remoteName: string): ResolutionStore {
  const file = resolutionsPath(paths, remoteName);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return emptyStore();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BoardError(`Cannot parse resolution store: ${file}`, [
      (error as Error).message,
      'Delete it to discard every pending decision, or repair the JSON.',
    ]);
  }

  const data = parsed as Partial<ResolutionFile>;
  if (data.version !== 1) {
    throw new BoardError(`Unsupported resolution store version in ${file}`, [
      `Found version ${JSON.stringify(data.version)}; expected 1.`,
      'Delete it to discard every pending decision.',
    ]);
  }

  const resolutions = new Map<string, DocumentResolution>();
  if (data.resolutions && typeof data.resolutions === 'object') {
    for (const [localId, entry] of Object.entries(data.resolutions)) {
      if (!entry || typeof entry !== 'object') {
        throw new BoardError(`Invalid resolution store: ${file}`, [
          `Resolution "${localId}" is not an object (got ${typeof entry}).`,
          'Delete it to discard every pending decision, or repair the entry.',
        ]);
      }
      const record = entry as Record<string, unknown>;
      const resolution: DocumentResolution = {};
      if (record.default !== undefined) {
        if (record.default !== 'local' && record.default !== 'remote') {
          throw new BoardError(`Invalid resolution store: ${file}`, [
            `Resolution "${localId}".default must be "local" or "remote" (got ${JSON.stringify(record.default)}).`,
          ]);
        }
        resolution.default = record.default;
      }
      if (record.fields !== undefined) {
        if (!record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) {
          throw new BoardError(`Invalid resolution store: ${file}`, [
            `Resolution "${localId}".fields must be an object mapping field names to "local" or "remote".`,
          ]);
        }
        const fields: Record<string, ResolutionOwner> = {};
        for (const [field, owner] of Object.entries(record.fields)) {
          if (owner !== 'local' && owner !== 'remote') {
            throw new BoardError(`Invalid resolution store: ${file}`, [
              `Resolution "${localId}".fields.${field} must be "local" or "remote" (got ${JSON.stringify(owner)}).`,
            ]);
          }
          fields[field] = owner;
        }
        resolution.fields = fields;
      }
      resolutions.set(localId, resolution);
    }
  }

  return { version: data.version, resolutions };
}

/**
 * Write the resolution store to disk, creating the per-remote folder if needed.
 * Keys are written in sorted order so two people recording decisions on
 * different documents produce a mergeable diff.
 */
export function saveResolutions(
  paths: BoardPaths,
  remoteName: string,
  store: ResolutionStore,
): void {
  const file = resolutionsPath(paths, remoteName);
  mkdirSync(path.dirname(file), { recursive: true });

  const sortedIds = [...store.resolutions.keys()].sort();
  const resolutions: Record<string, DocumentResolution> = {};
  for (const id of sortedIds) {
    const entry = store.resolutions.get(id)!;
    const onDisk: DocumentResolution = {};
    if (entry.default !== undefined) onDisk.default = entry.default;
    if (entry.fields !== undefined) {
      onDisk.fields = Object.fromEntries([...Object.keys(entry.fields)].sort().map((k) => [k, entry.fields![k]!]));
    }
    resolutions[id] = onDisk;
  }

  const fileBody: ResolutionFile = { version: 1, resolutions };
  writeFileSync(file, `${JSON.stringify(fileBody, null, 2)}\n`, 'utf8');
}

/**
 * Append one decision to the audit log, creating the file on first use.  The
 * log is append-only and never read back by this module — it is the durable,
 * human-readable record, not the mechanism the sync consults.
 */
export function appendResolveAudit(
  paths: BoardPaths,
  remoteName: string,
  entry: ResolveAuditEntry,
): void {
  const file = auditLogPath(paths, remoteName);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Queries and mutations (pure — no I/O)
// ---------------------------------------------------------------------------

/**
 * The pending decision for one field of one document: its per-field winner
 * when one was recorded, else its whole-document default.  Undefined when the
 * document has no pending decision — the config policy then applies.
 */
export function ownerFor(
  store: ResolutionStore,
  localId: string,
  field: string,
): ResolutionOwner | undefined {
  const resolution = store.resolutions.get(localId);
  if (!resolution) return undefined;
  return resolution.fields?.[field] ?? resolution.default;
}

/**
 * Record a whole-document decision, replacing whatever was there.  `--local` /
 * `--remote` is the stronger statement than a per-field one, so it clears the
 * per-field overrides it supersedes.
 */
export function recordDocumentResolution(
  store: ResolutionStore,
  localId: string,
  owner: ResolutionOwner,
): void {
  store.resolutions.set(localId, { default: owner });
}

/**
 * Record a per-field decision, preserving the document's default and its other
 * per-field decisions.
 */
export function recordFieldResolution(
  store: ResolutionStore,
  localId: string,
  field: string,
  owner: ResolutionOwner,
): void {
  const existing = store.resolutions.get(localId);
  if (!existing) {
    store.resolutions.set(localId, { fields: { [field]: owner } });
    return;
  }
  const fields = { ...(existing.fields ?? {}) };
  fields[field] = owner;
  existing.fields = fields;
}

/**
 * Remove every pending decision for one document.  The sync calls this once it
 * has applied the decisions and updated the base — a decision left behind
 * would re-apply on the next sync and hide a fresh conflict forever.
 */
export function clearResolutions(store: ResolutionStore, localId: string): void {
  store.resolutions.delete(localId);
}

/**
 * Remove the named fields' decisions, dropping the document's entry entirely
 * when nothing remains.  The sync calls this per successfully-applied field,
 * so a partially-failed sync keeps the unapplied decisions for the next run.
 */
export function clearResolvedFields(
  store: ResolutionStore,
  localId: string,
  fields: Iterable<string>,
): void {
  const resolution = store.resolutions.get(localId);
  if (!resolution) return;
  for (const field of fields) {
    if (resolution.fields) delete resolution.fields[field];
  }
  const hasFields = resolution.fields !== undefined && Object.keys(resolution.fields).length > 0;
  if (!hasFields) delete resolution.fields;
  if (resolution.default === undefined && !hasFields) {
    store.resolutions.delete(localId);
  }
}
