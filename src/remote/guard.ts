/**
 * The write-confirmation gate (LP-350) — the pure decision a push must pause
 * for, shared by every front end so the CLI, the web panel and an agent cannot
 * disagree about whether a plan needs consent.
 *
 * Two pauses, one memory:
 *
 *   - **First write.** The very first time a remote is written to, a person
 *     must confirm the target and the counts. The consent is recorded once
 *     (`links.ts`'s `consentedAt`) and never asked again.
 *   - **Oversized plan.** A push whose plan creates or closes more than the
 *     configured threshold (default 25) stops and requires `--yes`, because a
 *     scope typo that makes half the board look deleted would otherwise close
 *     half a backlog — bulk-close is as dangerous as bulk-create.
 *
 * This file only *decides*. The prompting (interactive) and the refusal (a
 * non-interactive run with no `--yes`) live in the caller — `runSync` enforces
 * the decision through its `confirm` / `yes` options, and the CLI supplies the
 * prompt. Nothing here touches a terminal, a file or a request.
 */

import type { RemoteOp, PushPlan } from './plan.js';
import type { OpenedRemote } from './remotes.js';
import { isRemoteWrite } from './execute.js';

/** The default write threshold: more creates+closes than this needs `--yes`. */
export const DEFAULT_WRITE_THRESHOLD = 25;

/** The write-shaped counts a plan implies, for the confirmation and the report. */
export interface PushWriteCounts {
  /** New twins the plan files: `create` plus `restore` (a re-file is a create). */
  creates: number;
  /** Existing twins the plan closes (a terminal status reached, or `on_delete: close`). */
  closes: number;
  /** Existing twins the plan deletes (`on_delete: delete`). */
  deletes: number;
  /** Every remote write of any kind — the number `--limit` budgets against. */
  writes: number;
}

/** Whether an op files a new twin, for the create half of the threshold count. */
function isCreateLike(op: RemoteOp): boolean {
  return op.kind === 'create' || op.kind === 'restore';
}

/**
 * Count the write-shaped operations in a push plan. `creates` and `closes`
 * feed the threshold gate; `deletes` feeds both the threshold gate (a bulk
 * deletion is a bulk write) and the every-run delete gate; `writes` feeds the
 * first-write gate (any write at all) and the report.
 */
export function countPushWrites(plan: PushPlan): PushWriteCounts {
  let creates = 0;
  let closes = 0;
  let deletes = 0;
  let writes = 0;
  for (const op of plan.ops) {
    if (isCreateLike(op)) creates += 1;
    else if (op.kind === 'close') closes += 1;
    else if (op.kind === 'delete') deletes += 1;
    if (isRemoteWrite(op)) writes += 1;
  }
  return { creates, closes, deletes, writes };
}

/** The configured threshold for a remote, or the default when it says nothing. */
export function writeThresholdOf(remote: OpenedRemote): number {
  return remote.write_threshold ?? DEFAULT_WRITE_THRESHOLD;
}

/** Why a push plan needs consent before it may run. */
export type ConsentReason = 'first_write' | 'threshold' | 'delete';

/** The decision: does this plan need a pause, and if so why. */
export interface ConsentGate {
  /** True when the push may not run without consent. */
  requiresConsent: boolean;
  /** Why, when `requiresConsent`. */
  reason?: ConsentReason;
  /** The counts the gate decided on, for the message. */
  counts: PushWriteCounts;
  /** The threshold in force (used when `reason` is `threshold`). */
  threshold: number;
}

/** What a confirmation prompt shows: the target, the reason, and the counts. */
export interface ConsentRequest {
  remoteName: string;
  /** The human-readable target (`owner/repo`, `PROJ @ host`, `team`). */
  target: string;
  reason: ConsentReason;
  counts: PushWriteCounts;
  threshold: number;
}

/** A refusal recorded on the result: the push was stopped, nothing written. */
export interface ConsentRefusal {
  reason: ConsentReason;
  target: string;
  counts: PushWriteCounts;
  threshold: number;
}

/**
 * Decide whether a push needs consent.
 *
 * A plan with no remote writes never asks — there is nothing to confirm. An
 * oversized plan (creates + closes + deletes above the threshold) outranks the
 * rest, because `--yes` satisfies it and it is the strictest of the gates.
 * A plan that deletes a twin (`on_delete: delete`) is the next: it must be
 * confirmed **every run**, and the gate is never satisfied by a remembered
 * first-write consent (LP-351).  Otherwise the gate asks once, on the first
 * write, until consent is recorded.
 */
export function consentGate(params: {
  remote: OpenedRemote;
  /** Whether first-write consent has already been recorded for this remote. */
  consented: boolean;
  plan: PushPlan;
}): ConsentGate {
  const counts = countPushWrites(params.plan);
  const threshold = writeThresholdOf(params.remote);

  if (counts.writes === 0) {
    return { requiresConsent: false, counts, threshold };
  }
  if (counts.creates + counts.closes + counts.deletes > threshold) {
    return { requiresConsent: true, reason: 'threshold', counts, threshold };
  }
  if (counts.deletes > 0) {
    return { requiresConsent: true, reason: 'delete', counts, threshold };
  }
  if (!params.consented) {
    return { requiresConsent: true, reason: 'first_write', counts, threshold };
  }
  return { requiresConsent: false, counts, threshold };
}
