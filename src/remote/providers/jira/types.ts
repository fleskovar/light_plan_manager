/**
 * The Jira issue-type scheme — the project's *actual* types and their
 * hierarchy levels, and what the board's `mapping.types` means against them
 * (LP-324).
 *
 * Jira's issue types are per-project configuration, never platform constants:
 * an org may have renamed "Epic", deleted "Story", or added levels above Epic
 * (a paid Premium feature). So the mapping is validated **by name** against
 * what the project actually reports, and there is no built-in default table —
 * a board's `epic` may be Jira's "Initiative" on one site and "Epic" on the
 * next. This module is the judge: a project's reported types in, a report out.
 * The connector fetches the types (`issueTypes()`); `validateTypeMapping` and
 * `typeSchemeProblems` only judge them, and `preflightTypeScheme` is the one
 * async composition that ties the fetch to the judge — the "fetched at
 * preflight and validated against them" acceptance criterion, ready for the
 * sync command to call before it plans a push.
 *
 * Hierarchy levels, from the Cloud API (`fields.issuetype.hierarchyLevel`):
 *
 *   -1  sub-task — must have a parent, never top-level
 *    0  standard — Story, Task, Bug
 *    1  epic — the classic ceiling
 *    2+ levels above epic (Initiative, …) — a paid Premium feature
 *
 * The native *parent* levels a project supports is the span between its lowest
 * and highest level, so "Epic › Story › Sub-task" is 2 and a Premium board
 * with "Initiative" is 3. Detected, never assumed.
 */

import { resolveHierarchyEncoding } from '../../hierarchy.js';
import { normalizeTypeMappings, type DegradedLevel } from '../../mapping.js';
import type { Problem } from '../../../core/model/types.js';

/** One issue type as the project reports it (`GET /rest/api/3/project/{key}?expand=issueTypes`). */
export interface JiraIssueType {
  /** The issue type name, e.g. "Story", "Epic", "Sub-task". */
  name: string;
  /** True for sub-task types — they must be created with a parent. */
  subtask?: boolean;
  /** The hierarchy level: -1 sub-task, 0 standard, 1 epic, 2+ above. */
  hierarchyLevel?: number;
}

/** True when the type is a sub-task — the `subtask` flag, or a -1 level. */
export function isSubtaskType(type: JiraIssueType): boolean {
  if (type.subtask !== undefined) return type.subtask;
  return type.hierarchyLevel === -1;
}

/** The hierarchy level a type sits at: sub-tasks force -1, the rest report theirs (default 0). */
export function hierarchyLevelOf(type: JiraIssueType): number {
  if (isSubtaskType(type)) return -1;
  return typeof type.hierarchyLevel === 'number' ? type.hierarchyLevel : 0;
}

/**
 * The native parent levels a project's scheme supports: the span from its
 * lowest level (sub-task -1, or 0 without sub-tasks) to its highest (0
 * standard, 1 epic, 2+ Premium). A standard-only project is flat (0).
 */
export function hierarchyDepthOf(types: readonly JiraIssueType[]): number {
  if (types.length === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const type of types) {
    const level = hierarchyLevelOf(type);
    if (level < min) min = level;
    if (level > max) max = level;
  }
  return Math.max(0, max - min);
}

/** A mapped type the project does not have. */
export interface MissingType {
  /** The board type name, e.g. `feature`. */
  boardType: string;
  /** The Jira issuetype name the mapping points at, e.g. `Feature`. */
  mappedType: string;
}

/** The board's `mapping.types` judged against the project's actual scheme. */
export interface TypeSchemeReport {
  /** The project's issue type names, sorted — the list a bad mapping is shown. */
  available: string[];
  /** Board types whose mapped type the project does not have. */
  missing: MissingType[];
  /** Board types that map to a sub-task type (must always carry a parent). */
  subtasks: string[];
  /** The project's native parent levels, as the hierarchy capability reads. */
  hierarchyDepth: number;
  /** The board levels beyond the project's native depth — their parent degrades. */
  degraded: DegradedLevel[];
}

/**
 * Judge the board's `mapping.types` against the project's reported types.
 *
 * Pure: types + mapping + hierarchy in, a report out. A board type whose mapped
 * type is absent is reported with the full `available` list, so a user can fix
 * the mapping before filing anything. Types that map to a sub-task are named so
 * the push knows they must carry a parent. The degraded levels come from
 * `resolveHierarchyEncoding`, the same computation the push uses, so the report
 * and the sync cannot disagree about which nesting degrades to labels plus the
 * managed block.
 */
export function validateTypeMapping(
  mapping: Record<string, unknown>,
  types: readonly JiraIssueType[],
  hierarchy: string[][],
): TypeSchemeReport {
  const byName = new Map<string, JiraIssueType>();
  for (const type of types) {
    if (!byName.has(type.name)) byName.set(type.name, type);
  }

  const missing: MissingType[] = [];
  const subtasks: string[] = [];
  // Read straight off a remote declaration rather than through the provider
  // schema, so it goes through the same normalizer the schema uses.
  const typeMap = normalizeTypeMappings((mapping['types'] ?? {}) as Record<string, unknown>);
  for (const [boardType, entry] of Object.entries(typeMap)) {
    // The mapped name is a Jira issuetype name here — the project must have
    // the one it is asked to file against.
    const mappedType = entry.remote;
    const found = byName.get(mappedType);
    if (found === undefined) {
      missing.push({ boardType, mappedType });
    } else if (isSubtaskType(found)) {
      subtasks.push(boardType);
    }
  }

  const depth = hierarchyDepthOf(types);
  const { degraded } = resolveHierarchyEncoding({ hierarchyDepth: depth }, hierarchy);

  return {
    available: [...byName.keys()].sort(),
    missing: missing.sort((a, b) => a.boardType.localeCompare(b.boardType)),
    subtasks: subtasks.sort(),
    hierarchyDepth: depth,
    degraded,
  };
}

/**
 * The preflight problems a `TypeSchemeReport` becomes, in the codebase's own
 * report vocabulary (`Problem[]`) — the shape `lpm remote …` prints and
 * `hasErrorProblems` gates on.
 *
 * A mapped type the project does not have is an **error** naming the missing
 * type *and* the list the project does have, so the fix is read off the report
 * rather than guessed. A level beyond the project's native depth is a
 * **warning**: its parent degrades to labels plus the managed block, the push
 * still works.
 */
export function typeSchemeProblems(
  report: TypeSchemeReport,
  remoteName: string,
  configPath: string,
): Problem[] {
  const problems: Problem[] = [];
  for (const missing of report.missing) {
    problems.push({
      level: 'error',
      path: configPath,
      message:
        `remotes.${remoteName}.mapping.types.${missing.boardType}: the project has no issue type ` +
        `"${missing.mappedType}" — it has: ${report.available.join(', ')}`,
    });
  }
  for (const level of report.degraded) {
    problems.push({
      level: 'warn',
      path: configPath,
      message:
        `remotes.${remoteName}.mapping.types: level ${level.depth} (${level.types.join(', ')}) is deeper ` +
        `than the project's ${report.hierarchyDepth} native parent level` +
        `${report.hierarchyDepth === 1 ? '' : 's'} — its parent degrades to labels plus the managed block`,
    });
  }
  return problems;
}

/**
 * The live preflight for the type scheme (LP-324): fetch the project's issue
 * types through the connector and judge the board's `mapping.types` against
 * them, returning the `Problem[]` a sync gates on (`hasErrorProblems`).
 *
 * This is the one async composition the pure halves cannot do on their own:
 * the connector fetches, `validateTypeMapping` judges, `typeSchemeProblems`
 * reports. A connector without `issueTypes()` — a provider with no native type
 * scheme, or a fake in a test — is a no-op: there is no scheme to validate the
 * mapping against, so there is nothing to report.
 *
 * `hierarchy` is the board's issue hierarchy (`hierarchyFor(config, 'issue')`);
 * the report and the push both read it through `resolveHierarchyEncoding`, so
 * the degraded levels named here are exactly the levels whose parent rides the
 * managed block on the way out.
 */
export async function preflightTypeScheme(
  connector: { issueTypes?(): Promise<readonly JiraIssueType[]> },
  mapping: Record<string, unknown>,
  hierarchy: string[][],
  remoteName: string,
  configPath: string,
): Promise<Problem[]> {
  if (typeof connector.issueTypes !== 'function') return [];
  const types = await connector.issueTypes();
  return typeSchemeProblems(validateTypeMapping(mapping, types, hierarchy), remoteName, configPath);
}
