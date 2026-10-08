/**
 * Asking a remote about itself — the conversation `lpm remote setup` and
 * `lpm remote connect` have with a tracker, returned as a report rather than
 * printed as it goes.
 *
 * It used to live inside the CLI command, interleaved with the lines it wrote
 * to the terminal. A browser cannot read a terminal, and the rule this layer
 * keeps is that a second front end never grows a second copy of a decision —
 * so the *decisions* live here, and the front ends differ only in how they show
 * the result and how they put what is left to a person:
 *
 *   1. **reachability** — `reachable()` separates "this credential cannot see
 *      the project" from "the mapping is wrong", which are otherwise the same
 *      404. Unreachable stops everything after it: nothing below can be asked.
 *   2. **discovery** — a connection key only part of the mapping needs (Jira's
 *      Agile board) is asked of the remote rather than of the person. Exactly
 *      one candidate is written; several is a choice; none is a gap, reported
 *      with the provider's own `why`.
 *   3. **vocabulary** — the mapping's words against the remote's own. A word
 *      spelled differently is corrected in place; a word the remote does not
 *      have at all is left for a person, with the remote's names as options.
 *   4. **prerequisites** — the vocabulary the next push creates for itself
 *      (labels, Project fields) and the periods it will not file.
 *
 * `apply: false` is a dry run: the report says what would be written and
 * nothing is. What a person answers afterwards goes through
 * `applyInspectAnswers`, over the same two surgical writers.
 */

import type { LoadedBoard } from '../core/board/load.js';
import { remoteNamed } from '../core/config/lookup.js';
import { BoardError } from '../core/errors.js';
import type { BoardConfig } from '../core/model/types.js';
import type { BoardPaths } from '../core/storage/paths.js';
import { updateRemoteConnection, updateRemoteMapping, type MappingCorrections } from './config-file.js';
import { planPrerequisites } from './prerequisites.js';
import type { ConnectionCandidate, ReachabilityResult } from './provider.js';
import { corrections, mappingClaims, reconcileMapping, type ReconcileReport } from './reconcile.js';
import { lookupProvider } from './registry.js';
import { buildConnector, openRemote } from './remotes.js';

/** A connection key the remote answered in several ways, or not at all. */
export interface ConnectionQuestion {
  key: string;
  /** What breaks without it — the provider's own words. */
  why: string;
  /** What the remote offered; empty when it offered nothing. */
  candidates: ConnectionCandidate[];
}

/** What asking a remote about itself found, and what it wrote. */
export interface InspectReport {
  /** Absent when the connector cannot say (it declares no `reachable`). */
  reachability?: ReachabilityResult;
  /** True when the remote could not be reached, so nothing after it was asked. */
  stopped: boolean;
  /** Keys the remote answered with exactly one value — written when applied. */
  found: ConnectionCandidate[];
  /** Keys the remote answered with several values — a person chooses. */
  choices: ConnectionQuestion[];
  /** Keys the remote could not answer — a person finds them. */
  needed: ConnectionQuestion[];
  /** The vocabulary check; absent when the provider has none to ask about. */
  vocabulary?: {
    report: ReconcileReport;
    /** The renames the report implies — written when applied. */
    corrections: MappingCorrections;
  };
  /** What the next push creates, and the timeline it will not file. Absent when stopped. */
  prerequisites?: {
    labels: string[];
    projectFields: number;
    sprints: string[];
    /** Whether the connector can list labels at all: "nothing to create" means nothing without it. */
    canListLabels: boolean;
  };
  /** The `config.yml` lines this run changed. Always empty on a dry run. */
  written: string[];
}

/** The structural shape of the one optional connector method this module calls by name. */
interface Discovering {
  discoverConnection?: () => Promise<ConnectionCandidate[]>;
}

/**
 * Ask the declared remote `name` about itself.
 *
 * Throws what `openRemote` and `buildConnector` throw — an undeclared remote, an
 * unresolved credential — before any request is made.
 */
export async function inspectRemoteConnection(
  board: LoadedBoard,
  name: string,
  options: { apply: boolean },
): Promise<InspectReport> {
  const remote = openRemote(board.config, name);
  const connector = buildConnector(remote, board.paths);
  const report: InspectReport = { stopped: false, found: [], choices: [], needed: [], written: [] };

  // -- 1. reachability ------------------------------------------------------
  if (typeof connector.reachable === 'function') {
    report.reachability = await connector.reachable();
    if (!report.reachability.reachable) {
      report.stopped = true;
      return report;
    }
  }

  // -- 2. discovery ---------------------------------------------------------
  const gaps = (remote.provider.conditionalConnection ?? []).filter(
    (need) =>
      remote.mapping[need.needs] !== undefined &&
      (remote.connection[need.key] === undefined || remote.connection[need.key] === ''),
  );
  if (gaps.length > 0) {
    const discover = (connector as Discovering).discoverConnection;
    const candidates = typeof discover === 'function' ? await discover.call(connector) : [];
    const answers: Record<string, string> = {};
    for (const need of gaps) {
      const forKey = candidates.filter((candidate) => candidate.key === need.key);
      if (forKey.length === 1) {
        report.found.push(forKey[0]!);
        answers[need.key] = forKey[0]!.value;
      } else if (forKey.length > 1) {
        report.choices.push({ key: need.key, why: need.why, candidates: forKey });
      } else {
        report.needed.push({ key: need.key, why: need.why, candidates: [] });
      }
    }
    // A value the remote itself reported, and the only one it reported, is not
    // a guess — so it is written, and the report says so.
    if (options.apply && Object.keys(answers).length > 0) {
      report.written.push(...updateRemoteConnection(board.paths, name, answers).changed);
    }
  }

  // -- 3. vocabulary --------------------------------------------------------
  if (typeof connector.vocabulary === 'function') {
    const vocabulary = await connector.vocabulary();
    const reconciled = reconcileMapping(mappingClaims(remote.mapping), vocabulary);
    const renames: MappingCorrections = {
      ...(reconciled.types ? { types: corrections(reconciled.types) } : {}),
      ...(reconciled.statuses ? { statuses: corrections(reconciled.statuses) } : {}),
    };
    report.vocabulary = { report: reconciled, corrections: renames };
    const count = Object.keys(renames.types ?? {}).length + Object.keys(renames.statuses ?? {}).length;
    if (options.apply && count > 0) {
      report.written.push(...updateRemoteMapping(board.paths, name, renames).changed);
    }
  }

  // -- 4. prerequisites -----------------------------------------------------
  // `periods: 'all'` asks for the whole picture: a push of work files none of
  // the timeline, so what is missing there is reported rather than created.
  const missing = await planPrerequisites(board, remote, connector, board.paths, { periods: 'all' });
  report.prerequisites = {
    labels: missing.labels,
    projectFields:
      missing.project !== undefined && !missing.project.plan.empty
        ? missing.project.plan.createFields.length
        : 0,
    sprints: missing.sprints.map((sprint) => sprint.name),
    canListLabels: typeof connector.listLabels === 'function',
  };

  return report;
}

/** What a person answered to the questions an inspection left. */
export interface InspectAnswers {
  /** `connection key → the value chosen` — a discovered key with several candidates. */
  connection?: Record<string, string>;
  /** `board type → the remote's name for it`. */
  types?: Record<string, string>;
  /** `board status → the remote's name for it`. */
  statuses?: Record<string, string>;
}

/**
 * Write what a person answered, through the same surgical writers the
 * inspection uses: a discovered key fills a gap and never overrules a value
 * somebody wrote, and a vocabulary answer rewrites one entry's name and nothing
 * else in the file. Returns the lines changed.
 *
 * A connection answer may only name a key the provider declares as
 * *discoverable* (`conditionalConnection`). This is the one writer here that
 * takes free-form keys from a caller, and without the check it would write
 * anything into `connection:` — a token included, straight into the committed
 * config. Every other connection value changes through `setRemoteConnection`,
 * where secrets are refused and a remote with twins is not re-pointed.
 */
export function applyInspectAnswers(
  paths: BoardPaths,
  config: BoardConfig,
  name: string,
  answers: InspectAnswers,
): string[] {
  const changed: string[] = [];
  if (answers.connection !== undefined && Object.keys(answers.connection).length > 0) {
    const declared = remoteNamed(config, name);
    if (!declared) {
      throw new BoardError(`No remote named "${name}"`, ['Nothing was written.']);
    }
    const discoverable = new Set(
      (lookupProvider(declared.provider).conditionalConnection ?? []).map((need) => need.key),
    );
    for (const key of Object.keys(answers.connection)) {
      if (!discoverable.has(key)) {
        throw new BoardError(`"${key}" is not a connection key the remote can be asked about`, [
          discoverable.size > 0
            ? `Provider "${declared.provider}" discovers: ${[...discoverable].join(', ')}`
            : `Provider "${declared.provider}" discovers no connection keys.`,
          'Other connection values change through the connection itself, where a secret is refused.',
        ]);
      }
    }
    changed.push(...updateRemoteConnection(paths, name, answers.connection).changed);
  }
  const mapping: MappingCorrections = {
    ...(answers.types !== undefined && Object.keys(answers.types).length > 0 ? { types: answers.types } : {}),
    ...(answers.statuses !== undefined && Object.keys(answers.statuses).length > 0
      ? { statuses: answers.statuses }
      : {}),
  };
  if (mapping.types !== undefined || mapping.statuses !== undefined) {
    changed.push(...updateRemoteMapping(paths, name, mapping).changed);
  }
  return changed;
}
