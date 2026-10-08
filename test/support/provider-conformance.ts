/**
 * The provider conformance harness (LP-300).
 *
 * One suite, run against every provider. A provider entry declares how it is
 * wired onto the in-memory tracker (`test/support/memory-tracker.ts`, LP-299)
 * and, when it genuinely cannot do something, what the *degraded* behaviour is
 * — the suite asserts the degradation rather than skipping the scenario, so a
 * provider may be less capable but is never less tested.
 *
 * The harness drives the real provider end to end: the provider's own
 * `connector` (with the global `fetch` pointed at the tracker) plus the
 * provider's own `translator`, through `planPush` / `executePush` (LP-280,
 * LP-490) and `planPull` / `applyPull` (LP-281). Nothing is faked except the
 * transport, which is the whole point: a provider is tested offline with no
 * tokens and no network.
 */

import { vi } from 'vitest';
import { createIssue, loadBoard } from '../../src/core/index.js';
import type { LoadedBoard } from '../../src/core/board/load.js';
import type { BoardPaths } from '../../src/core/storage/paths.js';
import type { ResolvedCapabilities } from '../../src/remote/capabilities.js';
import { resolveCapabilities } from '../../src/remote/capabilities.js';
import { resolveHierarchyEncoding, recordOf } from '../../src/remote/hierarchy.js';
import type { HierarchyEncoding, ResolvedHierarchy } from '../../src/remote/hierarchy.js';
import type { LinkStore } from '../../src/remote/links.js';
import type { BlockEdges, PullOptions, RemoteSnapshot } from '../../src/remote/plan.js';
import { attributeDefsOf, periodIndexOf, rosterOf } from '../../src/remote/preflight.js';
import type { Connector, Provider, RemoteRecord } from '../../src/remote/provider.js';
import type { OpenedRemote } from '../../src/remote/remotes.js';
import type { BoardView } from '../../src/shared/index.js';
import { toSnapshot } from '../../src/sync/index.js';
import { makeBoard } from '../helpers.js';
import type { MemoryCapabilities, MemoryConnector, SeedIssue } from './memory-tracker.js';
import { memoryConnector } from './memory-tracker.js';

// ---------------------------------------------------------------------------
// The table entry
// ---------------------------------------------------------------------------

/**
 * The provider-agnostic ways a scenario simulates a human changing the remote
 * and inspects the tracker's stored state. Each provider supplies its own
 * spelling of these on its entry; the scenario bodies call the seam and never
 * touch the tracker's REST/GraphQL surface directly. This is the seam that
 * keeps the scenario bodies free of GitHub's `open`/`closed`, label-based
 * status and REST paths.
 */
export interface ConformanceRemote {
  /** True when the tracker considers the twin closed/terminal. */
  isClosed(tracker: MemoryConnector, remoteId: string): boolean;
  /** The remote's current status carrier value — the status label (GitHub) or the workflow state name (Linear). */
  statusValueOf(tracker: MemoryConnector, remoteId: string): string | undefined;
  /**
   * The remote's current *type* carrier value — a label where the provider has
   * no native issue type (GitHub, Linear), the native `type` field where it
   * does (jsonfile). One mapping key covers both, so the scenario asks the
   * seam rather than assuming a label.
   */
  typeValueOf(tracker: MemoryConnector, remoteId: string): string | undefined;
  /** Simulate a human moving the twin to a non-terminal board status. */
  reopen(tracker: MemoryConnector, remoteId: string, boardStatus: string): void;
  /** Simulate a human hard-deleting the twin. */
  deleteRemote(tracker: MemoryConnector, remoteId: string): void;
  /** Simulate a human adding triage labels, keeping the sync's own labels. */
  triage(tracker: MemoryConnector, remoteId: string, labels: string[]): void;
  /** The seed for the two-issue pull edge scenario (edge each way). */
  seedEdgeIssues(holdsEdges: boolean): SeedIssue[];
}

/**
 * One provider under test. Adding a provider to the suite is exactly one of
 * these — nothing in the scenario bodies names a provider.
 */
export interface ConformanceEntry {
  /** Provider name, used in test names and as the link-store name. */
  name: string;
  /** The provider adapter under test. */
  provider: Provider;
  /** A validated connection block (no secrets — the tracker answers everything). */
  connection: Record<string, unknown>;
  /** A validated mapping block covering the board types/statuses the suite uses. */
  mapping: Record<string, unknown>;
  /**
   * The pull translation seams, bound to a board (its attribute defs, roster
   * and timeline). `toPatch` recovers board fields from a raw remote record;
   * `parentIdOf` / `dependsOnOf` are omitted for a provider that holds no
   * native hierarchy / edges — which is itself the declaration of absence the
   * degraded scenarios assert against.
   */
  pull: (board: LoadedBoard) => PullOptions;
  /** Capability-probe answers the tracker returns to this provider. */
  trackerCapabilities?: MemoryCapabilities;
  /**
   * A provider whose connector is not `fetch`-backed (the jsonfile provider's
   * `node:fs`) supplies this instead of the in-memory HTTP tracker: build the
   * tracker double from the board paths, and return it together with the
   * connection block that points the provider's connector at the same backing
   * store. The harness skips the `memoryConnector` and the `fetch` stub for
   * such an entry. `opts` carries a shared tracker (a two-board scenario) and
   * the seed to preload.
   */
  trackerAndConnection?: (paths: BoardPaths, opts: { tracker?: MemoryConnector; seed?: SeedIssue[] }) => {
    tracker: MemoryConnector;
    connection: Record<string, unknown>;
  };
  /**
   * The provider-agnostic remote seam the scenario bodies drive. Required on
   * the conformance table's entries; optional on the type only because the
   * GitHub-specific edge/hierarchy tests reuse `ConformanceEntry` without it.
   */
  remote?: ConformanceRemote;
  /**
   * How the tracker's stored issues become the provider's wire records, for
   * the pull snapshot. Defaults to the tracker's GitHub-flavoured `records()`;
   * a provider whose wire shape differs (Linear) supplies its own.
   */
  recordsOf?(tracker: MemoryConnector): RemoteRecord[];
  /**
   * The remote id a record is keyed by in the pull snapshot. Defaults to
   * `String(record.number)` — GitHub's numeric id; Linear keys by `id`.
   */
  remoteIdOf?(record: RemoteRecord): string;
  /**
   * Scenarios this provider legitimately cannot do, keyed by scenario, each
   * value a human-readable reason (surfaced when an assertion fails). The
   * suite asserts the degraded behaviour for each name present, and the full
   * behaviour otherwise. A provider may be less capable; it may not be less
   * *tested*.
   */
  degraded?: {
    /** No native dependency edges — link/unlink degrade to a skip. */
    edges?: string;
    /** No native comments — posting a comment is impossible. */
    comments?: string;
    /** `delete` cannot hard-delete — it degrades to closing the issue. */
    hardDelete?: string;
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The throwaway board the suite syncs. */
export interface ConformanceHarness {
  entry: ConformanceEntry;
  paths: BoardPaths;
  /** The in-memory tracker standing in for the provider's platform. */
  tracker: MemoryConnector;
  /** The provider's own connector, its `fetch` pointed at the tracker. */
  connector: Connector;
  /** A hand-built opened remote (no config file on disk). */
  opened: OpenedRemote;
  /** The correspondence store, fresh for each scenario. */
  store: LinkStore;
  /** The provider's capability table with every probe answered by the tracker. */
  capabilities: ResolvedCapabilities;
  /** The resolved hierarchy encoding, from the capability table (LP-309). */
  hierarchy: ResolvedHierarchy;
  /** The pull translation seams, bound to the board. */
  pullOptions: PullOptions;
  /** Reload the board from disk. */
  reload(): LoadedBoard;
  /** The board as the planners read it. */
  view(): BoardView;
  /** The planner's view of the tracker's current contents. */
  snapshot(direction?: RemoteSnapshot['direction'], onDelete?: RemoteSnapshot['onDelete']): RemoteSnapshot;
}

/** The board as the planners read it, built from a snapshot. */
export function viewOf(board: LoadedBoard): BoardView {
  const snapshot = toSnapshot(board);
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources, ...snapshot.templates].map(
      (node) => [node.id, node],
    ),
  );
  return { config: snapshot.config, nodes };
}

/** An empty correspondence store — the state before the first sync. */
export function emptyLinkStore(): LinkStore {
  return { version: 1, cursor: null, links: new Map(), byRemote: new Map(), tombstones: new Map() };
}

/**
 * The standard pull adapter for a provider whose translator is the ordinary
 * `Translator` shape: `toPatch` recovers board fields from a raw record through
 * the provider's own `fieldsFromRecord`, and `parentIdOf` / `dependsOnOf` are
 * omitted — a provider that holds a native hierarchy or edges declares them by
 * supplying those seams itself. The omission is the declaration of absence the
 * degraded scenarios assert against.
 */
export function providerPull(
  provider: Provider,
  mapping: Record<string, unknown>,
  seams: {
    parentIdOf?: (record: RemoteRecord) => string | undefined;
    dependsOnOf?: (record: RemoteRecord) => string[];
    relatesToOf?: (record: RemoteRecord) => string[];
    blockEdgesOf?: (record: RemoteRecord) => BlockEdges;
  } = {},
): (board: LoadedBoard) => PullOptions {
  return (board) => ({
    toPatch: (record) =>
      provider.translator
        .fieldsFromRecord(record, mapping, attributeDefsOf(board), rosterOf(board), periodIndexOf(board))
        .patch,
    ...(seams.parentIdOf ? { parentIdOf: seams.parentIdOf } : {}),
    ...(seams.dependsOnOf ? { dependsOnOf: seams.dependsOnOf } : {}),
    ...(seams.relatesToOf ? { relatesToOf: seams.relatesToOf } : {}),
    ...(seams.blockEdgesOf ? { blockEdgesOf: seams.blockEdgesOf } : {}),
  });
}

/** programme > epic > feature > story, the story optionally waiting on the feature. */
export function plantTree(paths: BoardPaths, opts: { edge?: boolean } = {}) {
  const program = createIssue(loadBoard(paths), { type: 'program', title: 'Programme' });
  const epic = createIssue(loadBoard(paths), { type: 'epic', title: 'Epic', parentId: program.id });
  const feature = createIssue(loadBoard(paths), { type: 'feature', title: 'Feature', parentId: epic.id });
  const story = createIssue(loadBoard(paths), {
    type: 'user_story',
    title: 'Story',
    parentId: feature.id,
    ...(opts.edge ? { dependsOn: [feature.id] } : {}),
  });
  return { program, epic, feature, story };
}

/**
 * Build a harness: a fresh scrum board, an in-memory tracker (or a shared one,
 * for the two-board scenarios), and the provider's real connector wired onto
 * it with `fetch` stubbed.
 */
export async function buildHarness(
  entry: ConformanceEntry,
  opts: {
    tracker?: MemoryConnector;
    seed?: SeedIssue[];
    /** Force a hierarchy encoding, overriding capability detection (LP-493). */
    force?: HierarchyEncoding;
    /** Board template name or config path — `makeBoard`'s first argument. */
    template?: string;
  } = {},
): Promise<ConformanceHarness> {
  const paths = makeBoard(opts.template ?? 'scrum', 'LP');
  let tracker: MemoryConnector;
  let connection: Record<string, unknown> = entry.connection;
  if (entry.trackerAndConnection) {
    const built = entry.trackerAndConnection(paths, { tracker: opts.tracker, seed: opts.seed });
    tracker = built.tracker;
    connection = built.connection;
  } else {
    tracker =
      opts.tracker ??
      memoryConnector({
        repo: 'acme/payments',
        capabilities: entry.trackerCapabilities,
        seed: opts.seed,
      });
  }
  vi.stubGlobal('fetch', tracker.fetch);

  const connector = entry.provider.connector(connection, entry.mapping);
  const opened: OpenedRemote = {
    name: entry.name,
    provider: entry.provider,
    direction: 'both',
    on_delete: 'unlink',
    conflict: 'manual',
    fields: {},
    encoding: 'block',
    comments: 'push',
    connection: entry.connection,
    mapping: entry.mapping,
  };
  const store = emptyLinkStore();
  const board = loadBoard(paths);
  const { capabilities } = await resolveCapabilities(entry.provider.capabilities, connector, {
    version: 1,
    probes: new Map(),
  });
  const hierarchy = resolveHierarchyEncoding(
    capabilities,
    board.config.hierarchy,
    opts.force ? { force: opts.force } : {},
  );
  // The store records the encoding the board was last synced under (LP-493),
  // so a later switch — a capability flip, or a forced `--hierarchy` — is
  // detected against it rather than silently re-encoded.
  store.hierarchy = recordOf(hierarchy);
  const pullOptions = entry.pull(board);

  return {
    entry,
    paths,
    tracker,
    connector,
    opened,
    store,
    capabilities,
    hierarchy,
    pullOptions,
    reload: () => loadBoard(paths),
    view: () => viewOf(loadBoard(paths)),
    snapshot: (direction = 'both', onDelete) => {
      const issues = new Map<string, RemoteRecord>();
      const records = entry.recordsOf ? entry.recordsOf(tracker) : tracker.records();
      for (const record of records) {
        const id = entry.remoteIdOf ? entry.remoteIdOf(record) : String(record.number ?? '');
        issues.set(id, record);
      }
      return { direction, issues, hierarchy, edges: capabilities.edges, ...(onDelete ? { onDelete } : {}) };
    },
  };
}
