import path from 'node:path';
import type { ProfileScope } from '../model/profile.js';
import { isEmptyScope } from '../model/profile.js';
import type { Issue, Period } from '../model/types.js';
import type { LoadedBoard } from './load.js';
import { findIssue, findPeriod, subtreeOf } from './query.js';

/**
 * Narrowing the board to one person's part of it.
 *
 * A `ProfileScope` names documents; a `ResolvedScope` is what that means on
 * *this* board — the actual issues, the periods with their children folded in,
 * and the names that matched nothing. Resolving once and asking many times is
 * what keeps the filter cheap enough to sit inside `nextTasks`.
 *
 * One rule governs where this may be used: **scope decides what the board
 * offers you, never what is reachable.** It filters recommendations and
 * listings; it never hides a document you asked for by id, and it never hides
 * work you have already picked up. Anything else and a dependency would point
 * at something that, as far as you could tell, did not exist.
 *
 * It is routing, not access control. The board is a folder of markdown that the
 * person holding the profile can read; this decides what gets handed to them,
 * not what they are permitted to see.
 */

export interface ResolvedScope {
  /** Issues everything must sit at or below. `null` when unrestricted. */
  under: Issue[] | null;
  /** Issues nothing may sit at or below. Empty when nothing is excluded. */
  exclude: Issue[];
  /** Issue types allowed, or `null` when unrestricted. */
  types: string[] | null;
  /** Period ids allowed, child periods included, or `null` when unrestricted. */
  periods: Set<string> | null;
  /** Names in the profile this board has nothing for. Reported, never fatal. */
  unknown: string[];
  /** False when nothing is declared, so every issue is in scope. */
  active: boolean;
}

/** A scope that excludes nothing — what every caller without a profile gets. */
export function fullScope(): ResolvedScope {
  return { under: null, exclude: [], types: null, periods: null, unknown: [], active: false };
}

function isAtOrBelow(issue: Issue, root: Issue): boolean {
  return issue.dir === root.dir || issue.dir.startsWith(root.dir + path.sep);
}

function resolveIssues(board: LoadedBoard, ids: string[], unknown: string[]): Issue[] {
  const issues: Issue[] = [];
  for (const id of ids) {
    const issue = findIssue(board, id);
    if (issue) issues.push(issue);
    else unknown.push(id);
  }
  return issues;
}

/**
 * A period holds work scheduled in it *and* in the periods below it, the same
 * way `issuesInPeriod` does — naming an increment must not mean "the sprints
 * inside it do not count".
 */
function resolvePeriods(board: LoadedBoard, ids: string[], unknown: string[]): Set<string> {
  const allowed = new Set<string>();
  for (const id of ids) {
    const period = findPeriod(board, id);
    if (!period) {
      unknown.push(id);
      continue;
    }
    for (const node of subtreeOf<Period>(board.periods, period)) allowed.add(node.id);
  }
  return allowed;
}

function resolveTypes(board: LoadedBoard, names: string[], unknown: string[]): string[] {
  const types: string[] = [];
  for (const name of names) {
    if (board.config.issue_types[name]) types.push(name);
    else unknown.push(name);
  }
  return types;
}

/**
 * What a profile's scope means on this board.
 *
 * A name that resolves to nothing is dropped and reported rather than throwing:
 * one profile may well be pointed at a board that has moved on, and a developer
 * whose CLI refuses to run because an epic was renamed is worse served than one
 * who is told about it. What it does *not* do is quietly widen the scope — a
 * declared list that resolves to nothing matches nothing, so a stale `under`
 * fails closed and says so.
 */
export function resolveScope(board: LoadedBoard, scope: ProfileScope): ResolvedScope {
  if (isEmptyScope(scope)) return fullScope();

  const unknown: string[] = [];
  return {
    under: scope.under ? resolveIssues(board, scope.under, unknown) : null,
    exclude: scope.exclude ? resolveIssues(board, scope.exclude, unknown) : [],
    types: scope.types ? resolveTypes(board, scope.types, unknown) : null,
    periods: scope.periods ? resolvePeriods(board, scope.periods, unknown) : null,
    unknown,
    active: true,
  };
}

export function inScope(scope: ResolvedScope, issue: Issue): boolean {
  if (!scope.active) return true;
  if (scope.exclude.some((root) => isAtOrBelow(issue, root))) return false;
  if (scope.under && !scope.under.some((root) => isAtOrBelow(issue, root))) return false;
  if (scope.types && !scope.types.includes(issue.type)) return false;
  if (scope.periods && !(issue.period && scope.periods.has(issue.period))) return false;
  return true;
}

/** The issues a scope leaves, in board order. */
export function scopedIssues(board: LoadedBoard, scope: ResolvedScope): Issue[] {
  return scope.active ? board.issues.filter((issue) => inScope(scope, issue)) : board.issues;
}

/** One line saying what is being applied, for the CLI and for an agent to read. */
export function describeScope(scope: ResolvedScope): string {
  if (!scope.active) return 'the whole board';
  const parts: string[] = [];
  if (scope.under) parts.push(`under ${scope.under.map((issue) => issue.id).join(', ') || 'nothing'}`);
  if (scope.exclude.length) parts.push(`not ${scope.exclude.map((issue) => issue.id).join(', ')}`);
  if (scope.types) parts.push(scope.types.join('/') || 'no type');
  if (scope.periods) parts.push(`in ${[...scope.periods].join(', ') || 'no period'}`);
  return parts.join(' · ');
}

/**
 * A squad's member resource ids, resolved against the current roster.
 *
 * A member id the board no longer has is dropped and reported rather than
 * throwing — a squad that named someone who has since left the roster is a fact
 * the board should know, not a reason to stop loading. An empty squad matches
 * nothing, never everything: the "stale scope fails closed" rule.
 */
export interface ResolvedSquad {
  /** Resource ids that are on the roster. */
  members: string[];
  /** Member ids the board has nothing for. Reported, never fatal. */
  unknown: string[];
  /** False when the squad has no members, so nothing is matched. */
  active: boolean;
}

/** A squad that has nothing to match — what every call falling through gets. */
export function emptySquad(): ResolvedSquad {
  return { members: [], unknown: [], active: false };
}

/**
 * Resolve a squad to its current member resource ids.
 *
 * Follows the same "resolve once, ask many times" pattern as `resolveScope`:
 * the result can be cached and reused for every issue in a period. A stale
 * member id is dropped and reported in `unknown` — the "stale scope fails
 * closed" rule — so a squad whose every member has left the roster matches
 * nothing rather than everything.
 */
export function resolveSquad(board: LoadedBoard, squadId: string): ResolvedSquad {
  const squad = board.squadsById.get(squadId);
  if (!squad) return emptySquad();

  const members: string[] = [];
  const unknown: string[] = [];

  for (const id of squad.members) {
    if (board.resourcesById.has(id)) {
      members.push(id);
    } else {
      unknown.push(id);
    }
  }

  return { members, unknown, active: members.length > 0 };
}
