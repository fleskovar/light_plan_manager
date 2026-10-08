/**
 * Readiness: can this push land the way the board says it should?
 *
 * `preflightPush` asks whether the *mapping* can carry the board's values, and
 * it is pure and offline, which is exactly right for that question. This asks
 * the one it cannot: **does the far side have the person and the sprint?** An
 * account id that was valid last quarter, a colleague who left the project, a
 * sprint nobody has filed — the board is perfectly valid in all three cases,
 * the push writes, and forty issues arrive unassigned or unscheduled. The
 * first anybody hears of it is the issues themselves.
 *
 * So this runs before a push, asks the tracker two cheap questions (who can be
 * assigned, which periods exist — one request each, not one per issue), and
 * returns findings somebody can answer. The three answers are the same every
 * time — ignore it, fix it, cancel — and only the *fix* differs, which is why
 * it is data on the finding rather than a branch in a dialog.
 *
 * One definition, kept that way on purpose: the offline half of every
 * assignee and period finding comes from `pushGaps`, the same translator walk
 * `preflightPush` reports from, so the dialog and `lpm remote push` can never
 * disagree about the same board. The preflight renders those two families only
 * when nobody else is going to — see its `include` argument.
 */

import type { LoadedBoard } from '../core/board/load.js';
import { remoteNamed } from '../core/config/lookup.js';
import { BoardError } from '../core/errors.js';
import type { BoardPaths } from '../core/storage/paths.js';
import {
  READINESS_DOCUMENTS_SHOWN,
  type ReadinessCandidate,
  type ReadinessFinding,
  type RemoteReadinessReport,
} from '../shared/remote-readiness.js';
import { normalizeAccountMapping, uniqueResourceGaps } from './accounts.js';
import { describeTarget } from './config-file.js';
import { normalizePeriodMapping } from './periods.js';
import { pushGaps, rosterOf } from './preflight.js';
import type { NativeSprint, RemoteUser } from './provider.js';
import { buildConnector, type OpenedRemote } from './remotes.js';
import { isInScope, resolveScope } from './scope.js';

/** What the remote answered, or `null` where it could not be asked. */
export interface ReadinessLive {
  /** The people the target can assign work to. */
  users: RemoteUser[] | null;
  /** The periods the target already holds. */
  periods: NativeSprint[] | null;
  /** Why the remote could not be asked at all. */
  unreachable?: string;
}

export interface ReadinessInputs {
  board: LoadedBoard;
  remote: OpenedRemote;
  live: ReadinessLive;
  /** Act on exactly these documents — the push's own selection. */
  only?: readonly string[];
}

/** An error message from any thrown value, with a `BoardError`'s hints. */
function describeError(error: unknown): string {
  if (error instanceof BoardError) return [error.message, ...error.details].join(' ');
  return error instanceof Error ? error.message : String(error);
}

/** Ids read the way a person reads them: `LP-9` before `LP-10`. */
function byId(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/** A finding's documents, sampled and counted. */
function documentsOf(ids: readonly string[]): { documents: string[]; count: number } {
  const sorted = [...new Set(ids)].sort(byId);
  return { documents: sorted.slice(0, READINESS_DOCUMENTS_SHOWN), count: sorted.length };
}

/**
 * Remote people this board person might be.
 *
 * Matched on the values a roster actually holds — an email first, because that
 * is a fact rather than a resemblance, then the display name, which is a
 * suggestion and is marked as one. Nothing is matched on a substring: "Chris"
 * is not evidence about "Christine Ng", and a wrong account is worse than no
 * account, because the work lands on somebody.
 */
function candidatesFor(
  resource: { title: string; attributes: Record<string, unknown> },
  users: readonly RemoteUser[],
  via: string,
  accountValue: ((user: RemoteUser, via: string) => string | undefined) | undefined,
): ReadinessCandidate[] {
  if (accountValue === undefined) return [];
  const name = resource.title.trim().toLowerCase();
  const emails = new Set(
    Object.values(resource.attributes)
      .filter((value): value is string => typeof value === 'string' && value.includes('@'))
      .map((value) => value.trim().toLowerCase()),
  );

  const out: ReadinessCandidate[] = [];
  for (const user of users) {
    const value = accountValue(user, via);
    if (value === undefined || value === '') continue;
    const userEmail = user.email?.trim().toLowerCase();
    const exact = userEmail !== undefined && emails.has(userEmail);
    const matches = exact || user.name.trim().toLowerCase() === name;
    if (!matches) continue;
    out.push({
      value,
      label: user.email ? `${user.name} · ${user.email}` : user.name,
      ...(exact ? { exact: true } : {}),
    });
  }
  // A fact before a resemblance; otherwise the remote's own order.
  return out.sort((a, b) => Number(b.exact ?? false) - Number(a.exact ?? false));
}

/**
 * Classify one push against the board and what the remote answered.
 *
 * Pure. The live half arrives as data (`ReadinessLive`), so every path —
 * a reachable remote, one that refuses to list its users, one with no accounts
 * at all — is testable without a network.
 */
export function planReadiness(inputs: ReadinessInputs): RemoteReadinessReport {
  const { board, remote, live } = inputs;
  const scope = resolveScope(board.issues, remote.scope);
  const selection = inputs.only === undefined ? null : new Set(inputs.only);
  const issues = board.issues.filter(
    (issue) => isInScope(scope, issue.id) && (selection === null || selection.has(issue.id)),
  );

  // The platform's name as the config spells it, for a sentence that says
  // which tracker refused rather than "the remote".
  const provider = remoteNamed(board.config, remote.name)?.provider ?? remote.name;
  const platform = provider.charAt(0).toUpperCase() + provider.slice(1);

  const roster = rosterOf(board);
  const accounts = normalizeAccountMapping(remote.mapping['accounts']);
  const periodMapping = normalizePeriodMapping(remote.mapping['periods']);
  const accountValue = remote.provider.translator.accountValue?.bind(remote.provider.translator);

  const gaps = pushGaps(board, remote, issues);
  const findings: ReadinessFinding[] = [];

  // -- assignees ------------------------------------------------------------
  // The documents each gap is about, so a finding can name them. The gaps
  // themselves are deduplicated per person, which is the rule `accounts.ts`
  // already keeps: once per person, never once per issue.
  const issuesByResource = new Map<string, string[]>();
  for (const issue of issues) {
    if (!issue.assignee) continue;
    const list = issuesByResource.get(issue.assignee);
    if (list) list.push(issue.id);
    else issuesByResource.set(issue.assignee, [issue.id]);
  }

  for (const gap of uniqueResourceGaps(gaps.resourceGaps)) {
    const affected = documentsOf(issuesByResource.get(gap.resourceId) ?? []);
    const onRoster = roster.get(gap.resourceId);
    if (onRoster === undefined) {
      findings.push({
        key: `assignee:${gap.resourceId}`,
        code: 'assignee_off_roster',
        severity: 'blocks',
        title: `${gap.resourceId} is assigned but not on the roster`,
        detail: 'This assignee was removed from the board.',
        ignored: 'Blocks the push.',
        ...affected,
        fix: { kind: 'unassign', issueIds: affected.documents },
      });
      continue;
    }
    findings.push({
      key: `assignee:${gap.resourceId}`,
      code: 'assignee_no_account',
      severity: 'degrades',
      title: `${onRoster.title} has no ${platform} account`,
      detail: `${gap.reason}.`,
      ignored: 'Pushed unassigned.',
      ...affected,
      ...(accounts !== undefined
        ? {
            fix: {
              kind: 'link_account' as const,
              resourceId: onRoster.id,
              resourceTitle: onRoster.title,
              via: accounts.via,
              candidates:
                live.users === null
                  ? []
                  : candidatesFor(onRoster, live.users, accounts.via, accountValue),
            },
          }
        : {}),
    });
  }

  // A pool is not a person and no tracker has one, so it is reported once per
  // pool and never as something to repair: filing it unassigned with the
  // `pool:` label *is* the design, and the pull restores it. Saying so is the
  // point — a reader who sees forty issues arrive unassigned deserves to have
  // been told why before they were written, not after.
  for (const [resourceId, ids] of issuesByResource) {
    const resource = roster.get(resourceId);
    if (resource === undefined || !resource.generic) continue;
    findings.push({
      key: `assignee:${resourceId}`,
      code: 'assignee_pool',
      severity: 'degrades',
      title: `${resource.title} is a pool; ${platform} has no pools`,
      detail: 'Trackers can only assign people.',
      ignored: 'Pushed unassigned, with a "pool:" label.',
      ...documentsOf(ids),
    });
  }

  // An account the roster holds that the remote does not know. Only askable
  // when the remote answered: an absent listing is not evidence that nobody is
  // there, which is the same rule the pull's gone pass keeps.
  if (live.users !== null && accounts !== undefined && accountValue !== undefined) {
    const known = new Set<string>();
    for (const user of live.users) {
      const value = accountValue(user, accounts.via);
      if (value !== undefined && value !== '') known.add(value.trim().toLowerCase());
    }
    for (const [resourceId, ids] of issuesByResource) {
      const resource = roster.get(resourceId);
      if (resource === undefined || resource.generic) continue;
      const value = resource.attributes[accounts.via];
      if (typeof value !== 'string' || value === '') continue; // already reported above
      if (known.has(value.trim().toLowerCase())) continue;
      findings.push({
        key: `assignee:${resourceId}`,
        code: 'assignee_unknown',
        severity: 'degrades',
        title: `Unknown ${platform} account "${value}"`,
        detail:
          `Set in "${accounts.via}" on ${resource.title}. It may be outdated or not visible to this ` +
          'credential.',
        ignored: 'Pushed unassigned, or rejected by the tracker.',
        ...documentsOf(ids),
        fix: {
          kind: 'link_account',
          resourceId,
          resourceTitle: resource.title,
          via: accounts.via,
          candidates: candidatesFor(resource, live.users, accounts.via, accountValue),
        },
      });
    }
  }

  // -- periods --------------------------------------------------------------
  const periodsById = new Map(board.periods.map((period) => [period.id, period]));
  const issuesByPeriod = new Map<string, string[]>();
  for (const issue of issues) {
    if (!issue.period) continue;
    const list = issuesByPeriod.get(issue.period);
    if (list) list.push(issue.id);
    else issuesByPeriod.set(issue.period, [issue.id]);
  }

  for (const gap of gaps.periodGaps) {
    if (findings.some((finding) => finding.key === `period:${gap.periodId}`)) continue;
    findings.push({
      key: `period:${gap.periodId}`,
      code: 'period_off_timeline',
      severity: 'blocks',
      title: `${gap.periodId} is scheduled but not on the timeline`,
      detail: 'This period was removed from the board.',
      ignored: 'Blocks the push.',
      ...documentsOf(issuesByPeriod.get(gap.periodId) ?? []),
    });
  }

  // A period with no twin upstream. Reported only when the remote answered and
  // only for the level it actually files — a level above the mapped container
  // rides the managed block, so there is no twin for it to be missing.
  if (live.periods !== null && periodMapping !== undefined) {
    const filed = new Set(live.periods.map((sprint) => sprint.name.trim().toLowerCase()));
    for (const [periodId, ids] of issuesByPeriod) {
      const period = periodsById.get(periodId);
      if (period === undefined || period.type !== periodMapping.container) continue;
      if (filed.has(period.title.trim().toLowerCase())) continue;
      findings.push({
        key: `period:${periodId}`,
        code: 'period_not_filed',
        severity: 'degrades',
        title: `${period.title} is not on ${platform}`,
        detail: 'No period with this name on the tracker.',
        ignored: 'Pushed unscheduled.',
        ...documentsOf(ids),
        fix: { kind: 'file_period', periodId, periodTitle: period.title },
      });
    }
  }

  findings.sort(
    (a, b) =>
      Number(b.severity === 'blocks') - Number(a.severity === 'blocks') ||
      a.key.localeCompare(b.key, 'en', { numeric: true }),
  );

  return {
    remote: {
      name: remote.name,
      provider,
      target: describeTarget(provider, remote.connection),
    },
    findings,
    documents: issues.length,
    blocked: findings.some((finding) => finding.severity === 'blocks'),
    ...(live.unreachable !== undefined ? { unreachable: live.unreachable } : {}),
    askedUsers: live.users !== null,
    askedPeriods: live.periods !== null,
  };
}

/**
 * Ask the remote the two questions, then classify.
 *
 * Two requests, whatever the size of the push: the project's assignable people
 * and its periods. A connector that cannot answer one leaves that half `null`,
 * and the findings that would have needed it are simply not made — an absent
 * listing is never read as "nobody is there", which is the same rule the
 * pull's gone pass keeps about a partial listing.
 */
export async function checkReadiness(
  board: LoadedBoard,
  remote: OpenedRemote,
  paths: BoardPaths,
  options: { only?: readonly string[]; signal?: AbortSignal } = {},
): Promise<RemoteReadinessReport> {
  const live: ReadinessLive = { users: null, periods: null };

  let connector;
  try {
    connector = buildConnector(remote, paths);
  } catch (error) {
    live.unreachable = describeError(error);
  }

  if (connector !== undefined) {
    if (typeof connector.listUsers === 'function') {
      try {
        live.users = await connector.listUsers(options.signal);
      } catch (error) {
        // A refusal is reported, never treated as an empty roster upstream:
        // "the credential may not browse users" and "nobody can be assigned"
        // are different answers and only one of them is about the board.
        live.unreachable = describeError(error);
      }
    }
    if (typeof connector.listSprints === 'function') {
      try {
        live.periods = await connector.listSprints(options.signal);
      } catch (error) {
        live.unreachable ??= describeError(error);
      }
    }
  }

  return planReadiness({
    board,
    remote,
    live,
    ...(options.only !== undefined ? { only: options.only } : {}),
  });
}

/** The issues a `blocks` finding names, for a caller that wants to report them. */
export function blockingDocuments(report: RemoteReadinessReport): string[] {
  const ids = new Set<string>();
  for (const finding of report.findings) {
    if (finding.severity !== 'blocks') continue;
    for (const id of finding.documents) ids.add(id);
  }
  return [...ids].sort(byId);
}
