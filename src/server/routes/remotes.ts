import type { BoardConfig, BoardPaths } from '../../core/index.js';
import {
  BoardError,
  currentUser,
  loadBoard,
  loadConfig,
  moveNode,
  remoteNamed,
  turnRemoteOn,
  updateNode,
} from '../../core/index.js';
import {
  appendResolveAudit,
  applyInspectAnswers,
  connectRemote,
  describeProviders,
  inspectRemoteConnection,
  lookupProvider,
  remoteCredentialStates,
  removeRemote,
  secretKeyNames,
  setRemoteConnection,
  storeCredentials,
  attributeDefsOf,
  buildConnector,
  checkReadiness,
  computeRemoteCoverage,
  splitPushSelection,
  computeRemoteStatus,
  loadLinkStore,
  loadResolutions,
  openRemote,
  periodIndexOf,
  planConflicts,
  recordDocumentResolution,
  recordFieldResolution,
  rosterOf,
  runSync,
  saveResolutions,
  summarizeRemotes,
  trackedFields,
  type OpenedRemote,
  type ConnectionCandidate,
  type CredentialState,
  type InspectReport,
  type ReconcileBlock,
  type OpProgress,
  type RemoteSummary,
  type RunSyncResult,
} from '../../remote/index.js';
import type {
  RemoteCandidateDto,
  RemoteConflictDto,
  RemoteConnectRequestDto,
  RemoteConnectResultDto,
  RemoteConnectionDto,
  RemoteConnectionUpdateDto,
  RemoteCredentialStateDto,
  RemoteCredentialsRequestDto,
  RemoteCredentialsResultDto,
  RemoteInspectAnswersDto,
  RemoteInspectAnswersResultDto,
  RemoteInspectDto,
  RemoteProviderDto,
  RemoteReadinessFixDto,
  RemoteReadinessFixResultDto,
  RemoteReconcileBlockDto,
  RemotePreviewDto,
  RemoteResolveOwner,
  RemoteResolveRequestDto,
  RemoteResolveResultDto,
  RemoteSummaryDto,
  RemoteSyncDirection,
  RemoteSyncEventDto,
  RemoteSyncRequestDto,
  RemoteSyncResultDto,
} from '../../shared/index.js';
import { summarizePushFailures } from '../../shared/index.js';
import type { BoardView } from '../../shared/plans/reading.js';
import { toSnapshot } from '../../sync/dto.js';
import { HttpError, readJson, sendJson } from '../http/respond.js';
import type { Router } from '../http/router.js';

/**
 * The remote routes: status, preview, sync and resolve over the same remote
 * layer the CLI drives, so a browser tab and `lpm remote` cannot disagree.
 *
 * These are the first routes that make an outbound request on behalf of
 * whoever can reach the port.  Two properties hold the posture together:
 *
 *   - **No credential crosses the wire.**  A request names a remote; the
 *     server resolves the token itself (environment, `.lpm/credentials.json`)
 *     and nothing in any response body carries one.
 *   - **One sync at a time.**  `remoteSyncGuard` records the remote currently
 *     syncing, so a second sync returns 409 rather than two runs racing on
 *     the board.  The loopback bind and origin check live in `server/index.ts`.
 */

// ---------------------------------------------------------------------------
// The one-sync-at-a-time guard
// ---------------------------------------------------------------------------

/** Records which remote is currently syncing, or null when none is. */
export interface RemoteSyncGuard {
  inFlight: string | null;
}

/**
 * Process-wide, one sync at a time: two concurrent syncs would race on the
 * board, and `lpm ui` serves one board per process anyway.  Shared by every
 * server created in a test process, so a failed run must reset it (see
 * `resetRemoteSyncGuard`).
 */
export const remoteSyncGuard: RemoteSyncGuard = { inFlight: null };

/** Clear any in-flight sync — the test hook for a run that failed to unwind. */
export function resetRemoteSyncGuard(): void {
  remoteSyncGuard.inFlight = null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function remoteRoutes(router: Router, paths: BoardPaths): void {
  // -- connecting a remote ----------------------------------------------------
  // The only routes that take a secret *in*. Beside the loopback bind and the
  // origin check every route already has, two properties keep that honest: a
  // credential value is written to `.lpm/credentials.json` and appears in no
  // response — what comes back is where each value comes from, never the value
  // — and nothing on this server logs a request body. The refusals themselves
  // (a secret in config.yml, an undeclared key, re-pointing a remote with twins)
  // live in `src/remote/connection.ts`, not here.

  router.get('/api/remote-providers', ({ res }) => {
    const providers: RemoteProviderDto[] = describeProviders();
    sendJson(res, 200, providers);
  });

  router.post('/api/remotes', async ({ req, res }) => {
    const body = await readJson<Partial<RemoteConnectRequestDto>>(req);
    refuseDuringSync();
    const name = requireString(body.name, 'name');
    const provider = requireString(body.provider, 'provider');
    const result = connectRemote(paths, requireConfig(paths), {
      name,
      provider,
      connection: stringOrBooleanRecord(body.connection, 'connection'),
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
      credentials: stringRecord(body.credentials, 'credentials'),
      force: body.force === true,
    });
    const dto: RemoteConnectResultDto = {
      name: result.name,
      provider: result.provider,
      target: result.target,
      replaced: result.replaced,
      markers: result.markers.map(({ path, question }) => ({ path, question })),
      stored: [...result.stored],
      credentials: result.credentials.map(toCredentialStateDto),
    };
    sendJson(res, 201, dto);
  });

  router.get('/api/remotes/:name/connection', ({ res, params }) => {
    sendJson(res, 200, connectionDtoOf(paths, requireConfig(paths), params.name!));
  });

  router.put('/api/remotes/:name/connection', async ({ req, res, params }) => {
    const name = params.name!;
    const body = await readJson<Partial<RemoteConnectionUpdateDto>>(req);
    refuseDuringSync();
    setRemoteConnection(paths, requireConfig(paths), name, stringOrBooleanRecord(body.connection, 'connection'));
    // Re-read: the file just changed, and the form shows what is now written.
    sendJson(res, 200, connectionDtoOf(paths, requireConfig(paths), name));
  });

  router.put('/api/remotes/:name/credentials', async ({ req, res, params }) => {
    const name = params.name!;
    const body = await readJson<Partial<RemoteCredentialsRequestDto>>(req);
    const config = requireConfig(paths);
    const declared = requireDeclared(config, name);
    const stored = storeCredentials(paths, name, declared.provider, stringRecord(body.credentials, 'credentials'));
    const dto: RemoteCredentialsResultDto = {
      stored,
      credentials: remoteCredentialStates(paths, config, name).map(toCredentialStateDto),
    };
    sendJson(res, 200, dto);
  });

  router.post('/api/remotes/:name/inspect', async ({ req, res, params }) => {
    const name = params.name!;
    const body = await readJson<{ dryRun?: unknown }>(req);
    refuseDuringSync();
    const report = await inspectRemoteConnection(loadBoard(paths), name, { apply: body.dryRun !== true });
    sendJson(res, 200, toInspectDto(name, report));
  });

  router.post('/api/remotes/:name/answers', async ({ req, res, params }) => {
    const name = params.name!;
    const body = await readJson<Partial<RemoteInspectAnswersDto>>(req);
    refuseDuringSync();
    const changed = applyInspectAnswers(paths, requireConfig(paths), name, {
      ...(body.connection !== undefined ? { connection: stringRecord(body.connection, 'connection') } : {}),
      ...(body.types !== undefined ? { types: stringRecord(body.types, 'types') } : {}),
      ...(body.statuses !== undefined ? { statuses: stringRecord(body.statuses, 'statuses') } : {}),
    });
    const dto: RemoteInspectAnswersResultDto = { changed };
    sendJson(res, 200, dto);
  });

  router.delete('/api/remotes/:name', ({ res, params, query }) => {
    refuseDuringSync();
    const purge = query.get('purge') === '1' || query.get('purge') === 'true';
    sendJson(res, 200, removeRemote(paths, { name: params.name!, purge }));
  });

  // A remote turned off (to share the board through git instead) comes back
  // as it was. `lpm remote on` is the same call; the off half is the git
  // setup route, which is the only place a front end turns one off.
  router.post('/api/remotes/:name/on', ({ res, params }) => {
    refuseDuringSync();
    turnRemoteOn(paths, params.name!);
    sendJson(res, 200, { name: params.name! });
  });

  // -- syncing --------------------------------------------------------------
  router.get('/api/remotes', ({ res }) => {
    const loaded = loadConfig(paths);
    if (!loaded.config) {
      // loadConfig already surfaced the reason; carry the hints through.
      throw new HttpError(500, 'Cannot read the board config', loaded.errors);
    }
    sendJson(res, 200, summarizeRemotes(paths, loaded.config).map(toRemoteSummaryDto));
  });

  router.get('/api/remotes/:name/status', async ({ res, params, query }) => {
    const name = params.name!;
    const board = loadBoard(paths);
    openRemote(board.config, name); // throws when the remote is not declared
    const verbose = query.get('verbose') === '1' || query.get('verbose') === 'true';
    // `?local=1` is the instant half: no connector, no request, every field a
    // screen needs to draw twins and unpushed work. Without it this route reads
    // the tracker in one paginated listing — seconds rather than the minutes
    // one-request-per-twin cost — so the client still reads local first (it
    // needs no credential and cannot fail) and asks for the full one when
    // somebody wants to know what moved upstream.
    const local = query.get('local') === '1' || query.get('local') === 'true';
    // `?changed=1` narrows the listing to what moved since the last sync's
    // cursor. Cheaper, and it can say nothing about what is absent, so the
    // report's `incoming` and `unreadable` stand down for it — the same rule a
    // `--changed` pull follows, for the same reason.
    const changed = query.get('changed') === '1' || query.get('changed') === 'true';
    const report = await computeRemoteStatus(board, name, { verbose, local, changed });
    sendJson(res, 200, report);
  });

  // Coverage is the offline half of "how is the mirror doing": the board and
  // the link store answer it between them, so it costs no request, needs no
  // credential, and can be re-read after every push without slowing one down.
  router.get('/api/remotes/:name/coverage', ({ res, params }) => {
    const name = params.name!;
    const board = loadBoard(paths);
    openRemote(board.config, name); // throws when the remote is not declared
    sendJson(res, 200, computeRemoteCoverage(board, name));
  });

  // What will not land the way the board says — asked before anything is
  // written. Two requests upstream whatever the size of the push (who can be
  // assigned, which periods exist), so it is cheap enough to run every time
  // somebody presses Push.
  router.post('/api/remotes/:name/readiness', async ({ req, res, params }) => {
    const name = params.name!;
    const body = await readJson<{ only?: string[] }>(req).catch(() => ({}) as { only?: string[] });
    const { board, remote } = openNamedRemote(paths, name);
    const report = await checkReadiness(board, remote, paths, {
      ...(body.only !== undefined && body.only.length > 0 ? { only: body.only } : {}),
    });
    sendJson(res, 200, report);
  });

  // Apply the fixes somebody chose. Board writes, every one of them through
  // the engine's own operations — this route does not know how to edit a
  // document, it knows which operation answers which finding. `file_period` is
  // deliberately absent: filing a period is not a board edit, it is the push
  // being told to carry one more document, which the caller does by naming it.
  router.post('/api/remotes/:name/readiness/fix', async ({ req, res, params }) => {
    const name = params.name!;
    const body = await readJson<RemoteReadinessFixDto>(req);
    requireDeclared(requireConfig(paths), name);
    const fixes = Array.isArray(body.fixes) ? body.fixes : [];
    const changed: string[] = [];

    for (const fix of fixes) {
      // Reloaded per fix: core operations write straight to disk, so every
      // handle is stale afterwards — the same reason `PushSession` reloads.
      const board = loadBoard(paths);
      if (fix.kind === 'link_account') {
        const resource = board.resourcesById.get(requireString(fix.resourceId, 'resourceId'));
        if (!resource) throw new HttpError(400, `No resource "${fix.resourceId}" on this board`);
        const via = requireString(fix.via, 'via');
        const value = requireString(fix.value, 'value');
        updateNode(board, resource, { attributes: { [via]: value } });
        changed.push(`${resource.id} ${via} = ${value}`);
      } else if (fix.kind === 'unassign') {
        for (const id of fix.issueIds ?? []) {
          const issue = board.byId.get(id);
          if (!issue) continue; // already gone: nothing to clear
          moveNode(loadBoard(paths), issue, { assignee: null });
          changed.push(`${id} unassigned`);
        }
      } else {
        throw new HttpError(400, `Unknown readiness fix "${(fix as { kind?: string }).kind}"`);
      }
    }

    sendJson(res, 200, { changed } satisfies RemoteReadinessFixResultDto);
  });

  router.post('/api/remotes/:name/preview', async ({ req, res, params }) => {
    const name = params.name!;
    const body = await readJson<RemoteSyncRequestDto>(req);
    const direction = parseDirection(body.direction);
    const { board, remote } = openNamedRemote(paths, name);

    const result = await runSync(board, remote, paths, {
      direction,
      dryRun: true,
      ...(body.scope !== undefined ? { scope: body.scope } : {}),
      ...selectionOptions(board, name, body.only),
      ...(body.pullIds !== undefined && body.pullIds.length > 0 ? { pullIds: body.pullIds } : {}),

      ...(body.limit !== undefined ? { limit: body.limit } : {}),
      changed: body.changed === true,
      refresh: body.refresh === true,
    });
    sendJson(res, 200, toPreviewDto(name, result));
  });

  router.post('/api/remotes/:name/sync', async ({ req, res, params }) => {
    const name = params.name!;
    const body = await readJson<RemoteSyncRequestDto>(req);
    const direction = parseDirection(body.direction);

    // The guard comes before the remote opens: a sync is already in flight and
    // the answer to a second one is "wait", whatever it names.
    if (remoteSyncGuard.inFlight !== null) {
      throw new HttpError(409, `A sync is already running for remote "${remoteSyncGuard.inFlight}"`, [
        'One sync runs at a time. Wait for it to finish, then try again.',
      ]);
    }

    // Resolve everything that can fail *before* the headers go out, so a bad
    // name or a missing credential is a clean 400 rather than a mid-stream
    // event.  No await sits between the guard check and the guard set, so two
    // requests cannot both pass the check.
    const { board, remote } = openNamedRemote(paths, name);
    remoteSyncGuard.inFlight = name;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
    });
    const emit = (event: RemoteSyncEventDto): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const result = await runSync(board, remote, paths, {
        direction,
        ...(body.scope !== undefined ? { scope: body.scope } : {}),
        ...selectionOptions(board, name, body.only),
        ...(body.pullIds !== undefined && body.pullIds.length > 0 ? { pullIds: body.pullIds } : {}),
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
        changed: body.changed === true,
        refresh: body.refresh === true,
        ...(body.yes === true ? { yes: true } : {}),
        onProgress: (progress: OpProgress) =>
          emit({
            type: 'progress',
            index: progress.index,
            total: progress.total,
            kind: progress.op.kind,
            localId: progress.localId,
          }),
      });
      emit({ type: 'done', result: toSyncResultDto(name, result) });
      res.end();
    } catch (error) {
      // The headers are already out; the failure travels as the last event.
      if (error instanceof BoardError) {
        emit({ type: 'error', error: error.message, details: error.details });
      } else {
        emit({ type: 'error', error: error instanceof Error ? error.message : String(error) });
      }
      res.end();
    } finally {
      remoteSyncGuard.inFlight = null;
    }
  });

  router.post('/api/remotes/:name/resolve', async ({ req, res, params }) => {
    const name = params.name!;
    const body = await readJson<RemoteResolveRequestDto>(req);
    const decision = parseResolveBody(body);
    const { board, remote } = openNamedRemote(paths, name);

    const store = loadLinkStore(paths, name);
    const resolutions = loadResolutions(paths, name);

    if (!board.byId.has(decision.id)) {
      throw new HttpError(400, `No document "${decision.id}" on this board`, [
        'Resolve names a local document id, e.g. { id: "LP-12", default: "local" }.',
      ]);
    }
    if (!store.links.has(decision.id)) {
      throw new HttpError(400, `"${decision.id}" is not linked on remote "${name}"`, [
        'There is no twin, so there is nothing to settle — push first to create one.',
      ]);
    }

    const known = trackedFields(remote.mapping);
    for (const field of Object.keys(decision.fields)) {
      if (!known.has(field)) {
        throw new HttpError(400, `"${field}" is not a field this remote tracks`, [
          `Tracked fields: ${[...known].sort().join(', ')}`,
          'A field the mapping does not carry cannot conflict, so it cannot be resolved.',
        ]);
      }
    }

    if (decision.default !== undefined) {
      recordDocumentResolution(resolutions, decision.id, decision.default);
    }
    for (const [field, owner] of Object.entries(decision.fields)) {
      recordFieldResolution(resolutions, decision.id, field, owner);
    }
    saveResolutions(paths, name, resolutions);

    const author = currentUser(board)?.ref ?? 'unknown';
    appendResolveAudit(paths, name, {
      at: new Date().toISOString(),
      author,
      localId: decision.id,
      default: decision.default,
      fields: Object.keys(decision.fields).length > 0 ? decision.fields : undefined,
    });

    const result: RemoteResolveResultDto = {
      remoteName: name,
      localId: decision.id,
      ...(decision.default !== undefined ? { default: decision.default } : {}),
      fields: decision.fields,
    };
    sendJson(res, 200, result);
  });

  router.get('/api/remotes/:name/conflicts/:id', async ({ res, params }) => {
    const name = params.name!;
    const localId = params.id!;
    const { board, remote } = openNamedRemote(paths, name);
    const detail = await conflictDetail(paths, board, remote, localId);
    if (detail === null) {
      throw new HttpError(404, `"${localId}" has no open conflict on remote "${name}"`, [
        'A document without an open conflict has nothing to resolve.',
      ]);
    }
    sendJson(res, 200, detail);
  });
}

// ---------------------------------------------------------------------------
// Inputs and validation
// ---------------------------------------------------------------------------

/** The board and the one named remote, or a `BoardError` naming the choice. */
function openNamedRemote(paths: BoardPaths, name: string): { board: ReturnType<typeof loadBoard>; remote: OpenedRemote } {
  const board = loadBoard(paths);
  const remote = openRemote(board.config, name);
  return { board, remote };
}

/** `push`, `pull` or `both`; a missing direction means `both`, like `lpm remote sync`. */
/**
 * The run options a selection implies.
 *
 * A selection may name a period, and a period does not travel as `only`: a
 * push of work files no sprints, so it is named in `periods` instead, and
 * filing it joins the mirrored issues waiting on it to the run. The rule lives
 * in `splitPushSelection` so this route and `lpm remote push` cannot answer
 * the same gesture differently — a period id left in `only` is a push that
 * silently does nothing.
 */
function selectionOptions(
  board: ReturnType<typeof loadBoard>,
  name: string,
  only: string[] | undefined,
): { only?: string[]; periods?: string[] } {
  if (only === undefined || only.length === 0) return {};
  const split = splitPushSelection(board, name, only);
  return {
    ...(split.only.length > 0 ? { only: split.only } : {}),
    ...(split.periods !== undefined ? { periods: split.periods } : {}),
  };
}

function parseDirection(raw: unknown): RemoteSyncDirection {
  if (raw === undefined) return 'both';
  if (raw === 'push' || raw === 'pull' || raw === 'both') return raw;
  throw new HttpError(400, `Unknown sync direction ${JSON.stringify(raw)}`, [
    'Direction is "push", "pull" or "both".',
  ]);
}

/** An owner value must be `local` or `remote`. */
function parseOwner(value: unknown, what: string): RemoteResolveOwner {
  if (value === 'local' || value === 'remote') return value;
  throw new HttpError(400, `${what} must be "local" or "remote"`, [`Got ${JSON.stringify(value)}.`]);
}

/** Validate a resolve body into a typed decision. */
function parseResolveBody(body: RemoteResolveRequestDto): {
  id: string;
  default?: RemoteResolveOwner;
  fields: Record<string, RemoteResolveOwner>;
} {
  if (typeof body.id !== 'string' || body.id === '') {
    throw new HttpError(400, 'A document id is required', [
      'Usage: POST /api/remotes/<name>/resolve { id, default?, fields? }.',
    ]);
  }

  const defaultOwner = body.default === undefined ? undefined : parseOwner(body.default, 'default');

  const fields: Record<string, RemoteResolveOwner> = {};
  if (body.fields !== undefined && body.fields !== null) {
    if (typeof body.fields !== 'object' || Array.isArray(body.fields)) {
      throw new HttpError(400, 'fields must be an object mapping field names to "local" or "remote"');
    }
    for (const [field, owner] of Object.entries(body.fields)) {
      fields[field] = parseOwner(owner, `fields.${field}`);
    }
  }

  if (defaultOwner === undefined && Object.keys(fields).length === 0) {
    throw new HttpError(400, 'Nothing to resolve', [
      'Give default: "local"|"remote", or at least one field: { field: "local"|"remote" }.',
    ]);
  }

  return { id: body.id, ...(defaultOwner !== undefined ? { default: defaultOwner } : {}), fields };
}

// ---------------------------------------------------------------------------
// The status report
// ---------------------------------------------------------------------------

/** The board as the remote layer reads it: a `BoardView` DTO. */
function viewOf(board: ReturnType<typeof loadBoard>): BoardView {
  const snapshot = toSnapshot(board);
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources, ...snapshot.templates].map(
      (node) => [node.id, node],
    ),
  );
  return { config: snapshot.config, nodes };
}

/**
 * The conflict detail for one document: its conflicted fields with both sides,
 * plus the remote twin's key, url and any pending resolutions.  Returns null
 * when the document is not linked, has no readable twin, or has no open
 * conflict — the panel treats "no conflict" as the ordinary case.
 */
async function conflictDetail(
  paths: BoardPaths,
  board: ReturnType<typeof loadBoard>,
  remote: OpenedRemote,
  localId: string,
): Promise<RemoteConflictDto | null> {
  const store = loadLinkStore(paths, remote.name);
  const resolutions = loadResolutions(paths, remote.name);
  const fields = trackedFields(remote.mapping);

  const link = store.links.get(localId);
  if (!link) return null;

  const view = viewOf(board);
  const doc = view.nodes[localId];
  if (!doc || doc.kind !== 'issue') return null;

  const connector = buildConnector(remote, paths);
  const record = await connector.get(link.remoteId);
  if (record === null) return null;

  const patch = remote.provider.translator.fieldsFromRecord(
    record,
    remote.mapping,
    attributeDefsOf(board),
    rosterOf(board),
    periodIndexOf(board),
  ).patch;

  const plan = planConflicts(
    view,
    store,
    new Map([[localId, patch]]),
    {
      conflict: remote.conflict,
      overrides: remote.fields,
      resolutions,
      ...(remote.provider.translator.normalizeBody !== undefined
        ? { normalizeBody: remote.provider.translator.normalizeBody }
        : {}),
    },
    fields,
  );

  const merged = plan.documents[0];
  if (!merged) return null;

  // Fields a human must settle (still a raw conflict) plus fields a pending
  // resolution will settle on the next sync — the choice rides along so the
  // panel can show what was already decided. A field the config policy already
  // broke is not shown: it was never the human's to settle.
  const conflicting = merged.fields.filter(
    (entry) => entry.outcome === 'conflict' || entry.resolution !== undefined,
  );
  if (conflicting.length === 0) return null;

  const pending = resolutions.resolutions.get(localId);
  return {
    remoteName: remote.name,
    localId,
    remoteId: link.remoteId,
    remoteKey: link.remoteKey,
    remoteUrl: link.remoteUrl,
    ...(pending?.default !== undefined ? { default: pending.default } : {}),
    fields: conflicting.map((entry) => ({
      field: entry.field,
      local: entry.local,
      remote: entry.remote,
      ...(entry.resolution !== undefined ? { chosen: entry.resolution } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Wire mapping
// ---------------------------------------------------------------------------

/** A `RemoteSummary` as the list endpoint returns it (`lastSync` normalised to null). */
function toRemoteSummaryDto(summary: RemoteSummary): RemoteSummaryDto {
  return {
    name: summary.name,
    provider: summary.provider,
    direction: summary.direction,
    target: summary.target,
    lastSync: summary.lastSync ?? null,
  };
}

/** A dry-run `RunSyncResult` as the preview endpoint returns it. */
export function toPreviewDto(name: string, result: RunSyncResult): RemotePreviewDto {
  // `renders` is built pull-first: one pull render (when pulled and reachable),
  // then one push render.  Recover each render's direction from the plan shape.
  const pullRenderCount =
    result.pullPlan !== undefined && result.unreachable === undefined ? 1 : 0;
  return {
    remoteName: name,
    direction: result.direction,
    preflight: result.preflight.map((problem) => ({
      level: problem.level,
      message: problem.message,
    })),
    preflightBlocked: result.preflightBlocked,
    ...(result.unreachable !== undefined ? { unreachable: result.unreachable } : {}),
    renders: (result.renders ?? []).map((render, index) => ({
      direction: index < pullRenderCount ? 'pull' : 'push',
      total: render.total,
      sections: render.sections.map((section) => ({
        kind: section.kind,
        label: section.label,
        count: section.count,
        documents: section.documents.map((doc) => ({
          localId: doc.localId,
          ...(doc.title !== undefined ? { title: doc.title } : {}),
          ...(doc.remoteId !== undefined ? { remoteId: doc.remoteId } : {}),
          kind: doc.kind,
          fields: doc.fields.map((field) => ({
            field: field.field,
            local: field.local,
            remote: field.remote,
            outcome: field.outcome,
          })),
        })),
      })),
      text: render.text,
    })),
  };
}

/** An applied `RunSyncResult` as the `done` event's payload. */
function toSyncResultDto(name: string, result: RunSyncResult): RemoteSyncResultDto {
  const dto: RemoteSyncResultDto = {
    remoteName: name,
    direction: result.direction,
    preflight: result.preflight.map((problem) => ({
      level: problem.level,
      message: problem.message,
    })),
    preflightBlocked: result.preflightBlocked,
    pullConflicts: { conflicts: [], fieldConflicts: [] },
  };

  if (result.unreachable !== undefined) dto.unreachable = result.unreachable;

  if (result.pullResult !== undefined) {
    dto.pull = {
      applied: result.pullResult.applied.length,
      linked: result.pullResult.linked.length,
      unlinked: result.pullResult.unlinked.length,
      decoupled: result.pullResult.decoupled.length,
      appendedComments: result.pullResult.appendedComments,
      failures: summarizePushFailures(result.pullResult.failures),
    };
  }

  if (result.pushResult !== undefined) {
    dto.push = {
      created: result.pushResult.summary.created,
      updated: result.pushResult.summary.updated,
      skipped: result.pushResult.summary.skipped,
      conflicted: result.pushResult.summary.conflicted,
      failed: result.pushResult.summary.failed,
      conflictedOps: result.pushResult.conflicted.map((op) => ({
        kind: op.kind,
        localId: op.localId,
        error: op.error,
      })),
      failedOps: result.pushResult.failed.map((op) => ({
        kind: op.kind,
        localId: op.localId,
        error: op.error,
      })),
      ...(result.pushResult.stopped !== undefined
        ? {
            stopped: {
              reason: result.pushResult.stopped.reason,
              atOp: result.pushResult.stopped.atOp,
              detail: result.pushResult.stopped.detail,
              ...(result.pushResult.stopped.deferred !== undefined
                ? { deferred: result.pushResult.stopped.deferred }
                : {}),
            },
          }
        : {}),
    };
  }

  if (result.consentRefused !== undefined) {
    dto.consentRefused = {
      reason: result.consentRefused.reason,
      target: result.consentRefused.target,
      creates: result.consentRefused.counts.creates,
      closes: result.consentRefused.counts.closes,
      deletes: result.consentRefused.counts.deletes,
      threshold: result.consentRefused.threshold,
    };
  }

  if (result.pullPlan !== undefined) {
    dto.pullConflicts = {
      conflicts: (result.pullPlan.conflicts ?? []).map((conflict) => ({
        localId: conflict.localId,
        remoteId: conflict.remoteId,
        reason: conflict.reason,
        ...(conflict.childId !== undefined ? { childId: conflict.childId } : {}),
      })),
      fieldConflicts: (result.pullPlan.fieldConflicts ?? []).map((conflict) => ({
        localId: conflict.localId,
        remoteId: conflict.remoteId,
        field: conflict.field,
        local: conflict.local,
        remote: conflict.remote,
      })),
    };
  }

  return dto;
}

// ---------------------------------------------------------------------------
// Connecting: request parsing and response shaping
// ---------------------------------------------------------------------------

/** A config edit while a sync runs would change the remote under the run's feet. */
function refuseDuringSync(): void {
  if (remoteSyncGuard.inFlight !== null) {
    throw new HttpError(409, `A sync is running for remote "${remoteSyncGuard.inFlight}"`, [
      'Wait for it to finish, then try again.',
    ]);
  }
}

/** The board config, or the reason it cannot be read. */
function requireConfig(paths: BoardPaths): BoardConfig {
  const loaded = loadConfig(paths);
  if (!loaded.config) throw new HttpError(500, 'Cannot read the board config', loaded.errors);
  return loaded.config;
}

function requireDeclared(config: BoardConfig, name: string): NonNullable<ReturnType<typeof remoteNamed>> {
  const declared = remoteNamed(config, name);
  if (!declared) throw new BoardError(`No remote named "${name}"`, ['This board declares no remote by that name.']);
  return declared;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${what} is required`);
  return value.trim();
}

/** An object of strings and booleans. A message names the offending key, never its value. */
function stringOrBooleanRecord(value: unknown, what: string): Record<string, string | boolean> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `${what} must be an object`);
  }
  const out: Record<string, string | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' && typeof entry !== 'boolean') {
      throw new HttpError(400, `${what}.${key} must be a string or a boolean`);
    }
    out[key] = entry;
  }
  return out;
}

/** An object of strings. A message names the offending key, never its value. */
function stringRecord(value: unknown, what: string): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `${what} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new HttpError(400, `${what}.${key} must be a string`);
    out[key] = entry;
  }
  return out;
}

/** Copy the four fields a credential state has — by name, so nothing else can ride along. */
function toCredentialStateDto(state: CredentialState): RemoteCredentialStateDto {
  return {
    key: state.key,
    ...(state.env !== undefined ? { env: state.env } : {}),
    ...(state.source !== undefined ? { source: state.source } : {}),
    ...(state.reference !== undefined ? { reference: state.reference } : {}),
  };
}

/** A declared remote for the edit form: its non-secret values, credential states and twin count. */
function connectionDtoOf(paths: BoardPaths, config: BoardConfig, name: string): RemoteConnectionDto {
  const declared = requireDeclared(config, name);
  const secrets = new Set(secretKeyNames(lookupProvider(declared.provider)));
  const connection: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(declared.connection)) {
    // A secret key's config value is never sent, even when it is only a
    // `${VAR}` reference: the reference is reported as a credential state.
    if (secrets.has(key)) continue;
    if (typeof value === 'boolean') connection[key] = value;
    else if (value !== undefined && value !== null) connection[key] = String(value);
  }
  return {
    name,
    provider: declared.provider,
    scope: declared.scope ?? null,
    connection,
    credentials: remoteCredentialStates(paths, config, name).map(toCredentialStateDto),
    linked: loadLinkStore(paths, name).links.size,
  };
}

function toCandidateDto(candidate: ConnectionCandidate): RemoteCandidateDto {
  return { key: candidate.key, value: candidate.value, label: candidate.label };
}

function toReconcileBlockDto(block: ReconcileBlock): RemoteReconcileBlockDto {
  return {
    entries: block.entries.map((entry) => ({
      boardKey: entry.boardKey,
      claimed: entry.claimed,
      ...(entry.resolved !== undefined ? { resolved: entry.resolved } : {}),
      verdict: entry.verdict,
    })),
    candidates: [...block.candidates],
  };
}

/** An inspection report for the wire. Exported for the route tests. */
export function toInspectDto(name: string, report: InspectReport): RemoteInspectDto {
  const blocks = [report.vocabulary?.report.types, report.vocabulary?.report.statuses];
  const unresolved = blocks.some((block) => (block?.entries ?? []).some((entry) => entry.verdict === 'unresolved'));
  const question = (entry: { key: string; why: string; candidates: ConnectionCandidate[] }) => ({
    key: entry.key,
    why: entry.why,
    candidates: entry.candidates.map(toCandidateDto),
  });
  const types = report.vocabulary?.report.types;
  const statuses = report.vocabulary?.report.statuses;
  return {
    remoteName: name,
    ...(report.reachability !== undefined
      ? { reachability: { reachable: report.reachability.reachable, evidence: report.reachability.evidence } }
      : {}),
    stopped: report.stopped,
    found: report.found.map(toCandidateDto),
    choices: report.choices.map(question),
    needed: report.needed.map(question),
    ...(report.vocabulary !== undefined
      ? {
          vocabulary: {
            ...(types ? { types: toReconcileBlockDto(types) } : {}),
            ...(statuses ? { statuses: toReconcileBlockDto(statuses) } : {}),
          },
        }
      : {}),
    noVocabulary: !report.stopped && report.vocabulary === undefined,
    ...(report.prerequisites !== undefined ? { prerequisites: { ...report.prerequisites } } : {}),
    written: [...report.written],
    ready: !report.stopped && report.choices.length === 0 && report.needed.length === 0 && !unresolved,
  };
}
