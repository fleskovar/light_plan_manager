/**
 * The mapping fingerprint — the one value that lets a sync notice that the
 * mapping its base snapshots were recorded under is no longer the mapping in
 * force (LP-370).
 *
 * A base snapshot is only meaningful relative to the mapping it was recorded
 * under.  Change `mapping.statuses` so `in_progress` maps to "In Development"
 * instead of "In Progress", and every linked document's stored base now
 * disagrees with a remote nobody touched: the three-way merge reports a
 * remote-side change on every document, a board-wide false positive.  The
 * failure is silent by construction, so it is caught here — by comparing a
 * fingerprint of the resolved mapping against the one stored beside the links
 * *before* any plan is made.
 *
 * ## What is stored, and where
 *
 * The fingerprint lives in `.lpm/remotes/<name>/mapping.json`, beside
 * `links.json` — one value for the whole remote, never per link, so a change
 * does not touch every entry.  The file holds the fingerprint **and** the
 * resolved mapping it was computed from; the latter is what lets a later sync
 * report *what* changed field by field, not just that something did.
 *
 * ## Resolved, not raw
 *
 * The hash is over the **resolved** mapping — the provider-validated block
 * `openRemote` returns, with every schema default filled in — never over the
 * YAML text.  A reformatted or reordered config therefore fingerprints the
 * same, and two configs that behave identically cannot fingerprint
 * differently.  Canonicalisation sorts object keys recursively before
 * hashing; array order is preserved because it is load-bearing (`remote:
 * [...]`, `labels: [...]`).
 *
 * ## Additive vs breaking
 *
 * A mapping change that only **adds** keys — a new attribute, a new status
 * with no existing documents in it — invalidates nothing: no existing base
 * snapshot references the new key, so the fingerprint is updated in place and
 * the sync proceeds.  Anything that changes or removes an existing value is
 * **breaking**: the base snapshots that reference it no longer mean what they
 * meant, and the run stops before planning.  Re-basing under a changed
 * mapping is LP-371's explicit operation, never a silent rewrite here.
 *
 * A provider whose *remote vocabulary* changed underneath a stable mapping (a
 * renamed Jira workflow step) is not this story's problem: the mapping is
 * unchanged, so the fingerprint is unchanged, and the renamed step surfaces
 * as an unmappable value through LP-273's preflight.
 *
 * ## The two call sites
 *
 *   - **before planning**: `checkMappingChange` compares the fingerprint in
 *     force against the stored one.  `unchanged` / `additive` proceed (the
 *     latter after updating the stored file in place); `breaking` stops the
 *     run and reports `changes` and `affected`.
 *   - **after a successful sync**: `saveMappingSnapshot` records the
 *     fingerprint, so the first sync stores it and every sync refreshes it.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from '../core/storage/paths.js';
import { BoardError } from '../core/errors.js';
import type { LinkStore } from './links.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What lives on disk inside `.lpm/remotes/<name>/mapping.json`. */
export interface MappingSnapshot {
  version: 1;
  /** `sha256:` hash of `mapping` in canonical form. */
  fingerprint: string;
  /** The resolved mapping the fingerprint was computed from, key-sorted. */
  mapping: Record<string, unknown>;
}

/** How one mapping value changed. */
export type MappingChangeKind = 'added' | 'removed' | 'changed';

/** One leaf-level difference between the stored and the current mapping. */
export interface MappingChange {
  /** Dot-separated path, e.g. `statuses.in_progress.remote`. */
  path: string;
  kind: MappingChangeKind;
  /** The stored value; absent when the key was added. */
  old?: unknown;
  /** The current value; absent when the key was removed. */
  next?: unknown;
}

/** Whether a mapping change invalidates any base snapshot. */
export type MappingClassification = 'unchanged' | 'additive' | 'breaking';

/** The answer `checkMappingChange` gives a sync before it plans. */
export interface MappingAssessment {
  /** True when the current mapping differs from the stored snapshot. */
  changed: boolean;
  /** Every difference, field by field. Empty when unchanged. */
  changes: MappingChange[];
  classification: MappingClassification;
  /**
   * The local ids whose base snapshot the change invalidates, sorted.
   * Always empty for `unchanged` and `additive`.
   */
  affected: string[];
}

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

/** True for a plain object — recursable, unlike an array or a scalar. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A value with its object keys sorted recursively, so two mappings that behave
 * identically serialise identically.  Array order is preserved — it is
 * load-bearing (`remote: [...]`, `labels: [...]`).
 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalValue(value[key]);
    }
    return out;
  }
  return value;
}

/** The canonical serialisation of any mapping-shaped value. */
function canonicalize(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(canonicalValue(value));
}

/**
 * The canonical serialisation of a resolved mapping — key-sorted, whitespace
 * free.  Exported so a test can assert that a reformatted mapping is the same
 * string as the original.
 */
export function canonicalMapping(mapping: Record<string, unknown>): string {
  return canonicalize(mapping);
}

/** The `sha256:` fingerprint of a resolved mapping in canonical form. */
export function fingerprintMapping(mapping: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(canonicalMapping(mapping), 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** The path to one remote's mapping snapshot. */
export function mappingSnapshotPath(paths: BoardPaths, remoteName: string): string {
  return path.join(paths.remotesDir, remoteName, 'mapping.json');
}

/**
 * Read the stored mapping snapshot, or `undefined` when none has been recorded
 * yet (the first sync).  A file that exists but cannot be parsed is a
 * `BoardError` naming the path — never a bare JSON parse error.
 */
export function loadMappingSnapshot(
  paths: BoardPaths,
  remoteName: string,
): MappingSnapshot | undefined {
  const file = mappingSnapshotPath(paths, remoteName);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    // No snapshot yet — the first sync will record one.
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BoardError(`Cannot parse mapping snapshot: ${file}`, [
      (error as Error).message,
      'Delete it to let the next sync record a fresh one, or repair the JSON.',
    ]);
  }

  const snapshot = parsed as Partial<MappingSnapshot>;

  if (snapshot.version !== 1) {
    throw new BoardError(`Unsupported mapping snapshot version in ${file}`, [
      `Found version ${JSON.stringify(snapshot.version)}; expected 1.`,
      'Delete it to let the next sync record a fresh one.',
    ]);
  }

  if (typeof snapshot.fingerprint !== 'string' || !snapshot.fingerprint) {
    throw new BoardError(`Invalid mapping snapshot: ${file}`, [
      'The snapshot is missing a valid fingerprint string.',
      'Delete it to let the next sync record a fresh one.',
    ]);
  }

  if (!isPlainObject(snapshot.mapping)) {
    throw new BoardError(`Invalid mapping snapshot: ${file}`, [
      'The snapshot is missing a valid mapping object.',
      'Delete it to let the next sync record a fresh one.',
    ]);
  }

  return {
    version: 1,
    fingerprint: snapshot.fingerprint,
    mapping: snapshot.mapping,
  };
}

/**
 * Write the mapping snapshot to disk, creating the per-remote folder if it
 * does not exist.  The stored `mapping` is the canonical (key-sorted) form, so
 * the file is byte-stable across reformats and a clean git diff.
 *
 * Called after a successful sync — the first one records the fingerprint,
 * every later one refreshes it.
 */
export function saveMappingSnapshot(
  paths: BoardPaths,
  remoteName: string,
  mapping: Record<string, unknown>,
): MappingSnapshot {
  const file = mappingSnapshotPath(paths, remoteName);
  mkdirSync(path.dirname(file), { recursive: true });

  const snapshot: MappingSnapshot = {
    version: 1,
    fingerprint: fingerprintMapping(mapping),
    mapping: canonicalValue(mapping) as Record<string, unknown>,
  };

  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return snapshot;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Every leaf-level difference between a stored and a current resolved mapping.
 *
 * Walks object keys recursively (sorted, so the change order is deterministic)
 * and treats arrays as leaves — a changed `remote: [...]` list is one change,
 * not one per element.  Two values are equal when their canonical forms are,
 * so a reordered or reformatted mapping produces no changes at all.
 */
export function diffMapping(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): MappingChange[] {
  const changes: MappingChange[] = [];

  const walk = (prev: unknown, next: unknown, path: string[]): void => {
    if (canonicalize(prev) === canonicalize(next)) return;

    if (isPlainObject(prev) && isPlainObject(next)) {
      const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
      for (const key of [...keys].sort()) {
        walk(prev[key], next[key], [...path, key]);
      }
      return;
    }

    const kind: MappingChangeKind =
      prev === undefined ? 'added' : next === undefined ? 'removed' : 'changed';
    const change: MappingChange = { path: path.join('.'), kind };
    if (prev !== undefined) change.old = prev;
    if (next !== undefined) change.next = next;
    changes.push(change);
  };

  walk(previous, current, []);
  return changes;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a set of mapping changes.  `unchanged` when there are none;
 * `additive` when every change is an addition; `breaking` otherwise — a change
 * or removal of an existing value is what invalidates base snapshots.
 */
export function classifyMappingChanges(
  changes: readonly MappingChange[],
): MappingClassification {
  if (changes.length === 0) return 'unchanged';
  return changes.every((change) => change.kind === 'added') ? 'additive' : 'breaking';
}

// ---------------------------------------------------------------------------
// Affected documents
// ---------------------------------------------------------------------------

/**
 * The local ids whose base snapshot a change invalidates, sorted.
 *
 * Only `changed` and `removed` changes can invalidate — an addition references
 * a key no existing base has.  The mapping block the path lives in decides
 * which base field the change governs, and therefore which documents carry it:
 *
 *   - `statuses.<status>`   → documents whose base recorded `status: <status>`;
 *   - `attributes.<name>`   → documents whose base recorded that attribute;
 *   - `accounts`            → documents whose base recorded an `assignee`;
 *   - `periods`             → documents whose base recorded a `period`;
 *   - `types`               → never — the type is not part of a base snapshot.
 */
export function affectedDocuments(
  changes: readonly MappingChange[],
  store: LinkStore,
): string[] {
  const affected = new Set<string>();

  for (const change of changes) {
    if (change.kind === 'added') continue;

    const segments = change.path.split('.');
    const block = segments[0];
    const key = segments[1];

    if (block === 'statuses' && key !== undefined) {
      for (const [localId, link] of store.links) {
        if (link.base && link.base.status === key) affected.add(localId);
      }
    } else if (block === 'attributes' && key !== undefined) {
      for (const [localId, link] of store.links) {
        if (link.base && Object.prototype.hasOwnProperty.call(link.base, key)) {
          affected.add(localId);
        }
      }
    } else if (block === 'accounts') {
      for (const [localId, link] of store.links) {
        if (link.base && Object.prototype.hasOwnProperty.call(link.base, 'assignee')) {
          affected.add(localId);
        }
      }
    } else if (block === 'periods') {
      for (const [localId, link] of store.links) {
        if (link.base && Object.prototype.hasOwnProperty.call(link.base, 'period')) {
          affected.add(localId);
        }
      }
    }
    // `types` (and anything unrecognised) never invalidates a base snapshot.
  }

  return [...affected].sort();
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/** A pure `MappingAssessment` with the fields a caller cares about set. */
function assessment(
  changed: boolean,
  changes: MappingChange[],
  classification: MappingClassification,
  affected: string[],
): MappingAssessment {
  return { changed, changes, classification, affected };
}

/**
 * Compare a stored resolved mapping against the one in force, over a link
 * store.  Pure: no disk, no network.
 *
 * `previous` is the resolved mapping the last successful sync recorded
 * (`undefined` before the first); `current` is the resolved mapping in force
 * (`openRemote(...).mapping`).  The result names every change, its
 * classification, and — for a breaking change — exactly which linked documents
 * have an affected base snapshot.
 */
export function assessMappingChange(
  previous: Record<string, unknown> | undefined,
  current: Record<string, unknown>,
  store: LinkStore,
): MappingAssessment {
  if (previous === undefined) {
    return assessment(false, [], 'unchanged', []);
  }

  const changes = diffMapping(previous, current);
  const classification = classifyMappingChanges(changes);
  const affected =
    classification === 'breaking' ? affectedDocuments(changes, store) : [];

  return assessment(changes.length > 0, changes, classification, affected);
}

/**
 * The pre-planning guard: compare the fingerprint stored beside the links
 * against the mapping in force.
 *
 * Reads the stored snapshot, compares fingerprints (the cheap "did anything
 * change" check), and only diffs when they disagree.  A change that is purely
 * additive invalidates nothing, so the stored snapshot is updated in place and
 * the sync may proceed; a breaking change leaves the snapshot alone and hands
 * the caller `changes` and `affected` to report before it stops.
 *
 * The caller is the sync orchestrator: it stops on `classification: 'breaking'`
 * and reports the assessment, never on this function's return alone.
 */
export function checkMappingChange(
  paths: BoardPaths,
  remoteName: string,
  mapping: Record<string, unknown>,
  store: LinkStore,
): MappingAssessment {
  const previous = loadMappingSnapshot(paths, remoteName);

  if (previous === undefined) {
    // First sync: nothing to compare against. The post-sync record stores it.
    return assessment(false, [], 'unchanged', []);
  }

  if (previous.fingerprint === fingerprintMapping(mapping)) {
    return assessment(false, [], 'unchanged', []);
  }

  const result = assessMappingChange(previous.mapping, mapping, store);

  if (result.classification === 'additive') {
    // Nothing is invalidated: update the fingerprint in place so the next sync
    // does not re-report the same additive change.
    saveMappingSnapshot(paths, remoteName, mapping);
  }

  return result;
}
