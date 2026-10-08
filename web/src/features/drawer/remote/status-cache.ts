import type { RemoteStatusReport } from '$shared';

/**
 * The last full drift check for one remote, kept in `localStorage` so
 * reopening the app shows the same numbers it showed last time instead of
 * paying for another tracker read before anybody asked for one.
 *
 * Browser-only and per-origin: it survives a reload and a closed tab, never
 * reaches another device or the server, and a private window, cleared site
 * data or a blocked store all read it back as nothing — every access is
 * wrapped so a missing cache renders exactly like a first-ever open rather
 * than as an error.
 */
export interface CachedStatus {
  report: RemoteStatusReport;
  /** When the full check that produced this ran. */
  checkedAt: string;
}

const PREFIX = 'lpm:remote-status:v1:';

function keyFor(name: string): string {
  return `${PREFIX}${name}`;
}

/**
 * The cached full report for one remote, or `null` when there is none to trust.
 *
 * An **incremental** report is refused rather than returned: it holds only
 * what changed since the cursor, so absence from it proves nothing and its
 * buckets cannot stand in for a full answer. Nothing in the web app asks for
 * one today — `checkDrift` always reads the whole project — which is exactly
 * why the rail belongs here rather than in a reader's head.
 */
export function readCachedStatus(name: string): CachedStatus | null {
  try {
    const raw = localStorage.getItem(keyFor(name));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedStatus> | null;
    if (!parsed || typeof parsed.checkedAt !== 'string' || !parsed.report) return null;
    if (parsed.report.incremental === true) return null;
    return parsed as CachedStatus;
  } catch {
    return null;
  }
}

/** Remember a full report as the last known truth for this remote. */
export function writeCachedStatus(
  name: string,
  report: RemoteStatusReport,
  checkedAt: string = new Date().toISOString(),
): void {
  try {
    const entry: CachedStatus = { report, checkedAt };
    localStorage.setItem(keyFor(name), JSON.stringify(entry));
  } catch {
    // A quota error or a blocked store just means the next open pays for a
    // live check again — never worth interrupting anybody for. Nothing in the
    // session depends on the write landing: `RemoteState` blends against the
    // report it already holds in memory first.
  }
}

/** Forget the cached report — the remote is gone, or its connection changed. */
export function clearCachedStatus(name: string): void {
  try {
    localStorage.removeItem(keyFor(name));
  } catch {
    // Nothing to clean up if storage was never reachable to begin with.
  }
}

/**
 * Blend a just-read **local** report with the last known **full** one.
 *
 * The two halves answer different questions and the split is the server's
 * own (`planStatus`): with the remote side fetched, `ahead` / `behind` /
 * `conflicted` come from the three-way merge; without it, `behind` and
 * `conflicted` cannot exist at all and `ahead` is the *weaker* claim "the
 * local side differs from its base snapshot".
 *
 * Weaker is not a detail. On this repository's own board the local half says
 * **48** and the merge says **5**: the other 43 differ from a stale base on a
 * field the two sides already agree on (`none`), or on a field this remote
 * does not carry at all. So the full report is authoritative for every bucket
 * that needed the tracker, and the local read is authoritative only for what
 * exists on disk — which is why an earlier version of this function, which
 * took `ahead` from the local half, made the panel flip between 5 and 48 and
 * read as a bug in the count rather than as two definitions of one word.
 *
 * What the fresh local read *can* do is take work away: `full.ahead` is
 * always a subset of `local.ahead` (a `push` outcome requires local ≠ base),
 * so a document that no longer differs from its base has been pushed or
 * reverted since the check and drops out on its own. That is what makes the
 * count self-heal after a sync without going back to the tracker. It cannot
 * *add* to `ahead`: whether a local edit made since the check is a push, a
 * conflict or already agreed is precisely the question only the tracker can
 * answer, and guessing `push` is how the 48 got on screen.
 */
export function withCachedRemoteHalf(
  local: RemoteStatusReport,
  cached: RemoteStatusReport,
): RemoteStatusReport {
  const stillDiffers = new Set(local.ahead);
  const ahead = cached.ahead.filter((id) => stillDiffers.has(id));
  const aheadSet = new Set(ahead);

  const merged: RemoteStatusReport = {
    ...local,
    ahead,
    // `blocked` is documented as a subset of `ahead`, so it follows it.
    blocked: cached.blocked.filter((entry) => aheadSet.has(entry.localId)),
    behind: cached.behind,
    conflicted: cached.conflicted,
    incoming: cached.incoming,
  };

  if (cached.remoteRead !== undefined) merged.remoteRead = cached.remoteRead;
  if (cached.fields !== undefined) merged.fields = cached.fields;
  // The local half always carries "the remote was not read"; this report has
  // a remote half, so that sentence would be false. Only a reason the cached
  // check itself recorded survives.
  if (cached.remoteMissing !== undefined) merged.remoteMissing = cached.remoteMissing;
  else delete merged.remoteMissing;

  return merged;
}

/**
 * Drop documents a sync has just acted on from a cached full report.
 *
 * A run writes to one side or the other, which makes the cached answer about
 * those documents wrong in a way no local read can correct: pull three issues
 * and they are no longer `behind`, but only the tracker could say so. The ids
 * come from the run's own progress events, so this is the run reporting what
 * it touched rather than a guess — and dropping them understates the drift
 * (they come back on the next check if the run did not in fact settle them),
 * which is the safe direction to be wrong in.
 *
 * Deliberately *not* "throw the whole cache away". That was the first attempt
 * and it was worse than the bug: with no cache the panel falls back to the
 * local half, so pushing one document made "to push" jump from 5 to 48.
 */
export function pruneCachedStatus(
  report: RemoteStatusReport,
  touched: readonly string[],
): RemoteStatusReport {
  if (touched.length === 0) return report;
  const done = new Set(touched);
  const pruned: RemoteStatusReport = {
    ...report,
    ahead: report.ahead.filter((id) => !done.has(id)),
    blocked: report.blocked.filter((entry) => !done.has(entry.localId)),
    behind: report.behind.filter((id) => !done.has(id)),
    conflicted: report.conflicted.filter((id) => !done.has(id)),
  };
  if (report.fields !== undefined) {
    pruned.fields = Object.fromEntries(
      Object.entries(report.fields).filter(([id]) => !done.has(id)),
    );
  }
  return pruned;
}
