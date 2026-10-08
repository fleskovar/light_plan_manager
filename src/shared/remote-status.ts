/**
 * The drift report `lpm remote status` computes and `--json` emits (LP-342).
 *
 * Pure data, no imports: the CLI, a CI script and the web panel consume one
 * shape.  The report is a *snapshot* — it never carries a queued edit or a
 * half-written document, only what the board, the link store and (when it can
 * be read) the remote side currently say about every document's drift.
 *
 * The five buckets the story names — `ahead`, `behind`, `conflicted`,
 * `unlinked`, `orphaned` — are lists of local ids.  A document can appear in
 * several of the first three (a title edited locally while a status moved
 * upstream is both `ahead` and `behind`); `unlinked` and `orphaned` are
 * mutually exclusive with the others by construction (one has no link, the
 * other no document).  `decoupled`, `unreadable` and `failed` carry the
 * documents the story's buckets deliberately leave out, so the report is the
 * whole truth rather than five convenient columns.
 *
 * `incoming` is the sixth and the only one **not** keyed by a local id, because
 * there is no local document yet: it is a remote issue nobody has pulled. Five
 * buckets keyed on what the board already knows could describe every kind of
 * drift except the commonest one on a shared tracker — somebody adding work
 * upstream.
 */

/**
 * The per-node sync badge the canvas draws: one of the five states the story
 * names, distilled from a drift report so a node can carry exactly one mark.
 *
 * `in-sync` is the default — the absence of drift — and the canvas draws no
 * mark for it; the other four are the reasons to look at a node.
 */
export type SyncBadge = 'in-sync' | 'ahead' | 'behind' | 'conflicted' | 'unlinked';

/** One field's three-way outcome, shown by `--verbose`. */
export interface RemoteStatusField {
  /** The board field: `title`, `body`, `status`, `assignee`, `period`, or an attribute name. */
  field: string;
  /** The local (board) value. Body is the raw text. */
  local: unknown;
  /** The remote value, translated back to board vocabulary. Body is the raw text. */
  remote: unknown;
  /** The base snapshot value; null when there was no base to compare against. */
  base: unknown;
  /**
   * What the merge decided: `push` (local edit not pushed), `pull` (remote
   * edit not pulled), `conflict` (both sides edited — a human must settle),
   * or `none` (the two sides agree).
   */
  outcome: 'none' | 'push' | 'pull' | 'conflict';
}

/** A linked document whose twin could not be read, with why. */
export interface RemoteStatusFailure {
  localId: string;
  remoteId: string;
  error: string;
}

/** The remote twin of one linked document, as the report carries it. */
export interface RemoteStatusLink {
  remoteId: string;
  remoteKey: string;
  remoteUrl: string;
}

/** A document deliberately decoupled — never fetched, never filed. */
export interface RemoteStatusDecoupled {
  localId: string;
  /** The tombstone's reason: `manual`, `out_of_scope`, or a policy reason. */
  reason: string;
  /** The last known remote key, empty when the document was never linked. */
  remoteKey: string;
}

/**
 * A remote issue with no local twin — work that arrived upstream.
 *
 * The other four buckets are keyed by *local* id, which is what made this case
 * invisible for as long as it was: somebody adds a story to a mirrored epic in
 * the tracker, and a report that only ever asked about documents it already
 * knew had no question it could put to the remote that would find it. `behind`
 * is a twin that moved; this is a twin that does not exist yet.
 *
 * It carries no local id because there is no local document, which is also why
 * `syncBadgeOf` never returns it — nothing on the canvas can wear it. A pull
 * adopts it: `planPull` plans a `create` and files it under `parentLocalId`.
 */
export interface RemoteStatusIncoming {
  /** The remote's own id, which is what a targeted pull takes. */
  remoteId: string;
  /** The human-readable key, e.g. `SCRUM-901`. */
  remoteKey: string;
  /** Full URL to the remote issue, or empty when the provider has none. */
  remoteUrl: string;
  /** The remote's title, as the provider's translator recovers it. */
  title: string;
  /**
   * The local document a pull would file this under — the twin of its nearest
   * mirrored ancestor. Absent when nothing above it is mirrored, in which case
   * a pull files it at the board's root (or under `--under`).
   */
  parentLocalId?: string;
}

/**
 * A document that is `ahead` **only** on fields this remote cannot accept.
 *
 * The distinction that makes `ahead` readable. A board assigned to a generic
 * pool, or to a person with no account on the tracker, is ahead on `assignee`
 * for ever: the next sync will try, the remote will refuse the field, and the
 * base will record it as unset so the next sync tries again. That is the right
 * behaviour — the moment somebody adds the account, the value lands — but it
 * means a permanent count that no amount of syncing reduces.
 *
 * On the board this came from that was **430 of 433 documents**, which made the
 * headline number worse than useless: it hid the three documents somebody could
 * actually do something about. So the blocked ones are named and counted apart,
 * with the reason, and the headline is what a sync will really write.
 *
 * Computed from the translator, which is pure — so this rides the *local* half
 * and needs no credential and no request.
 */
/** One field a remote will not take, why, and what a person can do about it. */
export interface RemoteStatusBlockedField {
  field: string;
  /** Why the remote will not take this value. */
  reason: string;
  /**
   * The change that would unblock it — on the board, or on the mapping.
   *
   * A reason on its own tells somebody they have a problem and not what to do
   * with it: "Web Developer cannot be assigned on this remote" is true, and the
   * question it leaves is *so what?*. Absent only when there is genuinely
   * nothing to suggest, which a reader should be able to tell apart from a
   * suggestion nobody wrote.
   */
  remedy?: string;
}

export interface RemoteStatusBlocked {
  localId: string;
  /** The fields the remote will not take, each with the provider's reason. */
  fields: RemoteStatusBlockedField[];
}

/** The whole drift report, as `lpm remote status` computes it. */
export interface RemoteStatusReport {
  /** The remote this report is about. */
  remote: {
    name: string;
    provider: string;
    /** The connection value that names where the issues live. */
    target: string;
    /**
     * The subtree root this remote owns, or `null` for the whole board.
     *
     * On the report because **a count nobody can put a denominator to is not a
     * metric**. "433 ahead" is unreadable until you know whether the mirror
     * holds one epic or every document on the board — and the two readings are
     * a factor of twelve apart on the board this was written for, where a
     * reader assumed a scope that was never declared. It is the same rule a
     * profile's scope already follows: wherever scoped work is shown, the scope
     * is shown with it.
     */
    scope: string | null;
    /**
     * How many board issues this remote owns — the denominator for every count
     * above it, and the whole board when `scope` is null.
     *
     * On the report rather than read from the coverage report beside it, because
     * a count and its denominator arriving from two calls is two things free to
     * disagree, and `planStatus` already has the board and the scope in hand.
     */
    inScope: number;
    /** How many of those it holds a twin of. */
    mirrored: number;
    /** Most recent sync across links, or null when never synced. */
    lastSync: string | null;
  };
  /**
   * Local edits not yet pushed — every one of them a document that **has** a
   * twin. A document with no twin is `unlinked`, never `ahead`.
   */
  ahead: string[];
  /**
   * The subset of `ahead` that is ahead only on fields this remote cannot take.
   *
   * A subset rather than a separate bucket, because those documents really are
   * ahead — the board holds a value the tracker does not. What they are not is
   * *actionable*, so `pendingAhead` is what a headline should show and this is
   * what explains the rest.
   */
  blocked: RemoteStatusBlocked[];
  /** Remote edits not yet pulled. */
  behind: string[];
  /** Documents with an open conflict a human must settle. */
  conflicted: string[];
  /** Documents never pushed — no link and no tombstone. */
  unlinked: string[];
  /**
   * Remote issues with no local document — the mirror image of `unlinked`.
   *
   * Empty whenever the remote half was not read, and **only trustworthy from a
   * full listing**: an incremental one holds what changed since the cursor, so
   * an issue nobody touched is missing from it for a reason that has nothing to
   * do with whether it has a twin. `incremental` says which kind of listing
   * this was.
   */
  incoming: RemoteStatusIncoming[];
  /** Linked documents whose local document is gone. */
  orphaned: string[];
  /** Documents deliberately decoupled. */
  decoupled: RemoteStatusDecoupled[];
  /** Linked documents whose twin was not found upstream. */
  unreadable: Array<{ localId: string; remoteId: string }>;
  /** Linked documents whose twin could not be read, with why. */
  failed: RemoteStatusFailure[];
  /** Field-level detail, keyed by local id — present only with `--verbose`. */
  fields?: Record<string, RemoteStatusField[]>;
  /** The remote twin of every linked document, keyed by local id. */
  links?: Record<string, RemoteStatusLink>;
  /** Why the remote half could not be computed, when it could not. */
  remoteMissing?: string;
  /**
   * How many remote issues the listing returned, so a reader knows what the
   * remote half was computed from.
   *
   * It is a count of *issues*, not of requests, because a connector pages
   * internally and only it can see how many pages that took. The number is
   * worth having anyway: it is the size of the thing being compared, and a
   * report whose remote half read 4 issues on a 537-twin mirror is a scope or a
   * cursor problem rather than a board in sync. Absent when the remote was not
   * read.
   */
  remoteRead?: number;
  /**
   * True when the remote half came from an **incremental** listing — only what
   * changed since the stored cursor.
   *
   * Absence is not evidence in that case: an unchanged twin is missing from the
   * listing, so `unreadable` and `incoming` stand down (a twin nobody touched
   * would read as gone, and every untouched remote issue as already ours). It
   * is the cheap gear for a big mirror, and the full listing is the default.
   */
  incremental?: boolean;
}

/**
 * The documents a sync would really push: `ahead` minus the blocked ones.
 *
 * The one definition, because the CLI, the Sync tab and an agent all want the
 * same headline and set subtraction done three times is three chances to
 * disagree. `ahead` stays the honest total; this is the actionable part of it.
 */
export function pendingAhead(report: RemoteStatusReport): string[] {
  if (report.blocked.length === 0) return [...report.ahead];
  const blocked = new Set(report.blocked.map((entry) => entry.localId));
  return report.ahead.filter((id) => !blocked.has(id));
}

/**
 * The exit code a report implies: 0 in sync, 1 drifted, 2 conflicted.
 *
 * One source of truth for the CLI and any caller that renders the report
 * itself.  `conflicted` wins over drift; drift is any document a sync or a
 * human has to act on; a missing remote half is drift too, because "in sync"
 * is a claim nobody can make without having read the remote.
 */
export function remoteStatusExitCode(report: RemoteStatusReport): 0 | 1 | 2 {
  if (report.conflicted.length > 0) return 2;
  const drifted =
    report.ahead.length > 0 ||
    report.behind.length > 0 ||
    report.incoming.length > 0 ||
    report.unlinked.length > 0 ||
    report.orphaned.length > 0 ||
    report.unreadable.length > 0 ||
    report.failed.length > 0 ||
    report.remoteMissing !== undefined;
  return drifted ? 1 : 0;
}

/**
 * The badge one document carries, distilled from the whole report.
 *
 * A document can sit in several buckets at once — a title edited locally while
 * a status moved upstream is both `ahead` and `behind` — so a single mark needs
 * an order: `conflicted` wins (a human must settle it), then `ahead`, then
 * `behind`, then `unlinked`. Anything not named by the report is `in-sync`,
 * which includes documents outside the remote's scope and non-issue documents,
 * neither of which the canvas draws a mark for.
 */
export function syncBadgeOf(report: RemoteStatusReport, id: string): SyncBadge {
  if (report.conflicted.includes(id)) return 'conflicted';
  if (report.ahead.includes(id)) return 'ahead';
  if (report.behind.includes(id)) return 'behind';
  if (report.unlinked.includes(id)) return 'unlinked';
  return 'in-sync';
}
