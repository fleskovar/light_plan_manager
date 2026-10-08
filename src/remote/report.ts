/**
 * The drift report computed for one remote (LP-342) — the shared half of
 * `lpm remote status`, the web status route and the MCP `remote_status` tool.
 *
 * `planStatus` (status.ts) is the pure classification; this file supplies the
 * inputs it needs: the opened remote, the link store, the pending resolutions,
 * and — when the remote can be read — the fetched patches translated back to
 * board vocabulary.  A connector that cannot be built (no credential) is the
 * no-credential case, not a hard error: the local half is still reported and
 * the remote half says why it is missing, exactly as LP-342's fifth criterion
 * asks.
 *
 * The caller owns the board handle and the remote name (and the "which remote"
 * choice when several are declared); this file owns the fetch and the answer.
 * One definition, three front ends: a CLI run, a browser tab and an agent
 * asking `remote_status` read the same report, because they all land here.
 */

import type { LoadedBoard } from '../core/board/load.js';
import { remoteNamed } from '../core/config/lookup.js';
import { BoardError } from '../core/errors.js';
import type { BoardView } from '../shared/plans/reading.js';
import type { RemoteStatusReport } from '../shared/remote-status.js';
import { toSnapshot } from '../sync/dto.js';
import { describeTarget, lastSyncOf } from './config-file.js';
import { trackedFields } from './conflicts.js';
import { loadLinkStore } from './links.js';
import { normalizeAccountMapping, poolLabel, type Roster } from './accounts.js';
import { attributeDefsOf, boardFieldsOf, periodIndexOf, rosterOf } from './preflight.js';
import type { BoardFieldsPatch, RemoteRecord } from './provider.js';
import { anchorResolver } from './anchor.js';
import { getCursorForPull } from './links.js';
import { buildConnector, openRemote } from './remotes.js';
import { loadResolutions } from './resolutions.js';
import { planStatus, type UnwritableField } from './status.js';
import { pullSeamsFor } from './sync.js';
import { subtreeIds } from '../shared/plans/reading.js';
import type { RemoteStatusIncoming } from '../shared/remote-status.js';

/** The board as the remote layer reads it: a `BoardView` DTO. */
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
 * Why an assignee will not land, **and what to do about it**.
 *
 * The remedy is derived from the roster and the mapping, never by matching the
 * reason string: a free-text reason is the provider's to word, and branching on
 * it would break the first time somebody rephrased one.
 *
 * Three cases, and they want different answers. A **generic pool** is not a
 * person, so no tracker can assign it — the board has to name somebody, or stop
 * mirroring assignees at all. A **person with no account value** is one edit
 * away from working, and naming the attribute is most of the fix. Someone **not
 * on the roster** is a board problem before it is a sync problem.
 */
function assigneeBlock(
  roster: Roster,
  resourceId: string,
  via: string | undefined,
  gap: { resourceTitle: string; reason: string } | undefined,
): UnwritableField {
  const resource = roster.get(resourceId);
  const title = resource?.title ?? gap?.resourceTitle ?? resourceId;

  if (resource === undefined) {
    return {
      reason: `${title} is not on the board's team`,
      remedy: `Add ${resourceId} to the team, or clear the assignee on these documents.`,
    };
  }
  if (resource.generic) {
    return {
      reason: `${title} is a pool, and a pool is not a person this remote can assign`,
      remedy:
        `Assign a named person instead, or drop \`accounts\` from this remote's mapping ` +
        `so assignees are not mirrored at all.`,
    };
  }
  if (via === undefined) {
    return {
      reason: `this remote has no account mapping, so no assignee can be written`,
      remedy: 'Set `mapping.accounts.via` for this remote in `.lpm/config.yml`.',
    };
  }
  return {
    reason: `${title} has no "${via}" value, so there is no account to assign`,
    remedy: `Set "${via}" on ${resourceId}, or clear the assignee on these documents.`,
  };
}

/** A resource's title for a message, falling back to its id. */
function rosterTitleOf(roster: Roster, id: string): string {
  return roster.get(id)?.title ?? id;
}

/**
 * Which fields this remote cannot take, per document: `localId → field → reason`.
 *
 * The same translator walk the push preflight makes (`pushGaps`), kept per
 * document rather than flattened, because the question here is about one
 * document at a time: *is this thing ahead for a reason anybody can act on?*
 *
 * It is what separates 3 pending edits from 430 permanent ones. A board assigned
 * to a generic pool, or to a person with no account on the tracker, is ahead on
 * `assignee` for ever — the push tries, the remote refuses the field, the base
 * records it as unset, and the next push tries again. Right behaviour, useless
 * headline.
 *
 * Pure: `describeRequest` does no I/O, so this rides the local half and costs no
 * request. The `create` op is deliberate — it carries every field, so the gaps
 * are the document's own rather than an artefact of what a particular update
 * happened to include.
 */
function unwritableFieldsOf(
  board: LoadedBoard,
  remote: ReturnType<typeof openRemote>,
): Map<string, Map<string, UnwritableField>> {
  const roster = rosterOf(board);
  const periods = periodIndexOf(board);
  const attributes = attributeDefsOf(board);
  const via = normalizeAccountMapping((remote.mapping as { accounts?: unknown }).accounts)?.via;
  const byDocument = new Map<string, Map<string, UnwritableField>>();

  for (const issue of board.issues) {
    const result = remote.provider.translator.describeRequest(
      { kind: 'create', localId: issue.id, fields: boardFieldsOf(issue) },
      remote.mapping,
      attributes,
      roster,
      periods,
    );
    const fields = new Map<string, UnwritableField>();
    // **The test is whether the request would carry the value at all**, not
    // whether the translator complained. A resource with no account reports a
    // gap; a *generic pool* does not — it is encoded as a `pool:` label instead,
    // which is a real mirror on a provider that writes labels and nothing at all
    // on one that does not. Jira carries no labels, so a pool assignee is dropped
    // in silence, and asking only about gaps found 220 of the 440 documents that
    // were permanently ahead on this board. Comparing the board's value against
    // the request finds both, and needs no list of which provider does what.
    const assignee = issue.assignee;
    if (assignee !== null && assignee !== undefined && assignee !== '') {
      const carriesAccount =
        typeof result.request.assignee === 'string' && result.request.assignee !== '';
      const carriesPool = (result.request.labels ?? []).includes(poolLabel(assignee));
      if (!carriesAccount && !carriesPool) {
        const gap = result.resourceGaps.find((entry) => entry.resourceId === assignee);
        fields.set('assignee', assigneeBlock(roster, assignee, via, gap));
      }
    }
    // Any other resource gap the walk reported — an assignee that is not on the
    // roster at all, say — still names the assignee field.
    for (const gap of result.resourceGaps) {
      if (!fields.has('assignee')) {
        fields.set('assignee', assigneeBlock(roster, gap.resourceId, via, gap));
      }
    }
    // A period the mapping cannot carry.
    for (const gap of result.periodGaps) {
      fields.set('period', {
        reason: `period ${gap.periodId} ${gap.reason}`,
        remedy: `File the period first — \`lpm remote push ${remote.name} ${gap.periodId}\` — or unschedule the work.`,
      });
    }
    // An attribute whose value the remote will not take. Nothing generic to
    // suggest: the value is the board's and only its author knows what it meant.
    for (const problem of result.problems) {
      if (problem.direction === 'push') fields.set(problem.attribute, { reason: problem.reason });
    }
    if (fields.size > 0) byDocument.set(issue.id, fields);
  }
  return byDocument;
}

/** An error message from any thrown value, with a `BoardError`'s hints. */
function describeError(error: unknown): string {
  if (error instanceof BoardError) return [error.message, ...error.details].join(' ');
  return error instanceof Error ? error.message : String(error);
}

/** What a caller can ask of `computeRemoteStatus`. */
export interface RemoteStatusOptions {
  /** Populate the per-field detail — `--verbose`. */
  verbose?: boolean;
  /** Skip the remote half entirely: no connector, no request. */
  local?: boolean;
  /**
   * Ask the remote only for what changed since the stored cursor.
   *
   * Opt-in, and never the default, because absence stops being evidence: an
   * unchanged twin is missing from an incremental listing, so `unreadable` and
   * `incoming` are suppressed. It is the right gear for "did anything move in
   * the last hour?" on a mirror big enough for a full listing to be felt.
   */
  changed?: boolean;
  /**
   * Called once per listing page, so a caller can show that it is moving.
   *
   * A page is the honest unit of progress here: the report cannot know how many
   * there will be until the remote stops handing out cursors, so it reports
   * pages and records so far rather than a percentage it would have to invent.
   */
  onProgress?: (progress: { page: number; records: number }) => void;
}

/**
 * How the remote half of the report is gathered, and why it is one listing.
 *
 * It used to be `connector.get()` once per link entry. That is the most
 * expensive question a mirror can be asked and it returns the least: on this
 * repository's own board it was **537 sequential requests**, about two minutes
 * against Jira, and at the end of it the report still could not mention a story
 * somebody had added upstream — because a loop over the link store can only
 * ever ask about documents the board already knows.
 *
 * One paginated `connector.list()` is both cheaper and strictly more
 * informative: ~11 requests for the same 537 twins, and every remote issue in
 * the project comes back whether or not it has a twin. So the same sweep now
 * answers three things it could not before — which twins moved (`behind`),
 * which have gone (`unreadable`), and which remote issues the board has never
 * seen (`incoming`).
 *
 * Two consequences worth stating rather than discovering:
 *
 *   - A listing is scoped to the project the connection names, so a twin *moved
 *     out* of that project reads as absent where a `get` by id would still have
 *     found it. For a report that is the better answer — it has left the mirror
 *     — and nothing is written on the strength of it. The pull's gone-pass is
 *     where absence has consequences, and it has its own guard.
 *   - An **incremental** listing makes absence meaningless, so `unreadable` and
 *     `incoming` are suppressed for one. Same rule as the pull, same reason.
 */
interface RemoteHalf {
  patches: Map<string, BoardFieldsPatch>;
  unreadable: RemoteStatusReport['unreadable'];
  incoming: RemoteStatusIncoming[];
  /** How many remote issues the listing returned. */
  read: number;
}

async function readRemoteHalf(
  connector: NonNullable<ReturnType<typeof buildConnector>>,
  remote: ReturnType<typeof openRemote>,
  view: BoardView,
  store: ReturnType<typeof loadLinkStore>,
  translate: (record: RemoteRecord) => BoardFieldsPatch,
  options: {
    cursor: string | null;
    incremental: boolean;
    onProgress?: RemoteStatusOptions['onProgress'];
  },
): Promise<RemoteHalf> {
  const seams = pullSeamsFor(remote.provider);
  const patches = new Map<string, BoardFieldsPatch>();
  const unreadable: RemoteStatusReport['unreadable'] = [];
  const incoming: RemoteStatusIncoming[] = [];

  // **One call.** A connector pages internally and returns every record, so
  // `page.cursor` is the cursor for the *next pull*, not a continuation token —
  // looping on it asks the remote for the same listing a second time. Progress
  // through those internal pages comes back through `onPage`, which is the only
  // thing that can see them.
  const page = await connector.list({
    cursor: options.cursor,
    ...(options.onProgress !== undefined ? { onPage: options.onProgress } : {}),
  });
  const issues = new Map<string, RemoteRecord>();
  for (const record of page.records) {
    const remoteId = seams.remoteIdOf(record);
    if (remoteId !== '') issues.set(remoteId, record);
  }

  // -- the twins: a patch each, and absence for the ones not in the listing --
  for (const localId of [...store.links.keys()].sort()) {
    const doc = view.nodes[localId];
    if (!doc || doc.kind !== 'issue') continue; // orphaned — planStatus reports it
    const link = store.links.get(localId)!;
    const record = issues.get(link.remoteId);
    if (record === undefined) {
      // Not in the listing. On a full one that means the twin has left the
      // project; on an incremental one it means nobody touched it, which is no
      // news at all.
      if (!options.incremental) unreadable.push({ localId, remoteId: link.remoteId });
      continue;
    }
    patches.set(localId, translate(record));
  }

  // -- the other direction: remote issues with no twin ----------------------
  if (!options.incremental) {
    // Scope is what the remote owns, and it applies here exactly as it applies
    // to a pull: a remote mirroring one epic has no business reporting the rest
    // of somebody's tracker as incoming work. `anchorResolver` is the pull's own
    // walk, so the report offers precisely what a pull would adopt.
    const anchorOf = anchorResolver(store, issues, seams.parentIdOf);
    const scopeSet = remote.scope !== undefined ? new Set(subtreeIds(view, remote.scope)) : null;
    for (const [remoteId, record] of issues) {
      if (store.byRemote.has(remoteId)) continue; // has a twin — reported above
      const parentLocalId = anchorOf(remoteId);
      if (scopeSet !== null && (parentLocalId === undefined || !scopeSet.has(parentLocalId))) {
        continue;
      }
      const described = connector.describe?.(record);
      incoming.push({
        remoteId,
        remoteKey: described?.remoteKey ?? remoteId,
        remoteUrl: described?.remoteUrl ?? '',
        title: translate(record).title ?? '',
        ...(parentLocalId !== undefined ? { parentLocalId } : {}),
      });
    }
    incoming.sort((a, b) => a.remoteKey.localeCompare(b.remoteKey));
  }

  return { patches, unreadable, incoming, read: issues.size };
}

/**
 * Compute the drift report for one declared remote.
 *
 * Opens the remote (validating its mapping), reads the project in one paginated
 * listing and classifies the whole board through `planStatus`.  Throws a
 * `BoardError` when the remote is not declared; a connector that cannot be
 * built, or a listing that fails, is reported as `remoteMissing` rather than
 * thrown, so the local half always answers.
 *
 * `local: true` skips the remote half deliberately: no connector is built and
 * nothing is fetched, so the report comes back in milliseconds with the twins,
 * the unpushed documents and the locally-edited ones, and `remoteMissing`
 * saying why `behind`, `conflicted` and `incoming` are empty. It is what a
 * screen reads first; the full report is what somebody asks for when they want
 * to know what changed upstream.
 */
export async function computeRemoteStatus(
  board: LoadedBoard,
  name: string,
  options: RemoteStatusOptions = {},
): Promise<RemoteStatusReport> {
  const remote = openRemote(board.config, name);
  const paths = board.paths;
  const store = loadLinkStore(paths, name);
  const resolutions = loadResolutions(paths, name);
  const fields = trackedFields(remote.mapping);

  const view = viewOf(board);
  const attributes = attributeDefsOf(board);
  const roster = rosterOf(board);
  const periods = periodIndexOf(board);

  const provider = remoteNamed(board.config, name)?.provider ?? name;
  // Identity only: `planStatus` computes `inScope` and `mirrored` from the same
  // scope set it filters the buckets by, so the denominator cannot disagree with
  // the numerators.
  const header: Omit<RemoteStatusReport['remote'], 'inScope' | 'mirrored'> = {
    name,
    provider,
    target: describeTarget(provider, remote.connection),
    scope: remote.scope ?? null,
    lastSync: lastSyncOf(paths, name) ?? null,
  };

  let connector: ReturnType<typeof buildConnector> | null = null;
  let remoteMissing: string | undefined;
  if (options.local === true) {
    // The **local half on purpose**: everything a reader needs to *act* —
    // which documents have twins, what has never been pushed, what has been
    // edited here since the last sync — is already on disk, and answering from
    // disk costs nothing. The remote half is now a handful of requests rather
    // than one per twin, but "instantly, with no credential" is still a
    // different offer from "quickly", and it is the one a tab wants on open.
    // The `remoteMissing` sentence is the same field a missing credential uses,
    // because it answers the same question: why the remote columns are empty.
    remoteMissing = 'the remote was not read — this is the local half of the report';
  } else {
    try {
      connector = buildConnector(remote, paths);
    } catch (error) {
      remoteMissing = describeError(error);
    }
  }

  // `--changed` asks the remote for what moved since the stored cursor. A store
  // with no cursor has nothing to be incremental about, so the flag quietly
  // gets a full listing rather than an error — the same shape
  // `getCursorForPull` gives the pull.
  const cursor =
    connector === null ? null : getCursorForPull(store, { fullSync: options.changed !== true });
  const incremental = cursor !== null;

  let half: RemoteHalf | null = null;
  if (connector !== null && store.links.size === 0) {
    // **Nothing mirrored, so nothing to read.** This is a deliberate no-fetch
    // case and not an optimisation: with no twin anywhere, every remote issue
    // anchors nowhere, and a listing would report a tracker's entire contents as
    // work waiting to be imported. That is the same true-but-useless list
    // `coverage` refuses to produce — a document is worth reporting because
    // something mirrored points at it, never merely because it exists over
    // there. `lpm remote pull` is what adopts a whole tracker onto a fresh
    // board, and it is asked for explicitly.
    //
    // Reported as a *read* of nothing rather than as a missing remote half, so
    // the report still says "in sync" on a board with nothing to sync.
    half = { patches: new Map(), unreadable: [], incoming: [], read: 0 };
  } else if (connector !== null) {
    try {
      half = await readRemoteHalf(
        connector,
        remote,
        view,
        store,
        (record) =>
          remote.provider.translator.fieldsFromRecord(
            record,
            remote.mapping,
            attributes,
            roster,
            periods,
          ).patch,
        {
          cursor,
          incremental,
          ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
        },
      );
    } catch (error) {
      // A listing is all-or-nothing, so there is no half-read remote to report:
      // the whole remote side is missing and the report says why, exactly as it
      // does for a credential it could not resolve. This is also why `failed`
      // comes back empty from this path — it named the per-twin fetch that no
      // longer happens, and is kept on the report for the readers that consume
      // it rather than repurposed into something it does not mean.
      remoteMissing = describeError(error);
    }
  }

  return planStatus({
    board: view,
    store,
    scope: remote.scope,
    options: {
      conflict: remote.conflict,
      overrides: remote.fields,
      resolutions,
      ...(remote.provider.translator.normalizeBody !== undefined
        ? { normalizeBody: remote.provider.translator.normalizeBody }
        : {}),
    },
    fields,
    unwritable: unwritableFieldsOf(board, remote),
    patches: half === null ? null : half.patches,
    ...(remoteMissing !== undefined ? { remoteMissing } : {}),
    remote: header,
    unreadable: half?.unreadable ?? [],
    incoming: half?.incoming ?? [],
    failed: [],
    ...(half !== null ? { remoteRead: half.read } : {}),
    ...(half !== null && incremental ? { incremental: true } : {}),
    verbose: options.verbose === true,
  });
}
