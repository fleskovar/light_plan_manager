import type { BoardPaths } from '../core/index.js';
import { fetchBoardAsync, gitSyncOf, isOffline, loadConfig, pullBoard } from '../core/index.js';

/**
 * Keeping the editor's board in step with its git remote.
 *
 * The web app already re-reads the board every few seconds, so the remote's
 * changes show up as soon as they reach the working tree. This puts them there:
 * a fetch behind the poll, **asynchronous** — a network round trip must never
 * hold up the request that triggered it, or every request queued behind it —
 * and throttled, because a poll every five seconds is not a reason to ask
 * GitHub every five seconds. The integrate step afterwards is local and fast,
 * and takes the board lock like any write.
 */

/** How often the background fetch may run, at most. */
const BACKGROUND_INTERVAL_MS = 20_000;

const inFlight = new Set<string>();
const startedAt = new Map<string, number>();

export function pullInBackground(paths: BoardPaths): void {
  const config = loadConfig(paths).config;
  const sync = config ? gitSyncOf(config) : null;
  if (!sync || isOffline()) return;
  const key = paths.lpmDir;
  if (inFlight.has(key) || Date.now() - (startedAt.get(key) ?? 0) < BACKGROUND_INTERVAL_MS) return;

  inFlight.add(key);
  startedAt.set(key, Date.now());
  void fetchBoardAsync(key, sync)
    .then((fetched) => {
      if (fetched.ok) pullBoard(paths, { noFetch: true });
    })
    .catch(() => {
      // The panel shows the last fetch's error; the next poll tries again.
    })
    .finally(() => inFlight.delete(key));
}

/**
 * Bring the board up to date before a route that writes loads it. Best effort:
 * the write transaction in core is what refuses a change that collides, so a
 * failure here costs nothing but a likelier refusal.
 */
export function pullBeforeWrite(paths: BoardPaths): void {
  try {
    pullBoard(paths, { maxAgeMs: 2_000 });
  } catch {
    // Reported by the write itself.
  }
}
