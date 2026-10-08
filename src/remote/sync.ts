/**
 * The sync session — one remote, one direction, planned then rendered or
 * applied (LP-341).
 *
 * `planPush` / `planPull` are pure, `executePush` / `applyPull` do the I/O, and
 * `renderPlan` turns a plan into text.  This file is the composition the CLI's
 * `push` / `pull` / `sync` subcommands are thin printers over: it opens the
 * remote, resolves its capabilities and hierarchy encoding, fetches the remote
 * listing for a pull, runs the push preflight gate, plans, and — unless it is a
 * dry run — applies the plan and records the cursor.
 *
 * No reshaping logic lives here either: the planners decide what changed and in
 * what order; this file only supplies the inputs they need (the `RemoteSnapshot`,
 * the pull translation seams) and hands their output to the appliers.
 */

import { loadBoard, readComments, remoteNamed } from '../core/index.js';
import { BoardError } from '../core/errors.js';
import type { LoadedBoard } from '../core/board/load.js';
import type { Problem } from '../core/model/types.js';
import { displayPath, type BoardPaths } from '../core/storage/paths.js';
import { toSnapshot } from '../sync/dto.js';
import { subtreeIds, type BoardView } from '../shared/plans/reading.js';
import { recordSyncAudit, recordSyncFailure } from './audit.js';
import {
  loadCapabilityCache,
  resolveCapabilities,
  saveCapabilityCache,
} from './capabilities.js';
import type { OpProgress, PushExecutionResult } from './execute.js';
import { executePush } from './execute.js';
import { resolveHierarchyEncoding } from './hierarchy.js';
import type { HierarchyEncoding } from './hierarchy.js';
import { buildLedger, idsOwnedElsewhere } from './ledger.js';
import {
  createPrerequisites,
  isSatisfied,
  planPrerequisites,
  type PrerequisiteReport,
  type Prerequisites,
} from './prerequisites.js';
import { resolveLifecycle } from './lifecycle.js';
import {
  advanceCursor,
  getCursorForPull,
  isConsented,
  loadLinkStore,
  recordConsent,
  saveLinkStore,
} from './links.js';
import type { LocalComment } from './comments.js';
import { describeTarget } from './config-file.js';
import {
  consentGate,
  type ConsentReason,
  type ConsentRefusal,
  type ConsentRequest,
} from './guard.js';
import {
  planPull,
  planPush,
  type BlockEdges,
  type PullOptions,
  type PullPlan,
  type PushPlan,
  type RemoteSnapshot,
} from './plan.js';
import {
  attributeDefsOf,
  hasErrorProblems,
  periodIndexOf,
  preflightPush,
  vocabularyProblems,
  rosterOf,
} from './preflight.js';
import type { Connector, Provider, RemoteRecord } from './provider.js';
import type { OpenedRemote } from './remotes.js';
import { buildConnector, pulls, pushes } from './remotes.js';
import type { PlanRender } from './render.js';
import { renderPlan } from './render.js';
import { redactor } from './redact.js';
import type { PullResult } from './pull.js';
import { applyPull } from './pull.js';
import {
  githubBlockEdgesOf,
  githubParentIdOf,
  githubProvider,
  githubRemoteIdOf,
} from './providers/github/index.js';
import {
  linearDependsOnOf,
  linearParentIdOf,
  linearProvider,
  linearRelatesToOf,
  linearRemoteIdOf,
} from './providers/linear/index.js';
import {
  jiraDependsOnOf,
  jiraParentIdOf,
  jiraProvider,
  jiraRelatesToOf,
  jiraRemoteIdOf,
} from './providers/jira/index.js';
import {
  jsonfileDependsOnOf,
  jsonfileParentIdOf,
  jsonfileProvider,
  jsonfileRemoteIdOf,
} from './providers/jsonfile/index.js';

// ---------------------------------------------------------------------------
// Options and result
// ---------------------------------------------------------------------------

/** What one sync run does. `direction: both` runs pull first, then push. */
export interface RunSyncOptions {
  direction: 'push' | 'pull' | 'both';
  /** Plan and render, but write nothing to either side. */
  dryRun?: boolean;
  /**
   * Sync only this subtree (`--filter`). It narrows the *pull* as a scope — a
   * smaller scope can only ever reconcile fewer twins — and the *push* as a
   * selection, because there narrowing the scope would tell the planner that
   * every twin outside the subtree had left the mirror.
   */
  scope?: string;
  /**
   * Push only these documents (`lpm remote push LP-12`), leaving every other
   * document untouched. A *selection*, not a scope: nothing outside it is
   * treated as gone — see `only` on `RemoteSnapshot`. `scope` above narrows
   * the push the same way, by the subtree it names, for the same reason.
   */
  only?: readonly string[];
  /**
   * Pull only these remote issues, by remote id or by the human key a provider
   * can resolve (`lpm remote pull PAY-31`). The listing is then partial by
   * construction, so the run reconciles no existence: nothing is closed,
   * deleted or unlinked for being absent, and the pull cursor does not move.
   */
  pullIds?: readonly string[];
  /**
   * Where a pulled issue with no mirrored parent lands on the board
   * (`lpm remote pull PAY-31 --parent LP-3`). A board's hierarchy has rules
   * about what may sit at which level and a tracker's issues are a flat list,
   * so importing one on its own needs somewhere to put it.
   */
  under?: string;
  /**
   * Period documents to file on the remote — the board's own timeline, pushed
   * like any other part of the plan (`lpm remote push TL-3`), or `'all'` for
   * every period at the mapped level (`--all`).
   *
   * Absent means **none**: pushing work never files the timeline behind it. An
   * issue whose sprint is not on the remote is filed unscheduled and repaired
   * by the push that files the sprint.
   */
  periods?: 'all' | readonly string[];
  /** At most this many remote write ops on the push side (`--limit`). */
  limit?: number;
  /**
   * Ask the remote only for what changed since the last pull (`--changed`),
   * instead of listing everything it holds.
   *
   * The default is the complete listing, and that is the one that means
   * something: it refreshes every twin the ledger holds and is the only
   * listing a deletion can be detected from. An incremental one is an
   * optimisation for a large remote, and it is partial by construction — a
   * twin nobody touched is simply not in it, which is never evidence that it
   * is gone.
   */
  changed?: boolean;
  /** Re-probe capabilities even when the cache is fresh (`--refresh`). */
  refresh?: boolean;
  /** Force a hierarchy encoding (`--hierarchy`). */
  forceHierarchy?: HierarchyEncoding;
  /** Progress callback for the push executor. */
  onProgress?: (progress: OpProgress) => void;
  /** Abort signal, checked before each push op and threaded into writes. */
  signal?: AbortSignal;
  /** Clock for link-store timestamps. Injectable for tests. */
  now?: () => Date;
  /**
   * The caller has already confirmed this run (`--yes`, LP-350): the consent
   * gate is satisfied and, on a first write, consent is recorded.
   */
  yes?: boolean;
  /**
   * Ask a human to confirm a gate that prompts: the `first_write` gate and the
   * `delete` gate (LP-351). An oversized plan (`threshold`) never prompts — it
   * stops and requires `yes`. A caller that cannot prompt (CI, an agent, a
   * browser) omits this and the gate refuses instead, surfacing
   * `consentRefused` on the result.
   */
  confirm?: (request: ConsentRequest) => Promise<boolean> | boolean;
}

/** What one sync run produced — the plans, the renders or the applied results. */
export interface RunSyncResult {
  remoteName: string;
  direction: 'push' | 'pull' | 'both';
  dryRun: boolean;
  /** Push-side preflight problems (absent when not pushing). */
  preflight: Problem[];
  /** True when the push was refused because the preflight found error problems. */
  preflightBlocked: boolean;
  /** Why the pull was skipped — the remote could not be reached (LP-364). */
  unreachable?: string;
  /** The push plan, when pushing and not preflight-blocked. */
  pushPlan?: PushPlan;
  /** The pull plan, when pulling and reachable. */
  pullPlan?: PullPlan;
  /** Push execution, on a real (non-dry) push run. */
  pushResult?: PushExecutionResult;
  /** Pull execution, on a real (non-dry) pull run. */
  pullResult?: PullResult;
  /** The rendered plans, one per direction step, on a dry run. */
  renders?: PlanRender[];
  /** The push was refused by the consent gate (LP-350) — nothing was written. */
  consentRefused?: ConsentRefusal;
  /**
   * What the push created before it could file anything — labels the remote
   * did not define, sprints it did not have, Project fields a status needed.
   * Absent when there was nothing to create, which is every run after the
   * first onto a given project.
   */
  prerequisites?: PrerequisiteReport;
  /** The same list on a dry run, as what *would* be created. */
  pendingPrerequisites?: Prerequisites;
  /**
   * Something the remote refused to create, reported rather than thrown: the
   * push went ahead without it. Whatever actually needed it fails as its own
   * operation, which is where a reader can see what it cost.
   */
  prerequisiteFailure?: { message: string; details: readonly string[] };
  /**
   * What the push looked at, for a report that can say "and the rest were
   * unchanged". A push is change-driven — a document whose fields still match
   * the base snapshot produces no operation at all — and that is invisible in
   * a summary of what was written, which is how somebody comes to believe a
   * bare push re-files the whole board.
   */
  pushConsidered?: { mirrored: number; changed: number; created: number };
}

// ---------------------------------------------------------------------------
// Provider pull seams
// ---------------------------------------------------------------------------

/** The provider-specific read seams the pull planner and lifecycle need. */
export interface PullSeams {
  /** The remote id a listed record is keyed by — the same id a create returns. */
  remoteIdOf: (record: RemoteRecord) => string;
  parentIdOf?: (record: RemoteRecord) => string | undefined;
  dependsOnOf?: (record: RemoteRecord) => string[];
  relatesToOf?: (record: RemoteRecord) => string[];
  blockEdgesOf?: (record: RemoteRecord) => BlockEdges;
}

/**
 * The pull seams for a provider, matched by identity exactly as the registry
 * matches name → implementation. A provider without a seam simply omits it —
 * the pull files at the root rather than guessing a hierarchy the seam would
 * have to invent.
 *
 * Exported because the drift report reads a listing too, and it must read it
 * through the same seams: `remoteIdOf` keys the listing and `parentIdOf` is
 * what turns a brand-new remote issue into "it would land under LP-12". A
 * private second table here is the failure this one is already known for — the
 * fallback below silently reads a field a new provider may not have, and
 * `jsonfile` took it for months.
 */
/**
 * Fetch one remote issue by whatever the person had to hand: the remote's own
 * id, or the key their tracker shows them (`PAY-31`, `acme/payments#418`).
 *
 * `get` takes the id; `resolve` — where a provider has one — turns a key into
 * the same record. Trying `get` first keeps the common path one request, and a
 * provider that cannot resolve keys simply answers `null`, which the caller
 * reports as "no such issue" rather than as a transport failure.
 */
async function fetchOne(connector: Connector, wanted: string): Promise<RemoteRecord | null> {
  const direct = await connector.get(wanted);
  if (direct !== null) return direct;
  if (typeof connector.resolve === 'function') {
    const resolved = await connector.resolve(wanted);
    if (resolved?.record !== undefined) return resolved.record;
  }
  return null;
}

export function pullSeamsFor(provider: Provider): PullSeams {
  if (provider === githubProvider) {
    return {
      remoteIdOf: githubRemoteIdOf,
      parentIdOf: githubParentIdOf,
      blockEdgesOf: githubBlockEdgesOf,
    };
  }
  if (provider === linearProvider) {
    return {
      remoteIdOf: linearRemoteIdOf,
      parentIdOf: linearParentIdOf,
      dependsOnOf: linearDependsOnOf,
      relatesToOf: linearRelatesToOf,
    };
  }
  if (provider === jsonfileProvider) {
    return {
      remoteIdOf: jsonfileRemoteIdOf,
      parentIdOf: jsonfileParentIdOf,
      dependsOnOf: jsonfileDependsOnOf,
    };
  }
  if (provider === jiraProvider) {
    return {
      remoteIdOf: jiraRemoteIdOf,
      parentIdOf: jiraParentIdOf,
      dependsOnOf: jiraDependsOnOf,
      relatesToOf: jiraRelatesToOf,
    };
  }
  // The registry refuses an unknown provider before this runs; this fallback is
  // for a hand-built `OpenedRemote` in a test, and reads only what the
  // translator can recover — no hierarchy, no edges.
  return {
    remoteIdOf: (record) => {
      const id = record['id'];
      if (typeof id === 'string' && id !== '') return id;
      if (typeof id === 'number') return String(id);
      return '';
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The board as the planners read it: a `BoardView` DTO. */
function viewOf(board: LoadedBoard): BoardView {
  const snapshot = toSnapshot(board);
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources, ...snapshot.templates].map(
      (node) => [node.id, node],
    ),
  );
  return { config: snapshot.config, nodes };
}

/**
 * The pull translation seams bound to one board, exactly as the conformance
 * harness binds them: `toPatch` recovers board fields through the provider's
 * own translator, and the native-hierarchy / edge seams are passed through
 * unbound.
 */
function pullOptionsFor(
  remote: OpenedRemote,
  board: LoadedBoard,
  seams: PullSeams,
  underParent?: string,
): PullOptions {
  const attributes = attributeDefsOf(board);
  const roster = rosterOf(board);
  const periods = periodIndexOf(board);
  return {
    toPatch: (record) =>
      remote.provider.translator
        .fieldsFromRecord(record, remote.mapping, attributes, roster, periods).patch,
    ...(seams.parentIdOf !== undefined ? { parentIdOf: seams.parentIdOf } : {}),
    ...(seams.dependsOnOf !== undefined ? { dependsOnOf: seams.dependsOnOf } : {}),
    ...(seams.relatesToOf !== undefined ? { relatesToOf: seams.relatesToOf } : {}),
    ...(seams.blockEdgesOf !== undefined ? { blockEdgesOf: seams.blockEdgesOf } : {}),
    ...(underParent !== undefined ? { underParent } : {}),
  };
}

/**
 * The names of the period documents a run asked to file. A sprint is matched
 * on the remote by *name* — that is the correspondence the mapping already
 * uses — so the id a person types becomes the name the connector looks for.
 */
function periodNamesOf(board: LoadedBoard, ids: readonly string[]): string[] {
  const byId = new Map(board.periods.map((period) => [period.id, period.title]));
  return ids.flatMap((id) => {
    const title = byId.get(id);
    return title === undefined ? [] : [title];
  });
}

/** Local comments per document id, read for the push side of comment sync. */
function localCommentsOf(board: LoadedBoard): Map<string, readonly LocalComment[]> {
  const map = new Map<string, readonly LocalComment[]>();
  for (const issue of board.issues) {
    const comments = readComments(issue.dir);
    if (comments.length > 0) map.set(issue.id, comments);
  }
  return map;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Run one remote sync in one direction, and record it in the audit log.
 *
 * The audit (LP-352) is written by the wrapper, not the body, so it covers
 * every caller — the CLI, the MCP `remote_sync` tool and the web route all
 * land here — and a run that throws still appends a failure line before the
 * error propagates. A dry run records nothing: it wrote nothing, and the log
 * is a record of what a sync *did*.
 */
export async function runSync(
  board: LoadedBoard,
  remote: OpenedRemote,
  paths: BoardPaths,
  options: RunSyncOptions,
): Promise<RunSyncResult> {
  if (options.dryRun === true) return runSyncInner(board, remote, paths, options);
  try {
    const result = await runSyncInner(board, remote, paths, options);
    recordSyncAudit(board, result, redactor.secrets());
    return result;
  } catch (error) {
    recordSyncFailure(board, remote.name, options.direction, error, redactor.secrets());
    throw error;
  }
}

/**
 * The body of one sync run, without the audit.
 *
 * For a `both` run the pull lands first, the board is reloaded, and the push is
 * planned against the post-pull board — the order that makes remote edits merge
 * before local ones are written over them.  A dry run renders each plan instead
 * of applying it; the push plan in a `both` dry run is computed against the
 * board as it stands (the pull is not simulated).
 */
async function runSyncInner(
  board: LoadedBoard,
  remote: OpenedRemote,
  paths: BoardPaths,
  options: RunSyncOptions,
): Promise<RunSyncResult> {
  const direction = options.direction;
  const dryRun = options.dryRun === true;
  // `scope` narrows what the *pull* reconciles, where a smaller scope can only
  // ever consider fewer twins. The push side takes the declared scope and a
  // separate `only` — see the push snapshot below.
  const effectiveRemote: OpenedRemote =
    options.scope !== undefined ? { ...remote, scope: options.scope } : remote;

  const connector = buildConnector(remote, paths);
  const store = loadLinkStore(paths, remote.name);
  const view = viewOf(board);
  const now = options.now ?? (() => new Date());

  // -- capabilities + hierarchy ---------------------------------------------
  const resolved = await resolveCapabilities(
    remote.provider.capabilities,
    connector,
    loadCapabilityCache(paths, remote.name),
    { refresh: options.refresh === true },
  );
  saveCapabilityCache(paths, remote.name, resolved.cache);
  const capabilities = resolved.capabilities;
  const mappedHierarchy = effectiveRemote.mapping['hierarchy'];
  const forcedHierarchy: HierarchyEncoding | undefined =
    options.forceHierarchy ??
    (mappedHierarchy === 'labels' || mappedHierarchy === 'sub-issues' ? mappedHierarchy : undefined);
  const hierarchy = resolveHierarchyEncoding(
    capabilities,
    board.config.hierarchy,
    // `--hierarchy` wins; otherwise the remote's own `mapping.hierarchy`, which
    // is where a pairing that always needs one (a team-managed Jira project,
    // whose types cannot nest the way a board's depths do) records it once
    // instead of every push.
    forcedHierarchy !== undefined ? { force: forcedHierarchy } : {},
  );

  // -- push preflight gate (LP-273) -----------------------------------------
  const preflight = pushes(direction) ? preflightPush(board, effectiveRemote) : [];
  let preflightBlocked = hasErrorProblems(preflight);

  // -- pull -----------------------------------------------------------------
  let pullPlan: PullPlan | undefined;
  let pullResult: PullResult | undefined;
  let unreachable: string | undefined;

  if (pulls(direction)) {
    const seams = pullSeamsFor(remote.provider);

    // Targeted or whole: `pullIds` fetches the named issues one by one, and a
    // listing that never happened cannot say anything about what is absent.
    const targeted = options.pullIds !== undefined && options.pullIds.length > 0;
    const cursor = getCursorForPull(store, { fullSync: options.changed !== true });
    // An incremental listing is partial in exactly the same sense: it holds
    // what changed since the cursor, and says nothing whatever about an issue
    // nobody has touched. Before this was recognised, an ordinary second pull
    // read every unchanged twin as absent — which either tripped the bulk
    // guard (a confusing "declined to treat them as deletions" on a healthy
    // board) or, under the threshold, quietly applied the on_delete policy to
    // work that was never deleted. Existence is reconciled against a **full**
    // listing only, which is the default; `--changed` asks for this cheaper
    // one and accepts that it cannot detect a deletion.
    const incremental = cursor !== null;
    const page = targeted ? null : await connector.list({ cursor });
    const issues = new Map<string, RemoteRecord>();
    if (page !== null) {
      for (const record of page.records) {
        const id = seams.remoteIdOf(record);
        if (id !== '') issues.set(id, record);
      }
    } else {
      for (const wanted of options.pullIds ?? []) {
        const record = await fetchOne(connector, wanted);
        if (record === null) {
          throw new BoardError(`Remote "${remote.name}" has no issue "${wanted}"`, [
            'Give the remote id or the key the tracker shows, e.g. PAY-31 or acme/payments#418.',
          ]);
        }
        const id = seams.remoteIdOf(record);
        issues.set(id !== '' ? id : wanted, record);
      }
    }

    const reachability =
      typeof connector.reachable === 'function' ? await connector.reachable() : undefined;
    const snapshot: RemoteSnapshot = {
      direction,
      ...(effectiveRemote.scope !== undefined ? { scope: effectiveRemote.scope } : {}),
      issues,
      ...(targeted || incremental ? { partial: true } : {}),
      onDelete: effectiveRemote.on_delete,
      hierarchy,
      edges: capabilities.edges,
      ...(effectiveRemote.comments === 'both' ? { commentsMode: 'both' as const } : {}),
      ...(remote.provider.translator.normalizeBody !== undefined
        ? { normalizeBody: remote.provider.translator.normalizeBody }
        : {}),
    };

    const lifecycle = resolveLifecycle(view, store, snapshot, {
      ...(reachability !== undefined ? { reachability } : {}),
      ...(seams.parentIdOf !== undefined ? { parentIdOf: seams.parentIdOf } : {}),
      // The bulk guard asks "did this listing come back suspiciously empty?" —
      // a question only a listing that claimed to be complete can answer.
      ...(effectiveRemote.bulk_guard !== undefined && !targeted && !incremental
        ? { bulkGuard: effectiveRemote.bulk_guard }
        : {}),
    });
    if (lifecycle.runUnreachable) {
      unreachable = lifecycle.runUnreachableReason ?? 'the remote could not be reached';
    }

    pullPlan = planPull(
      view,
      store,
      { ...snapshot, ...(unreachable !== undefined ? { unreachable: true } : {}) },
      pullOptionsFor(effectiveRemote, board, seams, options.under),
    );

    if (!dryRun && unreachable === undefined) {
      pullResult = applyPull(paths, remote.name, store, pullPlan);
      // The cursor advances only on a clean pull: a partial one re-scans from
      // the old cursor on the next run, which is the retry mechanism. A
      // targeted pull never moves it — it listed nothing.
      if (pullResult.failures.length === 0 && page !== null && page.cursor !== null) {
        advanceCursor(store, page.cursor);
        saveLinkStore(paths, remote.name, store);
      }
    }
  }

  // -- push ----------------------------------------------------------------
  let pushPlan: PushPlan | undefined;
  let pushResult: PushExecutionResult | undefined;
  let consentRefused: ConsentRefusal | undefined;
  let prerequisites: PrerequisiteReport | undefined;
  let pushConsidered: RunSyncResult['pushConsidered'];
  let pendingPrerequisites: Prerequisites | undefined;
  let prerequisiteFailure: string | undefined;
  let prerequisiteDetails: readonly string[] = [];

  if (pushes(direction) && !preflightBlocked) {
    // A real `both` run pulls first, which rewrites the board on disk — plan
    // the push against a fresh handle, exactly as `src/sync` reloads between
    // steps. A dry run has nothing to reload; it plans against the board given.
    const pushBoard = direction === 'both' && !dryRun ? loadBoard(paths) : board;
    const pushView = pushBoard === board ? view : viewOf(pushBoard);

    const pushSelection =
      options.only !== undefined
        ? new Set(options.only)
        : options.scope !== undefined
          ? new Set(subtreeIds(pushView, options.scope))
          : undefined;

    // One document, one remote (`ledger.ts`): a document another remote already
    // mirrors is never given a second twin here.
    const claimed = idsOwnedElsewhere(buildLedger(paths, board.config), remote.name);

    const snapshot: RemoteSnapshot = {
      direction,
      // The remote's *declared* scope, never the run's `--filter`. Scope is
      // what this remote owns, and the push planner answers the `on_delete`
      // policy for every linked document outside it — so narrowing it for one
      // run would decouple the rest of the board. What this run is about
      // travels as `only`, which no gone pass consults.
      ...(remote.scope !== undefined ? { scope: remote.scope } : {}),
      // What this run is about. `--filter`/`scope` names a subtree root; it
      // reaches the push planner as the ids inside it, never as a scope.
      ...(pushSelection !== undefined ? { only: pushSelection } : {}),
      ...(claimed.size > 0
        ? {
            ownedElsewhere: new Map(
              [...claimed].map(([localId, entry]) => [
                localId,
                `${entry.remoteKey || entry.remoteId} on ${entry.remote}`,
              ]),
            ),
          }
        : {}),
      issues: new Map(), // the push planner never reads the listing
      onDelete: effectiveRemote.on_delete,
      hierarchy,
      edges: capabilities.edges,
      ...(remote.provider.translator.normalizeBody !== undefined
        ? { normalizeBody: remote.provider.translator.normalizeBody }
        : {}),
    };

    pushPlan = planPush(pushView, store, snapshot, localCommentsOf(pushBoard));

    // The mapped names, against the project's real vocabulary — the check that
    // turns "400: Specify a valid issue type", discovered halfway through a
    // push, into a refusal before anything is written. Only when the plan
    // **creates** something: a type name is written on a create, the two
    // requests are not free, and a steady-state push of updates should not pay
    // for them. A connector that cannot report its vocabulary is not asked.
    if (
      !dryRun &&
      typeof connector.vocabulary === 'function' &&
      pushPlan.ops.some((op) => op.kind === 'create')
    ) {
      const live = await connector.vocabulary();
      const problems = vocabularyProblems(
        effectiveRemote,
        live,
        displayPath(paths, paths.configPath),
      );
      if (problems.length > 0) {
        preflight.push(...problems);
        preflightBlocked = true;
      }
    }

    const touched = new Set(
      pushPlan.ops.flatMap((op) => ('localId' in op ? [op.localId] : [])),
    );
    const created = new Set(
      pushPlan.ops.flatMap((op) => (op.kind === 'create' ? [op.localId] : [])),
    );
    pushConsidered = {
      mirrored: store.links.size,
      changed: [...touched].filter((id) => !created.has(id)).length,
      created: created.size,
    };

    if (!dryRun) {
      // The write-confirmation gate (LP-350): a first write asks a person to
      // confirm the target and counts once; an oversized plan (more creates +
      // closes than the threshold) stops and requires `--yes`. A caller with no
      // `confirm` and no `yes` is refused rather than prompted — an agent, CI
      // or a browser must never hang on a question nobody will answer.
      const gate = consentGate({
        remote: effectiveRemote,
        consented: isConsented(store),
        plan: pushPlan,
      });
      const target = describeTarget(
        remoteNamed(board.config, remote.name)?.provider ?? remote.name,
        effectiveRemote.connection,
      );
      let refused: ConsentRefusal | undefined;

      if (gate.requiresConsent) {
        // `requiresConsent` implies `reason` is set; the fallback only narrows
        // the optional field for the type checker.
        const reason: ConsentReason = gate.reason ?? 'first_write';
        if (options.yes === true) {
          // Explicit confirmation satisfies every gate.  Only the one-time
          // first-write consent is remembered; a delete gate is deliberately
          // never remembered (LP-351), and a threshold gate is a one-off too.
          if (reason === 'first_write') {
            recordConsent(store, now().toISOString());
            saveLinkStore(paths, remote.name, store);
          }
        } else if (reason === 'threshold') {
          refused = {
            reason: 'threshold',
            target,
            counts: gate.counts,
            threshold: gate.threshold,
          };
        } else if (options.confirm !== undefined) {
          // `first_write` and `delete` both prompt; `threshold` never does.
          const request: ConsentRequest = {
            remoteName: remote.name,
            target,
            reason,
            counts: gate.counts,
            threshold: gate.threshold,
          };
          const proceed = await options.confirm(request);
          if (proceed) {
            if (reason === 'first_write') {
              recordConsent(store, now().toISOString());
              saveLinkStore(paths, remote.name, store);
            }
          } else {
            refused = { reason, target, counts: gate.counts, threshold: gate.threshold };
          }
        } else {
          refused = { reason, target, counts: gate.counts, threshold: gate.threshold };
        }
      }

      if (refused === undefined) {
        // Everything the remote has to own before the plan can land — labels
        // it must define, sprints it must have, Project fields a status needs
        // (`prerequisites.ts`). Created here rather than by a command of its
        // own: none of it is a decision, it is all implied by the mapping, and
        // a push that failed and printed the name of a second command was a
        // tool making somebody learn a word for a step it could take.
        // Asked-for periods are filed even when there is no issue work: `lpm
        // remote push TL-3` is a complete request on its own.
        if (pushPlan.ops.length > 0 || options.periods !== undefined) {
          const missing = await planPrerequisites(pushBoard, effectiveRemote, connector, paths, {
            ...(options.periods !== undefined
              ? {
                  periods:
                    options.periods === 'all' ? ('all' as const) : new Set(periodNamesOf(pushBoard, options.periods)),
                }
              : {}),
          });
          if (!isSatisfied(missing)) {
            prerequisites = await createPrerequisites(effectiveRemote, connector, paths, missing);
          }
        }

        pushResult = await executePush(pushBoard, effectiveRemote, connector, store, pushPlan.ops, {
          onProgress: options.onProgress,
          limit: options.limit,
          signal: options.signal,
          now: options.now,
          hierarchy,
        });
      } else {
        consentRefused = refused;
      }
    }
  }

  // -- renders -------------------------------------------------------------
  // A dry run renders each plan instead of applying it.  The push plan is
  // always computed against `board` in a dry run (the post-pull reload only
  // exists on a real `both` run), so `view` is the correct render context.
  if (dryRun && pushPlan !== undefined && (pushPlan.ops.length > 0 || options.periods !== undefined)) {
    // A dry run asks the same question and writes nothing: "what would this
    // push have to create first?"
    const missing = await planPrerequisites(board, effectiveRemote, connector, paths, {
      ...(options.periods !== undefined
        ? {
            periods:
              options.periods === 'all' ? ('all' as const) : new Set(periodNamesOf(board, options.periods)),
          }
        : {}),
    });
    if (!isSatisfied(missing)) pendingPrerequisites = missing;
  }

  const renders: PlanRender[] = [];
  if (dryRun) {
    if (pullPlan !== undefined && unreachable === undefined) {
      renders.push(renderPlan({ direction: 'pull', plan: pullPlan }, { board: view, links: store }));
    }
    if (pushPlan !== undefined) {
      renders.push(
        renderPlan(
          { direction: 'push', ops: pushPlan.ops, skipped: pushPlan.skipped },
          { board: view, links: store },
        ),
      );
    }
  }

  return {
    remoteName: remote.name,
    direction,
    dryRun,
    preflight,
    preflightBlocked,
    ...(unreachable !== undefined ? { unreachable } : {}),
    ...(pullPlan !== undefined ? { pullPlan } : {}),
    ...(pushPlan !== undefined ? { pushPlan } : {}),
    ...(pullResult !== undefined ? { pullResult } : {}),
    ...(pushResult !== undefined ? { pushResult } : {}),
    ...(consentRefused !== undefined ? { consentRefused } : {}),
    ...(prerequisites !== undefined ? { prerequisites } : {}),
    ...(pushConsidered !== undefined ? { pushConsidered } : {}),
    ...(pendingPrerequisites !== undefined ? { pendingPrerequisites } : {}),
    ...(prerequisiteFailure !== undefined
      ? { prerequisiteFailure: { message: prerequisiteFailure, details: prerequisiteDetails } }
      : {}),
    ...(renders.length > 0 ? { renders } : {}),
  };
}
