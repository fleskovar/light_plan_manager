/**
 * What a remote must already have before a push can land — created by the push
 * itself.
 *
 * Some of what a board carries is not an issue field on the other side but a
 * *thing the tracker has to own first*: a GitHub repository only applies labels
 * it already defines, a Projects v2 board only sets a field that has been
 * created with the right options. Push a plan onto a fresh project and every
 * one of those is missing.
 *
 * **Sprints are deliberately not in that list, though they look like they
 * belong.** A label is vocabulary — it exists only because the mapping needs
 * somewhere to put a type — but a sprint is a *document on the board*, with a
 * name and dates somebody wrote down. Creating one is filing part of the plan,
 * not preparing to file it, and bundling it in here meant a board's whole
 * timeline had to land before a single story could: one refused sprint name
 * and nothing could be pushed at all. Periods are pushed like any other
 * document (`lpm remote push TL-3`), and an issue whose sprint is not there
 * yet is filed unscheduled and repaired by the push that files the sprint.
 *
 * This used to be a command of its own — `lpm remote provision` — which meant
 * the first push failed, printed the name of a second command, and worked on
 * the retry. That is a tool asking somebody to learn a word ("provision") for a
 * step it could simply take: nothing here is a decision, it is all *implied* by
 * the mapping the board already wrote down. A sprint is a period on the board,
 * a label is how this provider carries a type; creating them is part of filing
 * the plan, not a separate act.
 *
 * So the push does it, and reports what it made. Two entry points, the same
 * split the rest of this layer uses: `planPrerequisites` asks the remote what
 * it has and returns what is missing (read-only, safe on a dry run), and
 * `createPrerequisites` makes them. The *desired* sets stay pure in
 * `provision.ts` — this module is only the I/O and the ordering.
 *
 * Nothing here is destructive: every operation creates something the mapping
 * already names, each is idempotent, and a provider whose connector cannot do
 * one of them simply reports nothing for it.
 */

import type { LoadedBoard } from '../core/board/load.js';
import { BoardError } from '../core/errors.js';
import type { BoardPaths } from '../core/storage/paths.js';
import { labelColor, missingLabels } from './labels.js';
import { missingSprints } from './providers/jira/sprints.js';
import { desiredLabelsOf, desiredSprintsOf } from './provision.js';
import type { Connector } from './provider.js';
import type { OpenedRemote } from './remotes.js';
import { resolveProjectIds } from './providers/github/projects.js';
import {
  desiredProjectFields,
  planProjectProvision,
  provisionProjectGraphql,
  type ProjectProvisionPlan,
} from './providers/github/project-provision.js';

/** One sprint the timeline names and the remote has not got. */
export interface MissingSprint {
  name: string;
  starts?: string;
  ends?: string;
}

/** What the remote is missing, before a push writes anything. */
export interface Prerequisites {
  /** Mapped labels the remote does not define. */
  labels: string[];
  /**
   * Sprints named by the periods this run was *asked* to file, and only those.
   * Empty unless the run names period documents — pushing work never files the
   * timeline behind it.
   */
  sprints: MissingSprint[];
  /** The Projects v2 fields and options to create, when the mapping names a Project. */
  project?: { id: string; plan: ProjectProvisionPlan };
}

/** One thing the remote would not create, and what it said about it. */
export interface PrerequisiteFailure {
  /** What was being created — `sprint "Sprint 5 — Test Coverage"`. */
  what: string;
  /** The remote's own complaint, as the connector rendered it. */
  message: string;
  /** The connector's hints, when it had any. */
  details: readonly string[];
}

/** What a push actually created, for its report. */
export interface PrerequisiteReport {
  labels: string[];
  sprints: string[];
  /** Projects v2 fields created, and single-select options added. */
  projectFields: number;
  projectOptions: number;
  /**
   * What the remote refused. **Collected, never thrown**, for two reasons. A
   * push is partial rather than atomic everywhere else, and a sprint the
   * tracker will not create is no reason to refuse to file forty issues that
   * have nothing to do with it — whatever actually needed the missing thing
   * fails as its own operation, with its own message. And stopping at the
   * first refusal means learning about the others one run at a time: a board
   * with sixteen sprints, three of them named too long for Jira, took three
   * pushes to reveal three problems that could have been one list.
   */
  failures: PrerequisiteFailure[];
}

/** True when nothing at all is missing — the ordinary case after the first push. */
export function isSatisfied(pre: Prerequisites): boolean {
  return (
    pre.labels.length === 0 &&
    pre.sprints.length === 0 &&
    (pre.project === undefined || pre.project.plan.empty)
  );
}

/** An empty report, for a run that had nothing to create. */
export function emptyReport(): PrerequisiteReport {
  return { labels: [], sprints: [], projectFields: 0, projectOptions: 0, failures: [] };
}

/**
 * Ask the remote what it is missing. Read-only on both sides, so a dry run can
 * say what a real push would create without creating it.
 *
 * A connector that cannot list a kind of thing contributes nothing of that kind
 * — the capability is the connector's to have, never this module's to assume.
 */
export async function planPrerequisites(
  board: LoadedBoard,
  remote: OpenedRemote,
  connector: Connector,
  paths: BoardPaths,
  options?: { periods?: 'all' | ReadonlySet<string> },
): Promise<Prerequisites> {
  const labels =
    typeof connector.listLabels === 'function' && typeof connector.createLabel === 'function'
      ? missingLabels(desiredLabelsOf(board, remote), await connector.listLabels())
      : [];

  // Only the periods this run names. `desiredSprintsOf` still answers "every
  // period at the mapped level", and `lpm remote push --all` asks for exactly
  // that; a run that named some documents asks for those.
  const wanted = options?.periods;
  const sprints =
    wanted !== undefined &&
    typeof connector.listSprints === 'function' &&
    typeof connector.createSprint === 'function'
      ? missingSprints(
          desiredSprintsOf(board, remote).filter(
            (sprint) => wanted === 'all' || wanted.has(sprint.name),
          ),
          await connector.listSprints(),
        )
      : [];

  const input = projectInputOf(remote);
  let project: Prerequisites['project'];
  if (input !== undefined) {
    // Always against the live Project: the plan must compare what is desired to
    // what exists *now*, not to a cache that may predate a field created by
    // hand.
    const resolved = await resolveProjectIds(connector, input, paths, remote.name, {
      refresh: true,
    });
    project = {
      id: resolved.ids.project.id,
      plan: planProjectProvision(resolved.ids, desiredProjectFields(board, remote)),
    };
  }

  return { labels, sprints, ...(project !== undefined ? { project } : {}) };
}

/**
 * Create what `planPrerequisites` found, in the order a push needs it: labels
 * and sprints before any issue is written, Project fields before a status is
 * set on one.
 */
export async function createPrerequisites(
  remote: OpenedRemote,
  connector: Connector,
  paths: BoardPaths,
  pre: Prerequisites,
): Promise<PrerequisiteReport> {
  const report = emptyReport();

  /** Run one creation, recording a refusal rather than abandoning the rest. */
  const attempt = async (what: string, run: () => Promise<void>): Promise<boolean> => {
    try {
      await run();
      return true;
    } catch (error) {
      report.failures.push({
        what,
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof BoardError ? error.details : [],
      });
      return false;
    }
  };

  for (const label of pre.labels) {
    const made = await attempt(`label ${label}`, async () => {
      await connector.createLabel!(label, labelColor(label));
    });
    if (made) report.labels.push(label);
  }

  for (const sprint of pre.sprints) {
    const made = await attempt(`sprint "${sprint.name}"`, async () => {
      await connector.createSprint!(sprint.name, sprint.starts, sprint.ends);
    });
    if (made) report.sprints.push(sprint.name);
  }

  if (pre.project !== undefined && !pre.project.plan.empty) {
    const project = pre.project;
    await attempt('Projects v2 fields', async () => {
      const outcome = await provisionProjectGraphql(connector, project.id, project.plan);
      report.projectFields = outcome.created.length;
      report.projectOptions = outcome.optionsAdded.reduce(
        (total, field) => total + field.added.length,
        0,
      );
      // Re-resolve so the new field and option node ids land in the committed
      // cache: the executor reads them rather than resolving again.
      const input = projectInputOf(remote);
      if (input !== undefined) {
        await resolveProjectIds(connector, input, paths, remote.name, { refresh: true });
      }
    });
  }

  return report;
}

/** The Projects v2 target a mapping names, or `undefined` when it names none. */
function projectInputOf(
  remote: OpenedRemote,
): { repo: string; project: number | string; fields: Record<string, string> } | undefined {
  const project = remote.mapping['project'];
  if (project === undefined) return undefined;
  const repo = remote.connection['repo'];
  if (typeof repo !== 'string' || repo === '') {
    throw new BoardError(`Remote "${remote.name}" has no repository`, [
      `Set remotes.${remote.name}.connection.repo to "owner/repo".`,
    ]);
  }
  const fields = (remote.mapping['fields'] as Record<string, unknown> | undefined) ?? {};
  return {
    repo,
    project: project as number | string,
    fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, String(value)])),
  };
}
