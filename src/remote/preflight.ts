/**
 * The push preflight (LP-273): every value on the board that a remote's
 * mapping cannot carry, collected into `Problem`s **before anything is
 * written**.
 *
 * Two passes of checking exist and are deliberately different:
 *
 *   - `checkRemoteConfiguration` (`check.ts`) validates the *mapping* offline:
 *     a status mapping that is not total, an account `via` naming no string
 *     attribute, a mapping key for an undeclared attribute. It reads the config
 *     alone, whatever documents exist.
 *   - this module validates the *values*: walk the in-scope documents and ask
 *     each one "can the mapping carry you?" — its type, its status, its
 *     attributes, its assignee and its period. The answer is a `Problem[]` that
 *     a sync command prints before pushing, and `hasErrorProblems` decides
 *     whether any request is made at all.
 *
 * The split that matters here is **dropped vs degraded**:
 *
 *   - a value the mapping cannot carry *and* cannot encode is **dropped** — the
 *     remote issue is written without it, and it is lost. That is an error, and
 *     it blocks the push: an unmapped type, an unmapped status, an attribute
 *     value that will not coerce (an enum value with no remote option), a stale
 *     assignee id, a stale period id.
 *   - a value the mapping cannot carry natively but the degradation ladder
 *     encodes elsewhere is **degraded** — a warning, and the push proceeds with
 *     it named in the summary: an attribute with no mapping (the managed block
 *     or a custom field), a person with no account (pushed unassigned).
 *
 * Pure: no disk, no network. The board and the opened remote are passed in, so
 * a dry-run is this exact code path with the writes gated off.
 *
 * The push is the only direction here. Pull-side gaps (an unknown account, a
 * remote value that will not coerce back) are found *during* the pull, not
 * before it, and belong to `planPull`'s reporting — this module is the gate in
 * front of a write.
 */

import type { LoadedBoard } from '../core/board/load.js';
import { isGenericType } from '../core/config/lookup.js';
import type { Issue, Problem } from '../core/model/types.js';
import { displayPath } from '../core/storage/paths.js';
import type { MappedResource, ResourceGap, Roster } from './accounts.js';
import { uniqueResourceGaps } from './accounts.js';
import type { AttributeProblem } from './attributes.js';
import { isProbe } from './capabilities.js';
import {
  mapStatusToRemote,
  mapTypeToRemote,
  normalizeStatusMappings,
  type StatusMappings,
  type TypeMappings,
} from './mapping.js';
import { mappingClaims, reconcileMapping, type RemoteVocabulary } from './reconcile.js';
import type { MappedPeriod, PeriodGap, PeriodIndex } from './periods.js';
import { normalizePeriodMapping } from './periods.js';
import type { AttributeDefs, BoardFields, BoardOp } from './provider.js';
import type { OpenedRemote } from './remotes.js';
import { isInScope, resolveScope } from './scope.js';

/** The mapping's `types` / `attributes` blocks, whatever shape they take. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** A value that carries nothing to map. */
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return Array.isArray(value) && value.length === 0;
}

/** An issue as the translator sees it — `BoardFields` without the ids. */
export function boardFieldsOf(issue: Issue): BoardFields {
  return {
    title: issue.title,
    body: issue.body,
    type: issue.type,
    status: issue.status,
    assignee: issue.assignee,
    period: issue.period,
    attributes: issue.attributes,
  };
}

/** The roster slice the account mapping reads: resources keyed by id. */
export function rosterOf(board: LoadedBoard): Roster {
  const roster = new Map<string, MappedResource>();
  for (const resource of board.resources) {
    roster.set(resource.id, {
      id: resource.id,
      title: resource.title,
      generic: isGenericType(board.config, resource.type),
      attributes: resource.attributes,
    });
  }
  return roster;
}

/** The timeline slice the period mapping reads: periods keyed by id. */
export function periodIndexOf(board: LoadedBoard): PeriodIndex {
  const index = new Map<string, MappedPeriod>();
  for (const period of board.periods) {
    index.set(period.id, {
      id: period.id,
      title: period.title,
      type: period.type,
      parentId: period.parentId,
      starts: period.starts,
      ends: period.ends,
    });
  }
  return index;
}

/** Every attribute declared on some issue type, keyed by name. */
export function attributeDefsOf(board: LoadedBoard): AttributeDefs {
  const defs: AttributeDefs = {};
  for (const type of Object.values(board.config.issue_types)) {
    for (const [name, def] of Object.entries(type.attributes)) {
      defs[name] = def;
    }
  }
  return defs;
}

/** Dedupe coercion failures by (direction, attribute, reason), sorted. */
function uniqueAttributeProblems(
  problems: readonly AttributeProblem[],
): AttributeProblem[] {
  const seen = new Set<string>();
  const out: AttributeProblem[] = [];
  for (const problem of problems) {
    const key = `${problem.direction}\u0000${problem.attribute}\u0000${problem.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(problem);
  }
  return out.sort(
    (a, b) =>
      a.attribute.localeCompare(b.attribute) || a.reason.localeCompare(b.reason),
  );
}

/** Dedupe period gaps by period id, sorted. */
function uniquePeriodGaps(gaps: readonly PeriodGap[]): PeriodGap[] {
  const seen = new Set<string>();
  const out: PeriodGap[] = [];
  for (const gap of gaps) {
    if (seen.has(gap.periodId)) continue;
    seen.add(gap.periodId);
    out.push(gap);
  }
  return out.sort((a, b) => a.periodId.localeCompare(b.periodId));
}

/**
 * Collect every in-scope value the remote's mapping cannot carry, for the push
 * direction. Runs after `openRemote` has accepted the mapping; each problem
 * carries the config key path that would fix it (`remotes.<name>.mapping...`)
 * in its message, and the config file in its `path`.
 *
 * The translator does the per-issue work — the same code path a push runs — so
 * the problems reported here are exactly the ones a real sync would hit. The
 * two things the translator deliberately drops in silence (an unmapped type,
 * an unmapped status) are checked here directly, and so is the one thing it
 * never sees (an attribute that is used but not mapped at all).
 */
/**
 * What the translator reports about every in-scope document, in one walk.
 *
 * Shared with the readiness check (`readiness.ts`), which renders the same
 * gaps as findings somebody can act on rather than as sentences. One walk, one
 * set of gaps: a second copy of "can this assignee land?" is exactly the
 * mistake that would let the pre-push dialog and `lpm remote push` disagree
 * about the same board.
 */
export interface PushGaps {
  attributeProblems: AttributeProblem[];
  resourceGaps: ResourceGap[];
  periodGaps: PeriodGap[];
}

export function pushGaps(board: LoadedBoard, remote: OpenedRemote, issues: readonly Issue[]): PushGaps {
  const roster = rosterOf(board);
  const periods = periodIndexOf(board);
  const attributeDefs = attributeDefsOf(board);

  const attributeProblems: AttributeProblem[] = [];
  const resourceGaps: ResourceGap[] = [];
  const periodGaps: PeriodGap[] = [];
  for (const issue of issues) {
    const op: BoardOp = { kind: 'create', localId: issue.id, fields: boardFieldsOf(issue) };
    const result = remote.provider.translator.describeRequest(
      op,
      remote.mapping,
      attributeDefs,
      roster,
      periods,
    );
    attributeProblems.push(...result.problems);
    resourceGaps.push(...result.resourceGaps);
    periodGaps.push(...result.periodGaps);
  }
  return { attributeProblems, resourceGaps, periodGaps };
}

/**
 * `accounts` and `periods` say whether those two families are rendered here.
 * The readiness check turns them off because it reports the same gaps in a
 * richer form — with the remote's own answer beside them, and a fix to choose
 * — and one thing reported twice in one dialog reads as two things.
 */
export function preflightPush(
  board: LoadedBoard,
  remote: OpenedRemote,
  include: { accounts?: boolean; periods?: boolean } = {},
): Problem[] {
  const problems: Problem[] = [];
  const configPath = displayPath(board.paths, board.paths.configPath);
  const scope = resolveScope(board.issues, remote.scope);
  const inScope = board.issues.filter((issue) => isInScope(scope, issue.id));

  const periods = periodIndexOf(board);

  // A connection key that only part of the mapping needs — Jira's Agile board
  // id, which a sprint cannot be found or created without. The provider states
  // the demand (`conditionalConnection`); this is where the mapping and the
  // connection are both in hand, and it runs before anything is written. Until
  // this check existed the push got as far as creating sprints and *then*
  // stopped, having already asked for confirmation to write.
  for (const need of remote.provider.conditionalConnection ?? []) {
    if (remote.mapping[need.needs] === undefined) continue;
    const value = remote.connection[need.key];
    if (value !== undefined && value !== '') continue;
    problems.push({
      level: 'error',
      path: configPath,
      message:
        `remotes.${remote.name}.connection.${need.key}: the mapping carries ` +
        `"${need.needs}" and this remote has no ${need.key} — ${need.why}`,
    });
  }

  const typeMappings = asRecord(remote.mapping['types']) as TypeMappings;
  const statusMappings = normalizeStatusMappings(asRecord(remote.mapping['statuses']));

  // An unmapped type is dropped — the issue is filed without it. Error.
  const usedTypes = [...new Set(inScope.map((issue) => issue.type))].sort();
  for (const type of usedTypes) {
    if (mapTypeToRemote(typeMappings, type) === undefined) {
      problems.push({
        level: 'error',
        path: configPath,
        message: `remotes.${remote.name}.mapping.types.${type}: type "${type}" has no mapping`,
      });
    }
  }

  // An unmapped status is dropped. Normally `openRemote` already refuses a
  // non-total status mapping; this is the same rule against the values the
  // board actually uses, kept for a remote opened through another path.
  const usedStatuses = [...new Set(inScope.map((issue) => issue.status))].sort();
  for (const status of usedStatuses) {
    if (mapStatusToRemote(statusMappings, status) === undefined) {
      problems.push({
        level: 'error',
        path: configPath,
        message: `remotes.${remote.name}.mapping.statuses.${status}: status "${status}" has no mapping`,
      });
    }
  }

  // Run the translator over every in-scope document — attributes, assignees and
  // periods — exactly as the push will, collecting what it reports.
  const { attributeProblems, resourceGaps, periodGaps } = pushGaps(board, remote, inScope);

  // An attribute that is used but not mapped degrades — a warning, never an
  // error: the value is encoded elsewhere, not lost.
  const mappedAttributes = new Set(Object.keys(asRecord(remote.mapping['attributes'])));
  const usedAttributes = new Set<string>();
  for (const issue of inScope) {
    for (const [name, value] of Object.entries(issue.attributes)) {
      if (!isBlank(value)) usedAttributes.add(name);
    }
  }
  // Custom fields may be a probe (account-dependent) — offline, the preflight
  // reads the declared cell conservatively: a probed or absent cell means the
  // managed block, a literal non-null cell means a custom field. The resolved
  // answer is the sync command's to supply (LP-275 names the rung for real).
  const customFields = remote.provider.capabilities.customFields;
  const provisionable = !isProbe(customFields) && customFields !== null;
  const rung = provisionable ? 'a custom field' : 'the managed block';
  for (const attribute of [...usedAttributes].sort()) {
    if (mappedAttributes.has(attribute)) continue;
    problems.push({
      level: 'warn',
      path: configPath,
      message: `remotes.${remote.name}.mapping.attributes.${attribute}: attribute "${attribute}" is not mapped; it will be encoded in ${rung}`,
    });
  }

  // A coercion failure is dropped — an enum value with no remote option, free
  // text in a number field. Error.
  for (const problem of uniqueAttributeProblems(attributeProblems)) {
    problems.push({
      level: 'error',
      path: configPath,
      message: `remotes.${remote.name}.mapping.attributes.${problem.attribute}: ${problem.reason}`,
    });
  }

  // A stale assignee id is dropped; a person with no account is degraded to
  // unassigned. The gap carries no level, so the split is made here: an id not
  // on the roster is an error, everything else a warning.
  for (const gap of include.accounts === false ? [] : uniqueResourceGaps(resourceGaps)) {
    const stale = !board.resourcesById.has(gap.resourceId);
    problems.push(
      stale
        ? {
            level: 'error',
            path: configPath,
            message: `remotes.${remote.name}.mapping.accounts: assignee "${gap.resourceId}" is not on the roster`,
          }
        : {
            level: 'warn',
            path: configPath,
            message: `remotes.${remote.name}.mapping.accounts.via: ${gap.resourceTitle} is pushed unassigned (${gap.reason})`,
          },
    );
  }

  // A period id the timeline does not know is dropped. Error.
  for (const gap of include.periods === false ? [] : uniquePeriodGaps(periodGaps)) {
    problems.push({
      level: 'error',
      path: configPath,
      message: `remotes.${remote.name}.mapping.periods: period "${gap.periodId}" is not on the timeline`,
    });
  }

  // Iteration fields have a fixed duration set on the field, not per item
  // (LP-313 note): a board whose mapped periods vary in length cannot fit one
  // iteration field, so the mismatch is reported at preflight rather than a
  // push quietly rounding.
  const periodMapping = normalizePeriodMapping(remote.mapping['periods']);
  if (periodMapping?.carrier === 'iteration') {
    const durations = new Set<number>();
    for (const period of board.periods) {
      if (period.type !== periodMapping.container) continue;
      if (period.starts === undefined || period.ends === undefined) continue;
      const start = Date.parse(period.starts);
      const end = Date.parse(period.ends);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      durations.add(Math.round((end - start) / 86400000));
    }
    if (durations.size > 1) {
      problems.push({
        level: 'warn',
        path: configPath,
        message: `remotes.${remote.name}.mapping.periods: the ${periodMapping.container} periods vary in length (${[...durations].sort((a, b) => a - b).join(', ')} days), but a GitHub iteration field has one fixed duration — the carrier will not fit irregular sprints`,
      });
    }
  }

  return problems;
}

/**
 * The gate the story names: an error-level problem means no request that
 * writes may be made. Warnings (degraded fields) do not block — the sync
 * proceeds and the caller shows them in its summary.
 */
export function hasErrorProblems(problems: readonly Problem[]): boolean {
  return problems.some((problem) => problem.level === 'error');
}

/**
 * The mapped names this project does not have — the check that turns a
 * mid-push `400 Specify a valid issue type` into a refusal before anything is
 * written.
 *
 * Pure: the caller does the asking (`connector.vocabulary()`) and hands the
 * answer here. It is the same reconciliation `lpm remote setup` prints, read
 * for a different purpose: setup *reports* so somebody can fix the mapping,
 * and a push *refuses*, because filing an issue under a type the project has
 * never heard of cannot do anything but fail.
 *
 * A vocabulary the remote does not report at all (an absent list) is not
 * evidence of anything and produces no problems — the same rule as every other
 * "absence is not evidence" case in this layer.
 */
export function vocabularyProblems(
  remote: OpenedRemote,
  vocabulary: RemoteVocabulary,
  configPath: string,
): Problem[] {
  const report = reconcileMapping(mappingClaims(remote.mapping), vocabulary);
  const problems: Problem[] = [];
  for (const [block, entries] of [
    ['types', report.types],
    ['statuses', report.statuses],
  ] as const) {
    for (const entry of entries?.entries ?? []) {
      if (entry.verdict !== 'unresolved') continue;
      const has = (entries?.candidates ?? []).join(', ');
      problems.push({
        level: 'error',
        path: configPath,
        message:
          `remotes.${remote.name}.mapping.${block}.${entry.boardKey}: the remote has no ` +
          `"${entry.claimed}"${has === '' ? '' : ` — it has: ${has}`}`,
      });
    }
  }
  return problems;
}
