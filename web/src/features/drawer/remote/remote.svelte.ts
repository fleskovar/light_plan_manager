import { getContext, setContext, untrack } from 'svelte';
import { pendingAhead } from '$shared';
import type {
  CoverageGap,
  CoverageRelation,
  ReadinessFinding,
  ReadinessFixRequest,
  RemoteConflictDto,
  RemoteCoverageReport,
  RemotePreviewDto,
  RemoteReadinessFixResultDto,
  RemoteReadinessReport,
  RemoteResolveOwner,
  RemoteResolveRequestDto,
  RemoteResolveResultDto,
  RemoteStatusIncoming,
  RemoteStatusLink,
  RemoteStatusReport,
  RemoteSummaryDto,
  RemoteSyncEventDto,
  RemoteSyncRequestDto,
  RemoteSyncResultDto,
  SyncBadge,
} from '$shared';
import { gapsAround, syncBadgeOf } from '$shared';
import type { CachedStatus } from './status-cache.js';
import {
  clearCachedStatus,
  pruneCachedStatus,
  readCachedStatus,
  withCachedRemoteHalf,
  writeCachedStatus,
} from './status-cache.js';

/**
 * The remote panel's state machine — everything the Sync tab and the canvas
 * sync badges decide, with the fetching and streaming kept out of the
 * components so they stay presentational and the tests stay DOM-free.
 *
 * It talks to the server through a `RemoteApi` seam (the editor's `api`, or a
 * fake in a test) and reports back through a `RemoteHost` seam (the workspace),
 * so neither the panel nor the canvas owns a fetch. The only state it keeps is
 * the remote list, the drift reports, and what a preview or a sync is doing
 * right now.
 */

/**
 * The drift buckets a count can be clicked on — the ones keyed by local id.
 *
 * `pending` and `blocked` partition `ahead`, which is kept because it is still
 * the honest total and the canvas badge is derived from it. `incoming` is
 * deliberately absent: it holds remote issues with no local document, so there is
 * nothing on the canvas to select and nothing a `string[]` of board ids could
 * carry. It is read through `incoming` and acted on with `pullIncoming`.
 */
export type DriftBucket =
  | 'ahead'
  | 'pending'
  | 'blocked'
  | 'behind'
  | 'conflicted'
  | 'unlinked'
  | 'orphaned';

/**
 * Which tile the changes table is narrowed to, or `null` for all of it.
 *
 * The three primary tiles are the three questions somebody opens this panel
 * with, so clicking one has to answer it *here* — selecting the ids on the
 * canvas cannot, because a view holds a few dozen nodes and the documents a
 * sync would write are usually not among them. That is the same mistake the
 * `blocked` chip already had and for the same reason.
 */
export type ChangeFilter = 'pending' | 'behind' | 'conflicted';

/**
 * One count on the panel, and how much a reader should care about it.
 *
 * Built here rather than in the component because which numbers lead is a
 * decision, not a layout: a panel that gave `433 blocked` and `5 to push` the
 * same weight told a reader the mirror was catastrophically behind when five
 * documents needed pushing. `primary` is what somebody can act on now;
 * `secondary` is true, worth knowing, and not today's problem.
 */
/**
 * One line in the changes table: a document, which way it has to move, and the
 * fields that say so.
 *
 * `localId` is null for a tracker issue the board has never had — there is no
 * local document yet, which is the whole difference between a `create` and a
 * `pull`.
 */
export interface ChangeRow {
  key: string;
  localId: string | null;
  remoteKey?: string;
  title: string;
  direction: 'push' | 'pull' | 'conflict' | 'create';
  /** A push this remote cannot accept — shown, but never counted as pending. */
  blocked: boolean;
  fields: Array<{ field: string; local: string; remote: string }>;
}

/** One cause behind a run of blocked documents, and the change that clears it. */
export interface BlockedGroup {
  key: string;
  /** The board field the remote will not take. */
  field: string;
  reason: string;
  remedy?: string;
  /** The documents this cause holds back. */
  localIds: string[];
}

export interface DriftTile {
  id: DriftBucket | 'incoming';
  label: string;
  /** `null` until the tracker has been read — drawn as an em dash, never as 0. */
  count: number | null;
  /** The tooltip: what this number means, in one sentence. */
  hint: string;
}

/** The server calls the state machine makes, behind a seam for tests. */
export interface RemoteApi {
  listRemotes(): Promise<RemoteSummaryDto[]>;
  remoteStatus(
    name: string,
    options?: { local?: boolean; verbose?: boolean; signal?: AbortSignal },
  ): Promise<RemoteStatusReport>;
  /** What the mirror is missing around what it holds. Offline: no tracker call. */
  remoteCoverage(name: string): Promise<RemoteCoverageReport>;
  /** What will not land the way the board says — asked before a push writes. */
  remoteReadiness(name: string, body?: { only?: string[] }): Promise<RemoteReadinessReport>;
  /** Apply the fixes somebody chose. */
  remoteReadinessFix(
    name: string,
    body: { fixes: ReadinessFixRequest[] },
  ): Promise<RemoteReadinessFixResultDto>;
  remotePreview(name: string, body?: RemoteSyncRequestDto): Promise<RemotePreviewDto>;
  remoteSync(
    name: string,
    body: RemoteSyncRequestDto,
    onEvent: (event: RemoteSyncEventDto) => void,
  ): Promise<void>;
  /** One document's conflicted fields and remote twin, for the side panel. */
  remoteConflict(name: string, id: string): Promise<RemoteConflictDto>;
  /** Record a resolution — offline, applied by the next sync. */
  resolve(name: string, body: RemoteResolveRequestDto): Promise<RemoteResolveResultDto>;
}

/** What the state machine needs back from the editor, behind a seam for tests. */
export interface RemoteHost {
  /** Write the per-node badge map the canvas reads. Replaces the whole map. */
  setSyncBadges(badges: Readonly<Record<string, SyncBadge>>): void;
  /** Select these issues on the canvas — clicking a drift count. */
  select(ids: string[]): void;
  /** One document's title, for a table row. The id itself when the board has no such document. */
  titleOf(id: string): string;
  notify(level: 'info' | 'error', message: string, details?: string[]): void;
  report(error: unknown): void;
  /** True while the view has queued edits — sync must never run over them. */
  dirty(): boolean;
  /** Re-read the board, keeping unpushed view edits laid over the top. */
  refresh(): Promise<void>;
  /** Write the queued edits to the board (the Push-first remedy). */
  push(): Promise<void>;
}

/**
 * What the side panel shows for one document: its twin, and which way it has
 * drifted. Deliberately the report's own vocabulary — a second set of words
 * for the same four facts is how a panel and a badge come to disagree.
 */
export interface DocumentRemoteState {
  remoteName: string;
  link: RemoteStatusLink | null;
  ahead: boolean;
  behind: boolean;
  conflicted: boolean;
}

/** The live progress of a running sync, one step at a time. */
export interface SyncProgress {
  index: number;
  total: number;
  kind: string;
  localId: string;
}

/**
 * A one-line summary of an applied sync, for the notice bar and the panel.
 *
 * Pure and exported so it can be unit-tested without a server: a pull of two
 * applied changes and a push of one create reads "pulled 2 applied — pushed 1
 * created", and an unreachable remote says so rather than pretending.
 */
export function summarizeSync(result: RemoteSyncResultDto): string {
  const parts: string[] = [];
  if (result.unreachable) parts.push('remote unreachable');
  if (result.preflightBlocked) parts.push('blocked by preflight');
  if (result.consentRefused) {
    parts.push(
      result.consentRefused.reason === 'threshold'
        ? `refused: more than ${result.consentRefused.threshold} issues would change`
        : result.consentRefused.reason === 'delete'
          ? `refused: deleting ${result.consentRefused.deletes} remote ${result.consentRefused.deletes === 1 ? 'issue' : 'issues'} needs confirmation`
          : `refused: first write to ${result.consentRefused.target} needs confirmation`,
    );
  }

  if (result.pull) {
    const bits: string[] = [];
    if (result.pull.applied) bits.push(`${result.pull.applied} applied`);
    if (result.pull.linked) bits.push(`${result.pull.linked} linked`);
    if (result.pull.unlinked) bits.push(`${result.pull.unlinked} unlinked`);
    if (result.pull.decoupled) bits.push(`${result.pull.decoupled} decoupled`);
    if (result.pull.failures.length) bits.push(`${result.pull.failures.length} failed`);
    parts.push(`pulled ${bits.join(', ') || 'nothing'}`);
  }

  if (result.push) {
    const bits: string[] = [];
    if (result.push.created) bits.push(`${result.push.created} created`);
    if (result.push.updated) bits.push(`${result.push.updated} updated`);
    if (result.push.skipped) bits.push(`${result.push.skipped} skipped`);
    if (result.push.conflicted) bits.push(`${result.push.conflicted} conflicted`);
    if (result.push.failed) bits.push(`${result.push.failed} failed`);
    parts.push(`pushed ${bits.join(', ') || 'nothing'}`);
  }

  const conflicts = result.pullConflicts.conflicts.length + result.pullConflicts.fieldConflicts.length;
  if (conflicts) parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'} left to resolve`);

  return parts.join(' — ') || 'Nothing to do';
}

/**
 * A preview field value as one readable line, for the panel's diff columns.
 * Bodies can be long, so a string is clamped; arrays and objects are inlined.
 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') {
    const flat = value.replace(/\s+/g, ' ').trim();
    if (flat === '') return '—';
    return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
  }
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${value.map(formatValue).join(', ')}]`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * A thrown value as one line, for a panel that has to show what went wrong
 * where it went wrong. The notice bar gets the same message, but a notice is
 * gone in five seconds and "the Sync tab shows nothing and says nothing" is
 * the complaint this answers.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const details = (error as { details?: string[] }).details;
    return details?.length ? `${error.message} — ${details.join(' ')}` : error.message;
  }
  return String(error);
}

/**
 * The candidate each `link_account` fix starts on: the best match the check
 * found, which is an exact one where there was one. Nothing is pre-selected
 * when nothing matched — an empty choice is honest, and a wrong account is
 * worse than none because the work lands on somebody.
 */
export function defaultCandidates(findings: readonly ReadinessFinding[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const finding of findings) {
    if (finding.fix?.kind !== 'link_account') continue;
    const best = finding.fix.candidates[0];
    if (best !== undefined) out[finding.key] = best.value;
  }
  return out;
}

/** The last-sync stamp as a readable date, or "never" when there is none. */
export function formatLastSync(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never synced';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  // Relative, because a toolbar is read at a glance and `13/09/2026, 15:34:58`
  // makes a reader do date arithmetic to answer "is this stale?". The exact
  // moment is still one hover away — see `formatLastSyncExact`.
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

/** The exact moment, for the title attribute behind the relative one. */
export function formatLastSyncExact(iso: string | null): string {
  if (!iso) return 'Never synced';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `Last synced ${date.toLocaleString()}`;
}

export class RemoteState {
  /**
   * Whether the tracker remotes are offered at all — `lpm ui --experimental`.
   *
   * Off until the server says otherwise, and the loaders below are the gate:
   * while it is off nothing is fetched, so `remotes` stays empty, no remote is
   * selected or badged, and every surface that reads this state (the Sync tab's
   * tracker panel, the canvas badges and menu entries, the side panel's remote
   * and conflict sections) has nothing to draw. The server registers no
   * `/api/remotes*` route in that case either, so this is the hint and the
   * missing route is the rule.
   */
  enabled = $state(false);
  remotes = $state<RemoteSummaryDto[]>([]);
  /** True while the remote list or a status report is being fetched. */
  loading = $state(false);
  /** Drift reports, keyed by remote name; absent until fetched. */
  reports = $state<Record<string, RemoteStatusReport>>({});
  /**
   * How far each remote's report goes: `local` is the instant half read from
   * the board and the link store, `full` has been out to the tracker.
   *
   * They are kept apart because the difference is minutes. Reading every twin
   * of a 537-issue mirror is several hundred sequential requests, and the tab
   * used to do it on open, behind one `loading` flag that hid the whole panel
   * — so the Sync tab simply read "Reading drift…" for as long as anybody was
   * willing to wait, with no count, no error and nothing else usable on the
   * screen. Now the local half lands at once and the remote half is asked for.
   */
  statusMode = $state<Record<string, 'local' | 'full'>>({});
  /**
   * Which tile the changes table is narrowed to. Per remote panel rather than
   * per remote: it is a way of reading, not a fact about the mirror.
   */
  changeFilter = $state<ChangeFilter | null>(null);
  /** What the remote half of each report is doing, for the screen to report. */
  driftState = $state<Record<string, 'idle' | 'reading' | 'failed'>>({});
  /** Why the last remote-half read failed, kept until the next attempt. */
  driftError = $state<Record<string, string>>({});
  /** When the running read started, so the screen can show it ticking. */
  driftStarted = $state<Record<string, number>>({});
  /**
   * When the full report on screen was actually checked — live just now, or
   * read back from `localStorage` from an earlier session. Absent means the
   * report has never gone out to the tracker at all (`statusMode` is still
   * `local`). Shown next to "Checked against the tracker" so a cached answer
   * never quietly passes for a live one.
   */
  driftCachedAt = $state<Record<string, string>>({});
  /** The remote whose report drives the canvas badges. */
  badgeRemote = $state<string | null>(null);
  /** The remote the panel is looking at. */
  selected = $state<string | null>(null);

  /**
   * Coverage reports, keyed by remote name; absent until read.
   *
   * Kept beside the drift reports rather than inside them because the two are
   * answered differently: a drift report reads every twin from the tracker and
   * takes minutes on a large project, while coverage is the board and the link
   * store alone. Holding them apart is what lets the gap list appear at once
   * and be re-read after every push.
   */
  coverage = $state<Record<string, RemoteCoverageReport>>({});
  coverageLoading = $state(false);
  /** Why the last coverage read failed — shown in place of the list. */
  coverageError = $state<Record<string, string>>({});
  /** Gap ids ticked for pushing, on the selected remote. */
  picked = $state<Record<string, boolean>>({});

  /**
   * The readiness conversation: what a push is about to get wrong, and what
   * somebody chose to do about it.
   *
   * A push that files forty issues unassigned because an account id went
   * stale is not an error anybody sees — the issues arrive, wrong, and the
   * board and the tracker disagree from then on. So every push asks first, and
   * the answer is held here until a person gives one.
   */
  readiness = $state<RemoteReadinessReport | null>(null);
  readinessChecking = $state(false);
  /** What was chosen per finding; absent means "ignore", the safe default. */
  readinessChoice = $state<Record<string, 'ignore' | 'fix'>>({});
  /** Which candidate a `link_account` fix will write, per finding. */
  readinessCandidate = $state<Record<string, string>>({});
  /** The run held back while the question is open. */
  #held: { name: string; body: RemoteSyncRequestDto } | null = null;

  /** Preview state — a dry-run, nothing written. */
  previewing = $state(false);
  previewResult = $state<RemotePreviewDto | null>(null);

  /** Sync state — the real run, streamed. */
  syncing = $state(false);
  progress = $state<SyncProgress | null>(null);
  syncResult = $state<RemoteSyncResultDto | null>(null);
  /** Which way the running (or last) run went, so Push and Pull can each say what they are doing. */
  syncDirection = $state<'push' | 'pull' | null>(null);

  /** Conflict detail state — what the side panel is showing. */
  conflictFor = $state<string | null>(null);
  conflictDetail = $state<RemoteConflictDto | null>(null);
  conflictLoading = $state(false);
  conflictSaving = $state(false);

  #api: RemoteApi;
  #host: RemoteHost;

  constructor(api: RemoteApi, host: RemoteHost) {
    this.#api = api;
    this.#host = host;
  }

  /** The report for the remote the panel is looking at, when fetched. */
  get report(): RemoteStatusReport | null {
    return this.selected ? (this.reports[this.selected] ?? null) : null;
  }

  /** The drift count for one bucket on the selected remote, 0 while unknown. */
  countOf(bucket: DriftBucket): number {
    return this.idsOf(bucket).length;
  }

  /** The ids in one drift bucket, for "click a count to filter the canvas". */
  idsOf(bucket: DriftBucket): string[] {
    const report = this.report;
    if (!report) return [];
    // `pending` and `blocked` partition `ahead`. `pendingAhead` is the shared
    // definition, so the panel, `lpm remote status` and an agent cannot disagree
    // about which documents a sync would actually write.
    if (bucket === 'pending') return pendingAhead(report);
    if (bucket === 'blocked') return report.blocked.map((entry) => entry.localId);
    return [...report[bucket]];
  }

  /**
   * Every document a sync would touch, one row each, with what changed and why.
   *
   * The counts answer "how much"; this answers "which, and why", which is the
   * question anybody actually has when a number is not zero. It is derived from
   * the report's own per-field detail (`verbose`), so a row can never disagree
   * with the tile above it.
   *
   * The direction is the report's own vocabulary, not a fresh judgement:
   *
   *   - `push`     — the board changed since the last sync, the tracker did not;
   *   - `pull`     — the tracker changed, the board did not;
   *   - `conflict` — both changed the same field, so nobody but a person can say;
   *   - `create`   — a tracker issue with no document here, which a pull adopts.
   *
   * Those first three are exactly what the three-way merge already decided per
   * field (`planConflicts`); this only groups them. A document whose title moved
   * here and whose status moved there appears once per direction, because it has
   * genuinely got work to do in both.
   */
  get changeRows(): ChangeRow[] {
    const rows = this.#allChangeRows();
    const filter = this.changeFilter;
    if (filter === null) return rows;
    return rows.filter((row) =>
      filter === 'pending'
        ? row.direction === 'push'
        : filter === 'behind'
          ? row.direction === 'pull' || row.direction === 'create'
          : row.direction === 'conflict',
    );
  }

  #allChangeRows(): ChangeRow[] {
    const report = this.report;
    if (report === null) return [];
    // **A table of "what a sync would do" needs the tracker to have been
    // read.** Until then `ahead` is only "differs from its base snapshot",
    // which on this repository's board is 48 documents against the 5 a sync
    // would really write — so an unchecked table listed forty-odd rows that
    // then vanished when the check landed. The tiles say `—` for the same
    // reason; this is that rule applied to the evidence behind them.
    if (!this.#checked) return [];
    const blocked = new Set(report.blocked.map((entry) => entry.localId));
    // **A document a sync will not write does not belong in a list of what a
    // sync would do.** `pendingAhead` is the definition of that, and without
    // it this table contradicted the tile above it: 428 unwritable rows buried
    // the 5 somebody clicked "to push" to find, while the caption said "what a
    // sync would do, document by document". Those documents are not lost —
    // they are the "to fix" section, grouped by the cause they share, which is
    // the only form in which 428 of anything is readable.
    const pending = new Set(pendingAhead(report));
    const rows: ChangeRow[] = [];

    const detail = report.fields ?? {};
    for (const localId of new Set([...report.ahead, ...report.behind, ...report.conflicted])) {
      const fields = detail[localId] ?? [];
      for (const direction of ['conflict', 'push', 'pull'] as const) {
        const outcome = direction === 'conflict' ? 'conflict' : direction;
        const changed = fields.filter((field) => field.outcome === outcome);
        // With no `verbose` detail the report still knows the document is in the
        // bucket, so a row is emitted with no fields rather than dropped: "LP-9
        // has something to push" beats silence.
        const inBucket =
          direction === 'push'
            ? pending.has(localId)
            : direction === 'pull'
              ? report.behind.includes(localId)
              : report.conflicted.includes(localId);
        if (!inBucket) continue;
        if (changed.length === 0 && fields.length > 0) continue;
        rows.push({
          key: `${localId}:${direction}`,
          localId,
          title: this.#host.titleOf(localId),
          direction,
          blocked: direction === 'push' && blocked.has(localId),
          fields: changed.map((field) => ({
            field: field.field,
            local: formatValue(field.local),
            remote: formatValue(field.remote),
          })),
        });
      }
    }

    // A tracker issue with no document here is a pull too — it just creates
    // rather than updates, which is why it carries a remote key and no local id.
    for (const entry of report.incoming) {
      rows.push({
        key: `incoming:${entry.remoteId}`,
        localId: null,
        remoteKey: entry.remoteKey,
        title: entry.title,
        direction: 'create',
        blocked: false,
        fields:
          entry.parentLocalId !== undefined
            ? [{ field: 'parent', local: '—', remote: entry.parentLocalId }]
            : [],
      });
    }

    // Conflicts first (only a person can settle them), then work coming down,
    // then work going up — and **blocked rows last whatever their direction**.
    // Without that clause the table was sorted by id inside `push`, so on a board
    // with 428 blocked documents and 5 real ones the first page was 40 rows of
    // "cannot be written" and not one thing anybody could act on. The blocked
    // rows are still here, because the table is where the *reason* lives; they
    // are simply not what a reader is shown first.
    const order: Record<ChangeRow['direction'], number> = { conflict: 0, pull: 1, create: 2, push: 3 };
    return rows.sort(
      (a, b) =>
        Number(a.blocked) - Number(b.blocked) ||
        order[a.direction] - order[b.direction] ||
        (a.localId ?? a.remoteKey ?? '').localeCompare(b.localId ?? b.remoteKey ?? ''),
    );
  }

  /** Why each blocked document cannot land, keyed by local id. */
  get blockedReasons(): ReadonlyMap<string, string> {
    const report = this.report;
    const reasons = new Map<string, string>();
    for (const entry of report?.blocked ?? []) {
      reasons.set(entry.localId, entry.fields.map((field) => `${field.field}: ${field.reason}`).join(', '));
    }
    return reasons;
  }

  /**
   * The blocked documents grouped by *cause*, with what to do about each.
   *
   * 428 rows saying "cannot be written" is not a report, it is the same sentence
   * 428 times. There are only ever a handful of distinct causes — on the board
   * this was built for, five — and each one has a different answer: a person
   * missing an account value is one edit away from working, a generic pool is
   * something no tracker can assign at all. So the panel shows the causes, how
   * many documents each holds, and the remedy; the ids are there to select on
   * the canvas once somebody wants them.
   */
  get blockedGroups(): BlockedGroup[] {
    const groups = new Map<string, BlockedGroup>();
    for (const entry of this.report?.blocked ?? []) {
      for (const field of entry.fields) {
        const key = `${field.field}\u0000${field.reason}`;
        const group = groups.get(key);
        if (group) group.localIds.push(entry.localId);
        else {
          groups.set(key, {
            key,
            field: field.field,
            reason: field.reason,
            ...(field.remedy !== undefined ? { remedy: field.remedy } : {}),
            localIds: [entry.localId],
          });
        }
      }
    }
    // Biggest cause first: it is the one worth fixing.
    return [...groups.values()].sort((a, b) => b.localIds.length - a.localIds.length);
  }

  /**
   * The counts that lead: what somebody can act on right now.
   *
   * `behind` and `incoming` are both news from the tracker and are shown together
   * for that reason — but they stay two numbers, because the actions differ: one
   * *updates* a document that exists on both sides, the other *creates* one the
   * board has never had.
   */
  get primaryTiles(): Array<DriftTile & { id: ChangeFilter }> {
    const checked = this.#checked;
    return [
      {
        id: 'pending',
        label: 'to push',
        // **Unknown until the tracker has been read, like the other two.**
        // Offline, `ahead` is only "differs from its base snapshot": a stale
        // base both sides already agree on counts there, and so does a field
        // this remote does not carry. On this repository's board that is 48
        // against the 5 a sync would write — so showing it under "to push"
        // was not a rough answer, it was a different question, and the tile
        // dropping from 48 to 5 when the check landed read as a bug in the
        // count. The component already says a number the tracker has not
        // answered is `—`; this tile was the one breaking that rule.
        count: checked ? this.countOf('pending') : null,
        hint: 'Changed on the board since the last sync',
      },
      {
        id: 'behind',
        label: 'to pull',
        count: checked ? this.countOf('behind') + this.incoming.length : null,
        hint: 'Changed on the tracker since the last sync',
      },
      {
        id: 'conflicted',
        label: 'conflicts',
        count: checked ? this.countOf('conflicted') : null,
        hint: 'Same field changed on both sides — resolve manually',
      },
    ];
  }

  /**
   * True, worth knowing, and not what a reader should be steered to first.
   *
   * Typed as board-id buckets only, so the component can select them on the
   * canvas without a branch: `incoming` has no local ids and belongs to the
   * primary row, where the tile opens a list instead.
   */
  get secondaryTiles(): Array<DriftTile & { id: DriftBucket }> {
    return [
      {
        id: 'blocked',
        // **Causes, not documents.** One person with no account value held back
        // 220 documents on the board this was built for, and 392 was the number
        // on screen — which reads as a mirror in serious trouble when the truth
        // is four things to fix, one of them a single missing email. The count a
        // reader should act on is how many *decisions* are waiting, and the
        // documents are the size of each one, not the size of the problem.
        label: 'to fix',
        // Blocked is a subset of `ahead`, so it inherits `ahead`'s honesty:
        // unknown until the tracker has been read.
        count: this.#checked ? this.blockedGroups.length : null,
        hint: `${this.countOf('blocked')} edits this remote cannot store, from ${this.blockedGroups.length} causes`,
      },
      {
        id: 'unlinked',
        label: 'not synced',
        count: this.countOf('unlinked'),
        hint: 'Never pushed to the tracker',
      },
      {
        id: 'orphaned',
        label: 'orphaned',
        count: this.countOf('orphaned'),
        hint: 'Linked, but the local document was deleted',
      },
    ];
  }

  /** Select the issues in one drift bucket on the canvas. */
  selectBucket(bucket: DriftBucket): void {
    this.#host.select(this.idsOf(bucket));
  }

  /**
   * Answer a primary tile: narrow the changes table to it, and select what it
   * names on the canvas.
   *
   * The narrowing is the part that answers the question. Selecting on the
   * canvas is a bonus that only shows when those documents happen to be in the
   * view, which on a board of any size they usually are not — a tile that did
   * only that read as a button that does nothing.
   *
   * Clicking the tile that is already on clears it, so the same click both
   * asks and un-asks.
   */
  focusChanges(filter: ChangeFilter): void {
    this.changeFilter = this.changeFilter === filter ? null : filter;
    if (this.changeFilter !== null) this.selectBucket(filter);
  }

  /** Show everything the sync would do again. */
  clearChangeFilter(): void {
    this.changeFilter = null;
  }

  /** How many rows the table holds with no filter — the "of N" in its header. */
  get changeTotal(): number {
    return this.#allChangeRows().length;
  }

  /** Show one document on the canvas — a row in the changes table. */
  selectDocument(id: string): void {
    this.#host.select([id]);
  }

  /** Show a group of documents on the canvas — one cause in the blocked list. */
  selectDocuments(ids: readonly string[]): void {
    this.#host.select([...ids]);
  }

  /**
   * Remote issues with no local document, newest question first.
   *
   * Empty until the tracker has been read, which is not the same claim as
   * "nothing arrived" — `checked` is how the panel tells those apart, exactly
   * as it does for `behind`.
   */
  get incoming(): readonly RemoteStatusIncoming[] {
    return this.report?.incoming ?? [];
  }

  /** How many remote issues the last full read saw, for the "what did it cost" line. */
  get remoteRead(): number | null {
    return this.report?.remoteRead ?? null;
  }

  /**
   * Adopt incoming work: a targeted pull of the remote ids named.
   *
   * Targeted by **remote** id, which is what makes the run `partial` — it
   * fetches what it asked for and infers nothing from what it did not look
   * for. That matters more here than anywhere else: these are issues with no
   * twin, so a run that read absence as deletion would be reasoning about the
   * whole tracker from a list of the few things somebody ticked.
   *
   * With no ids it adopts everything incoming, which is the ordinary case —
   * somebody added three stories upstream and wants all three.
   */
  async pullIncoming(name: string, remoteIds?: readonly string[]): Promise<void> {
    const wanted = remoteIds ?? this.incoming.map((entry) => entry.remoteId);
    if (wanted.length === 0) return;
    await this.#run(name, { direction: 'pull', pullIds: [...wanted], yes: true });
  }

  /**
   * One document's standing on the badge remote, for the side panel.
   *
   * Read off the same report the canvas badges are drawn from, so the panel
   * and the badge can never say different things about the same document.
   * `null` when no remote is being watched or its report has not been read —
   * which the panel shows as nothing at all, rather than as "not mirrored".
   */
  documentRemote(id: string): DocumentRemoteState | null {
    const name = this.badgeRemote;
    if (name === null) return null;
    const report = this.reports[name];
    if (report === undefined) return null;
    return {
      remoteName: name,
      link: report.links?.[id] ?? null,
      ahead: report.ahead.includes(id),
      behind: report.behind.includes(id),
      conflicted: report.conflicted.includes(id),
    };
  }

  // -- coverage: what the mirror is missing around what it holds ------------

  /** The coverage report for the remote the panel is looking at, when read. */
  get coverageReport(): RemoteCoverageReport | null {
    return this.selected ? (this.coverage[this.selected] ?? null) : null;
  }

  /**
   * Read one remote's coverage report.
   *
   * Deliberately not folded into `loadStatus`: coverage is offline and
   * immediate, drift reads every twin upstream. A gap list that waited for the
   * tracker would be useless exactly when it is most wanted — on a big board,
   * halfway through filing it.
   */
  async loadCoverage(name: string): Promise<void> {
    if (!this.enabled) return;
    this.coverageLoading = true;
    try {
      const report = await this.#api.remoteCoverage(name);
      this.coverage = { ...this.coverage, [name]: report };
      this.coverageError = { ...this.coverageError, [name]: '' };
      this.#prunePicked();
    } catch (error) {
      // Reported *and* kept: a notice is gone in a few seconds, and a panel
      // that shows nothing with no reason is the complaint this answers.
      this.coverageError = { ...this.coverageError, [name]: describeError(error) };
      this.#host.report(error);
    } finally {
      this.coverageLoading = false;
    }
  }

  /**
   * What is missing around one document, for the side panel.
   *
   * Read off the report the drawer is showing rather than computed again, so
   * the two cannot disagree — the same rule `documentRemote` follows for drift.
   */
  gapsFor(id: string): CoverageGap[] {
    const name = this.badgeRemote;
    const report = name ? (this.coverage[name] ?? null) : null;
    return report === null ? [] : gapsAround(report, id);
  }

  /** The gaps ticked for pushing, in the report's order. */
  get pickedIds(): string[] {
    const report = this.coverageReport;
    if (report === null) return [];
    return report.gaps.map((gap) => gap.id).filter((id) => this.picked[id] === true);
  }

  /** Tick or untick one gap. */
  pick(id: string, on?: boolean): void {
    const next = on ?? this.picked[id] !== true;
    this.picked = { ...this.picked, [id]: next };
  }

  /** Tick every gap in one group — "select all of these". */
  pickGroup(relation: CoverageRelation, on = true): void {
    const report = this.coverageReport;
    if (report === null) return;
    const ids = report.groups.find((group) => group.relation === relation)?.ids ?? [];
    const next = { ...this.picked };
    for (const id of ids) next[id] = on;
    this.picked = next;
  }

  /** Untick everything. */
  pickNone(): void {
    this.picked = {};
  }

  /**
   * Push the ticked gaps, and nothing else.
   *
   * They travel as `only`, the selection spelling: filing the missing stories
   * of one feature must not tell the planner that the rest of the board has
   * left the mirror. Order inside the selection does not matter — a parent
   * ticked alongside its children is created first and the children are filed
   * under it in the same run.
   */
  async pushPicked(): Promise<void> {
    const ids = this.pickedIds;
    if (ids.length === 0) return;
    await this.pushDocuments(ids);
    this.pickNone();
  }

  /** Show the ticked gaps on the canvas. */
  selectPicked(): void {
    this.#host.select(this.pickedIds);
  }

  /** Forget ticks for documents the latest report no longer calls gaps. */
  #prunePicked(): void {
    const report = this.coverageReport;
    if (report === null) return;
    const gaps = new Set(report.gaps.map((gap) => gap.id));
    this.picked = Object.fromEntries(
      Object.entries(this.picked).filter(([id, on]) => on === true && gaps.has(id)),
    );
  }

  // -- readiness: what a push is about to get wrong --------------------------

  /** Ask the check; `null` when it could not be run at all. */
  async #checkReadiness(
    name: string,
    body: RemoteSyncRequestDto,
  ): Promise<RemoteReadinessReport | null> {
    this.readinessChecking = true;
    try {
      return await this.#api.remoteReadiness(name, {
        ...(body.only !== undefined && body.only.length > 0 ? { only: body.only } : {}),
      });
    } catch (error) {
      // A check that cannot run must not stop a push: the engine still refuses
      // what it cannot carry, and a person who pressed Push deserves either
      // the answer or the push, never silence.
      this.#host.report(error);
      return null;
    } finally {
      this.readinessChecking = false;
    }
  }

  /** What one finding will do if the push goes ahead as chosen. */
  choiceFor(key: string): 'ignore' | 'fix' {
    return this.readinessChoice[key] ?? 'ignore';
  }

  /** Choose what to do about one finding. */
  chooseReadiness(key: string, choice: 'ignore' | 'fix'): void {
    this.readinessChoice = { ...this.readinessChoice, [key]: choice };
  }

  /** Choose which remote person a `link_account` fix will write. */
  chooseCandidate(key: string, value: string): void {
    this.readinessCandidate = { ...this.readinessCandidate, [key]: value };
  }

  /**
   * True while something that blocks is unanswered.
   *
   * A `degrades` finding may be ignored — that is the ordinary case and the
   * push heals it later. A `blocks` one is the board contradicting itself, and
   * no amount of pushing will make it right, so it has to be fixed before the
   * push can go anywhere.
   */
  get readinessBlocked(): boolean {
    const report = this.readiness;
    if (report === null) return false;
    return report.findings.some(
      (finding) =>
        finding.severity === 'blocks' &&
        (this.choiceFor(finding.key) !== 'fix' || finding.fix === undefined),
    );
  }

  /**
   * Apply what was chosen, then run the push that was held back.
   *
   * Three kinds of answer, and they are applied in the order that makes each
   * of them true at the moment the push runs: the board edits first (an
   * account written onto a person is only any use if it is on disk before the
   * translator reads the roster), then the periods, which are not edits at all
   * — naming one widens the push, exactly as `lpm remote push TL-3` does.
   */
  async proceedReadiness(): Promise<void> {
    const report = this.readiness;
    const held = this.#held;
    if (report === null || held === null || this.readinessBlocked) return;

    const fixes: ReadinessFixRequest[] = [];
    const periods: string[] = [];
    for (const finding of report.findings) {
      if (this.choiceFor(finding.key) !== 'fix' || finding.fix === undefined) continue;
      const fix = finding.fix;
      if (fix.kind === 'link_account') {
        const value = this.readinessCandidate[finding.key];
        if (value === undefined || value === '') continue; // nothing chosen: nothing to write
        fixes.push({ kind: 'link_account', resourceId: fix.resourceId, via: fix.via, value });
      } else if (fix.kind === 'unassign') {
        fixes.push({ kind: 'unassign', issueIds: fix.issueIds });
      } else {
        periods.push(fix.periodId);
      }
    }

    if (fixes.length > 0) {
      try {
        const result = await this.#api.remoteReadinessFix(held.name, { fixes });
        this.#host.notify('info', `Fixed ${result.changed.length} before pushing`, result.changed);
        // The board changed underneath the working copy; re-read it before the
        // push replays anything, or the canvas keeps showing what was true a
        // moment ago.
        await this.#host.refresh();
      } catch (error) {
        this.#host.report(error);
        return;
      }
    }

    const body: RemoteSyncRequestDto =
      periods.length > 0 && held.body.only !== undefined
        ? { ...held.body, only: [...held.body.only, ...periods] }
        : periods.length > 0
          ? { ...held.body, only: periods }
          : held.body;

    this.dismissReadiness();
    await this.#run(held.name, body, true);
  }

  /** Cancel: the held push is dropped and nothing is written. */
  dismissReadiness(): void {
    this.readiness = null;
    this.readinessChoice = {};
    this.readinessCandidate = {};
    this.#held = null;
  }

  /**
   * Load the remote list and every remote's drift report, then publish the
   * badge map. Idempotent: later calls refresh rather than duplicate.
   */
  async load(): Promise<void> {
    // Read untracked. `load` is called from an effect, and a tracked read of
    // `loading` made that effect depend on it: every load that finished set
    // `loading` back to false, which ran the effect, which loaded again. On a
    // board with no remotes that was a hundred requests a second and a Sync tab
    // stuck on "Loading remotes…"; on a board mirroring a real tracker it was
    // the whole drift report read again every time the last one came back.
    if (!this.enabled || untrack(() => this.loading)) return;
    this.loading = true;
    try {
      this.remotes = await this.#api.listRemotes();
      if (this.badgeRemote === null) this.badgeRemote = this.remotes[0]?.name ?? null;
      if (this.selected === null) this.selected = this.remotes[0]?.name ?? null;
      // Coverage first and unawaited: it answers offline in milliseconds while
      // the drift report below reads every twin upstream.
      if (this.selected !== null) void this.loadCoverage(this.selected);
      // The local half only: no credential, no request, and it paints the panel
      // before anything goes out to a tracker. `load` is also what runs after a
      // remote is connected or removed, where an automatic tracker read is not
      // what anybody asked for — opening a *view* is, and that is `autoCheck`.
      await Promise.all(this.remotes.map((remote) => this.loadStatus(remote.name)));
      this.#publishBadges();
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Read the **local** half of one remote's report and republish badges.
   *
   * Instant: the board and the link store answer it, so it is what the tab
   * reads on open, whenever the board changes underneath it, and after every
   * sync. It knows which documents have twins and which have been edited here
   * since the last sync; what it cannot know is what moved upstream, which is
   * `checkDrift`.
   *
   * **It never throws away a full answer it already has.** Whatever the
   * tracker last said — in memory from this session's check, or read back
   * from `localStorage` from an earlier one — is blended back in by
   * `withCachedRemoteHalf`. That is load-bearing rather than an
   * optimisation: this method is called from five places (the open, the board
   * poll, a sync, a conflict resolution, a remote switch), and while it
   * replaced the report outright, any one of them landing after a check threw
   * the checked numbers away and put the local half's much larger `ahead`
   * count back on screen seconds later — which is exactly what "it said 5 to
   * push and then went back to 48" was.
   */
  async loadStatus(name: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const report = await this.#api.remoteStatus(name, { local: true });
      const known = this.#fullReportFor(name);
      if (known !== null) {
        this.reports = { ...this.reports, [name]: withCachedRemoteHalf(report, known.report) };
        this.statusMode = { ...this.statusMode, [name]: 'full' };
        this.driftCachedAt = { ...this.driftCachedAt, [name]: known.checkedAt };
      } else {
        this.reports = { ...this.reports, [name]: report };
        this.statusMode = { ...this.statusMode, [name]: 'local' };
      }
      this.#publishBadges();
    } catch (error) {
      this.#host.report(error);
    }
  }

  /**
   * The best full report this session has for one remote: the one on screen
   * if it has been out to the tracker, otherwise whatever `localStorage`
   * kept from an earlier session.
   *
   * In-memory first, because a browser that refuses to store anything (a
   * private window, blocked site data, a full quota) must not lose a check
   * somebody just waited for — the cache makes the answer survive a reload,
   * it is not what makes it survive the next five seconds.
   */
  #fullReportFor(name: string): CachedStatus | null {
    const live = this.reports[name];
    if (live !== undefined && this.statusMode[name] === 'full') {
      return { report: live, checkedAt: this.driftCachedAt[name] ?? new Date().toISOString() };
    }
    return readCachedStatus(name);
  }

  /**
   * Go and ask the tracker what has changed — the half that needs the network.
   *
   * **One paginated listing**, not one request per twin. It used to be the
   * latter: 537 sequential requests on this repository's own board, about two
   * minutes, behind a single line of grey text that was indistinguishable from
   * a hang. It is now seconds, and it learns something the per-twin loop never
   * could — the remote issues that have no twin at all.
   *
   * Still a click rather than something the tab does on open, because it needs
   * a credential and can fail, and everything about it stays on screen while it
   * runs: that it is running, how long it has been going, and the error if it
   * fails. `cancelDrift` gives up on it.
   */
  async checkDrift(name: string): Promise<void> {
    if (this.driftState[name] === 'reading') return;
    const controller = new AbortController();
    this.#drift.set(name, controller);
    this.driftState = { ...this.driftState, [name]: 'reading' };
    this.driftStarted = { ...this.driftStarted, [name]: Date.now() };
    this.driftError = { ...this.driftError, [name]: '' };
    try {
      // `verbose` brings the per-field detail the changes table is built from.
      const report = await this.#api.remoteStatus(name, {
        verbose: true,
        signal: controller.signal,
      });
      const checkedAt = new Date().toISOString();
      this.reports = { ...this.reports, [name]: report };
      this.statusMode = { ...this.statusMode, [name]: 'full' };
      this.driftState = { ...this.driftState, [name]: 'idle' };
      this.driftCachedAt = { ...this.driftCachedAt, [name]: checkedAt };
      // A real, live read is exactly what the next open should not have to
      // pay for again — write it down so `loadStatus` can hand it back.
      writeCachedStatus(name, report, checkedAt);
      this.#publishBadges();
    } catch (error) {
      if (controller.signal.aborted) {
        this.driftState = { ...this.driftState, [name]: 'idle' };
      } else {
        this.driftState = { ...this.driftState, [name]: 'failed' };
        this.driftError = { ...this.driftError, [name]: describeError(error) };
      }
    } finally {
      this.#drift.delete(name);
    }
  }

  /**
   * Start the tracker read for the remote on screen, because somebody opened a
   * view and will want the Sync tab to be current.
   *
   * This used to be a click and nothing else: the remote half was one request per
   * twin — 115 seconds against a 537-issue mirror — which is not something a board
   * may do on open. It is now a single paginated listing, about 9 seconds on that
   * same board, so the reason for withholding it has gone, and asking somebody to
   * press a button to find out whether their mirror moved is a step with no
   * decision in it.
   *
   * Four things keep it honest, and they are why this is a separate call rather
   * than a line inside `load`. It is **not awaited** by its caller, so the panel
   * is usable while it runs. It reads **only the selected remote** — checking five
   * mirrors on open would be five trackers' worth of latency nobody asked for. It
   * runs **once** per remote per session (`hasDrift`), so switching tabs does not
   * re-read. And it goes through `checkDrift` unchanged, so the clock, the error
   * surface and the Stop button all still apply: this is the act a person would
   * have performed, started on their behalf.
   *
   * `load` deliberately does not call it: `load` also runs after a remote is
   * connected or removed, and a tracker read is not implied by either.
   */
  async autoCheck(): Promise<void> {
    const name = this.selected;
    if (name === null) return;
    if (this.hasDrift(name) || this.driftState[name] === 'reading') return;
    // A failed read stays failed until somebody presses Try again; retrying it on
    // every tab change would turn one bad credential into a request loop.
    if (this.driftState[name] === 'failed') return;
    await this.checkDrift(name);
  }

  /** Give up on a running remote-half read. The local report stands. */
  cancelDrift(name: string): void {
    this.#drift.get(name)?.abort();
  }

  /**
   * True when this remote's report has been out to the tracker — live this
   * session, or read back from `loadStatus`'s cache. Either way `autoCheck`
   * has nothing left to do, which is the whole point of caching the answer:
   * a mirror that has not moved should not cost a request just because the
   * tab was closed and reopened.
   */
  hasDrift(name: string): boolean {
    return this.statusMode[name] === 'full';
  }

  /** Drop the cached full report — a sync just made it stale, or the remote is gone. */
  #forgetCachedDrift(name: string): void {
    clearCachedStatus(name);
    if (this.driftCachedAt[name] === undefined) return;
    const next = { ...this.driftCachedAt };
    delete next[name];
    this.driftCachedAt = next;
  }

  /** True when the remote driving the canvas has been checked upstream. */
  get badgeChecked(): boolean {
    return this.badgeRemote !== null && this.hasDrift(this.badgeRemote);
  }

  /**
   * Whether the report on screen has a remote half at all — the one question
   * behind every "is this a number or a `—`?" on the panel.
   *
   * One definition, because the tiles, the chips and the changes table all ask
   * it and a panel where the count said 48 and the table listed 48 rows while
   * the two beside them said `—` was telling a reader two different stories
   * about the same report.
   */
  get #checked(): boolean {
    return this.badgeChecked || (this.selected !== null && this.hasDrift(this.selected));
  }

  /** How many twins a remote-half read would have to fetch, from coverage. */
  twinCount(name: string): number {
    return this.coverage[name]?.mirrored ?? 0;
  }

  /** In-flight remote-half reads, so one can be cancelled. */
  #drift = new Map<string, AbortController>();

  /** Look at one remote: switch the panel and the canvas badges to it. */
  select(name: string): void {
    if (this.selected === name) return;
    this.selected = name;
    this.badgeRemote = name;
    // A preview or a result is about the remote that produced it; switching
    // away must not leave another remote's answer on the panel.
    this.previewResult = null;
    this.syncResult = null;
    // Ticked gaps belong to the remote they were ticked on; a push of them
    // against another remote is the one-document-one-remote rule broken.
    this.pickNone();
    // The table is about the remote that was on screen; carrying its filter
    // over would narrow another remote's changes by a question nobody asked.
    this.changeFilter = null;
    this.#publishBadges();
    if (!this.reports[name]) void this.loadStatus(name);
    if (!this.coverage[name]) void this.loadCoverage(name);
    // Looking at a remote is asking about it, so the tracker read starts here too
    // — once per remote, because `hasDrift` is already true the second time and
    // `checkDrift` returns early while one is in flight.
    void this.autoCheck();
  }

  /**
   * Re-read the remote list — after a remote was connected, edited or removed.
   *
   * Not `load()`: that refuses to start while a load is under way, and a drift
   * report against a large tracker holds one open for minutes, so a remote
   * connected in the meantime would not appear until somebody pressed Refresh.
   * This reads only the list, forgets the reports of remotes that are gone,
   * keeps the selection on a remote that still exists, and — when `name` is
   * given — selects it with its report read afresh, since a connection that
   * just changed makes any report about it stale.
   */
  async refreshRemotes(name?: string): Promise<void> {
    if (!this.enabled) return;
    try {
      this.remotes = await this.#api.listRemotes();
    } catch (error) {
      this.#host.report(error);
      return;
    }
    const names = new Set(this.remotes.map((summary) => summary.name));
    const keep = (key: string): boolean => names.has(key) && key !== name;
    // A removed remote's cache is dead weight; a re-selected one's is stale
    // the moment its connection changed — either way, `#forgetCachedDrift`
    // covers both `driftCachedAt` and the `localStorage` entry behind it.
    for (const key of Object.keys(this.reports)) {
      if (!keep(key)) this.#forgetCachedDrift(key);
    }
    this.reports = Object.fromEntries(Object.entries(this.reports).filter(([key]) => keep(key)));
    this.coverage = Object.fromEntries(Object.entries(this.coverage).filter(([key]) => keep(key)));
    this.statusMode = Object.fromEntries(Object.entries(this.statusMode).filter(([key]) => keep(key)));
    this.driftState = Object.fromEntries(Object.entries(this.driftState).filter(([key]) => keep(key)));
    this.driftError = Object.fromEntries(Object.entries(this.driftError).filter(([key]) => keep(key)));
    if (this.selected !== null && !names.has(this.selected)) this.selected = null;
    if (this.badgeRemote !== null && !names.has(this.badgeRemote)) this.badgeRemote = null;

    if (name !== undefined && names.has(name)) {
      // `select` does nothing for the remote already selected; clear it so the
      // report is read again.
      this.selected = null;
      this.select(name);
      return;
    }

    const first = this.remotes[0]?.name ?? null;
    if (this.selected === null) this.selected = first;
    if (this.badgeRemote === null) this.badgeRemote = first;
    this.#publishBadges();
    if (this.badgeRemote !== null && !this.reports[this.badgeRemote]) void this.loadStatus(this.badgeRemote);
  }

  /** The badge one node carries, from the remote driving the canvas. */
  badgeOf(id: string): SyncBadge | null {
    const report = this.badgeRemote ? (this.reports[this.badgeRemote] ?? null) : null;
    if (!report) return null;
    return syncBadgeOf(report, id);
  }

  /** Recompute the whole badge map from the badge remote and hand it to the host. */
  #publishBadges(): void {
    const report = this.badgeRemote ? (this.reports[this.badgeRemote] ?? null) : null;
    if (!report) {
      this.#host.setSyncBadges({});
      return;
    }
    const ids = new Set<string>([
      ...report.conflicted,
      ...report.ahead,
      ...report.behind,
      ...report.unlinked,
    ]);
    const badges: Record<string, SyncBadge> = {};
    for (const id of ids) {
      const badge = syncBadgeOf(report, id);
      if (badge !== 'in-sync') badges[id] = badge;
    }
    this.#host.setSyncBadges(badges);
  }

  /**
   * Run the dry-run for one remote and hold its render for the panel.
   *
   * Returns false when the server refused, so the component can stay silent
   * rather than drawing an empty preview.
   */
  async preview(name: string): Promise<boolean> {
    this.previewing = true;
    this.previewResult = null;
    try {
      this.previewResult = await this.#api.remotePreview(name);
      return true;
    } catch (error) {
      this.#host.report(error);
      return false;
    } finally {
      this.previewing = false;
    }
  }

  /**
   * Send the whole remote's pending changes to the tracker — the board is
   * ahead, the tracker is not.
   *
   * The button is the confirmation (LP-350): the panel shows the remote's
   * target and a Preview is one click away, so a person clicking Push has
   * seen what they are writing to. The engine's consent gate is still in
   * force for every caller that does not pass `yes`. Streaming, the drift
   * re-read afterwards and the dirty-view refusal are all `#run`'s, shared
   * with every other push this panel can start.
   */
  async push(name: string): Promise<void> {
    await this.#run(name, { direction: 'push', yes: true });
  }

  /**
   * Bring the whole remote's changes into the board — the tracker is ahead,
   * the board is not.
   *
   * A pull writes nothing upstream, so `#run` skips the readiness gate for
   * it; the dirty-view refusal still applies, because a pull that landed
   * over queued edits would let the two queues disagree about what is true.
   */
  async pull(name: string): Promise<void> {
    await this.#run(name, { direction: 'pull', yes: true });
  }

  /**
   * Push these documents, and nothing else.
   *
   * The ids travel as `only`, which acts on **exactly** what it names. The
   * other spelling, `scope`, names a subtree *root* and expands to everything
   * inside it — so the two are not interchangeable, and sending the wrong one
   * turns "push this story" into "push this feature and all of it".
   */
  async pushDocuments(ids: string[]): Promise<void> {
    const name = this.badgeRemote;
    if (name === null || ids.length === 0) return;
    await this.#run(name, { direction: 'push', only: [...ids], yes: true });
  }

  /**
   * Pull these documents' twins.
   *
   * Named by **remote** id, which makes the run a targeted one: it fetches
   * what it asked for and infers nothing from what it did not look for. A
   * `scope` of one document would instead be a complete listing of a
   * one-document world, where a single missing twin is 100% of it and the bulk
   * guard declines the whole pull.
   *
   * A document with no twin is not a smaller pull, it is nothing to pull, so
   * the caller filters first and an empty list does nothing at all.
   */
  async pullDocuments(ids: string[]): Promise<void> {
    const name = this.badgeRemote;
    if (name === null) return;
    const remoteIds = ids
      .map((id) => this.documentRemote(id)?.link?.remoteId)
      .filter((remoteId): remoteId is string => remoteId !== undefined && remoteId !== '');
    if (remoteIds.length === 0) return;
    await this.#run(name, { direction: 'pull', pullIds: remoteIds, yes: true });
  }

  /**
   * Push one document, and optionally everything under it — the side panel's
   * two buttons. "With children" is the one case that genuinely wants `scope`.
   */
  async pushDocument(id: string, options: { children?: boolean } = {}): Promise<void> {
    if (options.children !== true) {
      await this.pushDocuments([id]);
      return;
    }
    const name = this.badgeRemote;
    if (name === null) return;
    await this.#run(name, { direction: 'push', scope: id, yes: true });
  }

  /** Pull one document's twin. */
  async pullDocument(id: string): Promise<void> {
    await this.pullDocuments([id]);
  }

  /**
   * One run, whatever named it: the whole remote, one document, or a subtree.
   *
   * Everything a sync has to get right sits here once — the dirty-view
   * refusal, the single-run latch, the streamed progress, the refresh
   * afterwards and the re-read of the drift report — so a per-document push
   * cannot quietly skip a guard the Push and Pull buttons honour.
   */
  async #run(name: string, body: RemoteSyncRequestDto, checked = false): Promise<void> {
    if (this.syncing) return;
    // Never sync over a dirty view: the queued edits and the remote's pending
    // sync are two queues at different layers, and merging them is refused
    // rather than reconciled.
    if (this.#host.dirty()) {
      this.#host.notify('error', 'Push your edits to the board before syncing');
      return;
    }
    // The readiness gate. Every push path lands here — the Push button, the
    // Coverage list, the side panel, the canvas menu — so the question is
    // asked once, in one place, and no caller can skip it by accident. A pull
    // writes nothing upstream and is not gated.
    if (!checked && body.direction !== 'pull') {
      const report = await this.#checkReadiness(name, body);
      if (report !== null && report.findings.length > 0) {
        this.readiness = report;
        this.readinessChoice = {};
        this.readinessCandidate = defaultCandidates(report.findings);
        this.#held = { name, body };
        return;
      }
    }

    this.syncing = true;
    this.syncDirection = body.direction === 'pull' ? 'pull' : body.direction === 'push' ? 'push' : null;
    this.progress = null;
    this.syncResult = null;
    this.#touched = [];
    try {
      await this.#api.remoteSync(name, body, (event) => this.#onEvent(event));
      if (this.syncResult) {
        this.#host.notify('info', summarizeSync(this.syncResult));
        await this.#host.refresh();
        // The run has just settled these documents, and no local read can
        // work that out — only the tracker knows a pulled issue is no longer
        // behind. So they come out of the full answer by id, which is the run
        // reporting what it touched. Throwing the whole cache away instead
        // was the first attempt and it was worse than the bug: with nothing
        // cached the panel falls back to the local half, so pushing one
        // document sent "to push" from 5 to 48.
        this.#pruneDrift(name, this.#touched);
      }
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.syncing = false;
      // Both halves of "how is the mirror doing" are stale after a run: the
      // report because documents were written, and coverage because the gaps
      // just filed are gaps no longer. Both of these are the *local* reads —
      // re-fetching every twin from the tracker after every sync is two
      // minutes of requests nobody asked for, and the run itself has just
      // said what it wrote.
      await Promise.all([this.loadStatus(name), this.loadCoverage(name)]);
    }
  }

  /** The documents the running sync has reported acting on, for `#pruneDrift`. */
  #touched: string[] = [];

  #onEvent(event: RemoteSyncEventDto): void {
    if (event.type === 'progress') {
      this.progress = { index: event.index, total: event.total, kind: event.kind, localId: event.localId };
      if (event.localId !== '') this.#touched.push(event.localId);
    } else if (event.type === 'done') {
      this.syncResult = event.result;
    } else {
      this.#host.notify('error', event.error, event.details);
    }
  }

  /**
   * Take the documents a run just settled out of the full answer — both the
   * copy on screen and the one in `localStorage`, so a reload agrees with
   * what the panel already shows.
   */
  #pruneDrift(name: string, touched: readonly string[]): void {
    if (touched.length === 0) return;
    const live = this.reports[name];
    if (live !== undefined && this.statusMode[name] === 'full') {
      this.reports = { ...this.reports, [name]: pruneCachedStatus(live, touched) };
      this.#publishBadges();
    }
    const cached = readCachedStatus(name);
    if (cached !== null) {
      writeCachedStatus(name, pruneCachedStatus(cached.report, touched), cached.checkedAt);
    }
  }

  // -- conflict resolution (the side panel) ---------------------------------

  /** True while the view has queued edits — the Sync button is disabled. */
  get syncBlocked(): boolean {
    return this.#host.dirty();
  }

  /**
   * A remote is being watched but even its local report has not arrived.
   *
   * Worth its own name because `documentRemote` answers `null` throughout, and
   * shown as nothing that reads as "this document is not mirrored", which is
   * false — the panel and the menu say "reading the remote" instead. It is now
   * a flicker rather than a wait: the local half is the board and the link
   * store, and only `checkDrift` goes out to the tracker (which on a 537-issue
   * Jira project measured 115 seconds, one request per twin).
   */
  get reportPending(): boolean {
    return this.badgeRemote !== null && this.reports[this.badgeRemote] === undefined;
  }

  /** Write the queued edits to the board, the remedy the panel offers. */
  async pushFirst(): Promise<void> {
    await this.#host.push();
  }

  /**
   * Fetch the conflict detail for one document on the badge remote.
   *
   * A non-conflicted document returns nothing (the endpoint 404s, which is the
   * ordinary case), so the panel stays silent rather than reporting an error.
   */
  async loadConflict(id: string): Promise<void> {
    const name = this.badgeRemote;
    this.conflictFor = id;
    if (!name) {
      this.conflictDetail = null;
      this.conflictLoading = false;
      return;
    }
    this.conflictLoading = true;
    try {
      const detail = await this.#api.remoteConflict(name, id);
      if (this.conflictFor === id) this.conflictDetail = detail;
    } catch {
      if (this.conflictFor === id) this.conflictDetail = null;
    } finally {
      if (this.conflictFor === id) this.conflictLoading = false;
    }
  }

  /** Drop whatever conflict detail the panel was showing. */
  clearConflict(): void {
    this.conflictFor = null;
    this.conflictDetail = null;
    this.conflictLoading = false;
  }

  /**
   * Record one field's winner.  Offline: the resolve route writes the decision
   * and the next sync applies it — no request is fired at the remote.
   */
  async chooseField(field: string, owner: RemoteResolveOwner): Promise<void> {
    const name = this.badgeRemote;
    const id = this.conflictFor;
    if (!name || !id || this.conflictSaving) return;
    this.conflictSaving = true;
    try {
      await this.#api.resolve(name, { id, fields: { [field]: owner } });
      await this.loadConflict(id);
      await this.loadStatus(name);
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.conflictSaving = false;
    }
  }

  /** Record a whole-document winner for every conflicted field at once. */
  async chooseDefault(owner: RemoteResolveOwner): Promise<void> {
    const name = this.badgeRemote;
    const id = this.conflictFor;
    if (!name || !id || this.conflictSaving) return;
    this.conflictSaving = true;
    try {
      await this.#api.resolve(name, { id, default: owner });
      await this.loadConflict(id);
      await this.loadStatus(name);
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.conflictSaving = false;
    }
  }
}

const KEY = Symbol('remote');

export function provideRemoteState(state: RemoteState): RemoteState {
  return setContext(KEY, state);
}

export function useRemoteState(): RemoteState {
  return getContext<RemoteState>(KEY);
}
