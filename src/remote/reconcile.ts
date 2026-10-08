/**
 * Reconciling a drafted mapping against the words the remote actually has
 * (LP-537) — the pure half of `lpm remote setup`.
 *
 * `lpm remote add` drafts a mapping offline: the board's own words where the
 * board names them, and the platform's *convention* where the platform does
 * (`Provider.standardVocabulary`). A convention is right on a project that was
 * created from the platform's own template and wrong on one somebody has
 * renamed — and which of those is true can only be learnt by asking the remote.
 *
 * So this module answers one question: **given the names the mapping claims and
 * the names the remote reports, which claims are already right, which are the
 * same word spelled differently, and which are not there at all?** It is pure —
 * two lists of strings in, a report out — so the interesting cases are a table
 * in `test/remote-reconcile.test.ts` rather than a live project.
 *
 * ## Three verdicts, and why there is no fourth
 *
 *   - **`ok`** — the remote reports this exact name. Nothing to do.
 *   - **`renamed`** — the remote reports the same word with different
 *     punctuation or case (`Sub-task` / `Subtask`, `To Do` / `Todo`). The
 *     remote's spelling wins, because it is the one a request has to carry.
 *   - **`unresolved`** — no candidate is that word. Reported with everything the
 *     remote *does* have, and left exactly as it stands in the config.
 *
 * There is deliberately no "closest match" rung. Levenshtein distance between
 * `In Review` and `In Progress` is small and the difference between them is a
 * whole column of somebody's board; a wrong rewrite is worse than a question,
 * and unlike the original `TODO:` markers this question comes with the answer
 * list printed next to it. Matching stops at "the same word, spelled
 * differently", which is a fact rather than a guess.
 *
 * ## What it never does
 *
 * It does not invent a remote word, and it does not *drop* a board word: a
 * board status with no remote counterpart stays mapped to the name it had, so
 * the config remains total (`openRemote` refuses a partial status mapping) and
 * the push preflight is what reports the gap. A reconciler that silently
 * unmapped a status would turn a question into missing work.
 */

import { normalizeWord } from './vocabulary.js';
import { normalizeStatusMappings, normalizeTypeMappings, statusStatesOf } from './mapping.js';

/** What a remote reports about its own vocabulary, as plain names. */
export interface RemoteVocabulary {
  /** Every issue type the target has, e.g. `['Epic', 'Story', 'Bug']`. */
  types?: string[];
  /** Every workflow status the target has, e.g. `['To Do', 'Done']`. */
  statuses?: string[];
}

/** What became of one mapped name. */
export type ReconcileVerdict = 'ok' | 'renamed' | 'unresolved';

/** One mapped name, reconciled against the live list. */
export interface ReconcileEntry {
  /** The board word the mapping is keyed by — a type name or a status id. */
  boardKey: string;
  /** The remote name the mapping currently claims. */
  claimed: string;
  /** The remote's own spelling, when it differs from the claim. */
  resolved?: string;
  verdict: ReconcileVerdict;
}

/** The reconciliation of one mapping block. */
export interface ReconcileBlock {
  /** Every mapped name, in the mapping's own key order. */
  entries: ReconcileEntry[];
  /** The names the remote reported, for a report to print. */
  candidates: string[];
}

/** The reconciliation of a whole mapping: one block per vocabulary the remote has. */
export interface ReconcileReport {
  types?: ReconcileBlock;
  statuses?: ReconcileBlock;
}

/** Entries whose claim must be rewritten, as `boardKey → the remote's spelling`. */
export function corrections(block: ReconcileBlock | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of block?.entries ?? []) {
    if (entry.verdict === 'renamed' && entry.resolved !== undefined) out[entry.boardKey] = entry.resolved;
  }
  return out;
}

/** True when some entry in the report is still unresolved. */
export function hasUnresolved(report: ReconcileReport): boolean {
  return [report.types, report.statuses].some((block) =>
    (block?.entries ?? []).some((entry) => entry.verdict === 'unresolved'),
  );
}

/** True when the report asks for at least one rewrite. */
export function hasCorrections(report: ReconcileReport): boolean {
  return [report.types, report.statuses].some(
    (block) => Object.keys(corrections(block)).length > 0,
  );
}

/**
 * Reconcile one block of claimed names against the names the remote reports.
 *
 * `claims` is `boardKey → the claimed remote name`. A claim the remote reports
 * verbatim is `ok`; one it reports under a different spelling of the same word
 * is `renamed`; anything else is `unresolved`.
 */
export function reconcileNames(
  claims: Record<string, string>,
  candidates: readonly string[],
): ReconcileBlock {
  const exact = new Set(candidates);
  // Normalized index. A normalized form shared by two live names (a project
  // with both "Sub-task" and "Subtask") is ambiguous and matches neither: the
  // rewrite would be a coin toss, and the question is cheap.
  const byNormal = new Map<string, string[]>();
  for (const candidate of candidates) {
    const key = normalizeWord(candidate);
    const bucket = byNormal.get(key) ?? [];
    bucket.push(candidate);
    byNormal.set(key, bucket);
  }

  const entries: ReconcileEntry[] = [];
  for (const [boardKey, claimed] of Object.entries(claims)) {
    if (exact.has(claimed)) {
      entries.push({ boardKey, claimed, verdict: 'ok' });
      continue;
    }
    const matches = byNormal.get(normalizeWord(claimed)) ?? [];
    if (matches.length === 1) {
      entries.push({ boardKey, claimed, resolved: matches[0]!, verdict: 'renamed' });
      continue;
    }
    entries.push({ boardKey, claimed, verdict: 'unresolved' });
  }
  return { entries, candidates: [...candidates] };
}

/**
 * Reconcile a whole mapping against a remote's vocabulary.
 *
 * A vocabulary the remote does not report (`types` on a provider with no issue
 * types) is skipped rather than reported empty — "the remote has no types" and
 * "the remote reported no types" are different claims, and treating the first
 * as the second would mark every mapped type unresolved on Linear, where a type
 * is a label nobody has to look up.
 */
export function reconcileMapping(
  claims: { types?: Record<string, string>; statuses?: Record<string, string> },
  vocabulary: RemoteVocabulary,
): ReconcileReport {
  const report: ReconcileReport = {};
  if (vocabulary.types !== undefined && claims.types !== undefined) {
    report.types = reconcileNames(claims.types, vocabulary.types);
  }
  if (vocabulary.statuses !== undefined && claims.statuses !== undefined) {
    report.statuses = reconcileNames(claims.statuses, vocabulary.statuses);
  }
  return report;
}

/**
 * What a mapping *claims* the remote calls each board word — `boardKey → the
 * remote name a push would write`.
 *
 * The single definition, read by two callers that must not disagree: the setup
 * conversation, which reconciles these against the live vocabulary and
 * corrects `config.yml`, and the push, which refuses to write a name the
 * project does not have. It lived in the CLI when only setup asked.
 *
 * The **push** name is the one that has to exist: the extra states a status may
 * list are names a *pull* recognises, and a remote that has dropped one of
 * those is not a reason to refuse a push.
 */
export function mappingClaims(mapping: Record<string, unknown>): {
  types: Record<string, string>;
  statuses: Record<string, string>;
} {
  const types: Record<string, string> = {};
  for (const [type, entry] of Object.entries(
    normalizeTypeMappings((mapping['types'] as Record<string, unknown>) ?? {}),
  )) {
    types[type] = entry.remote;
  }
  const statuses: Record<string, string> = {};
  for (const [status, entry] of Object.entries(
    normalizeStatusMappings((mapping['statuses'] as Record<string, unknown>) ?? {}),
  )) {
    const states = statusStatesOf(entry);
    const claimed = entry.push ?? states[0];
    if (claimed !== undefined) statuses[status] = claimed;
  }
  return { types, statuses };
}
