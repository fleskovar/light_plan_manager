import { statSync } from 'node:fs';

/**
 * Parsed document shaped the way `scanDir` needs it: frontmatter data and body,
 * already split.  Stored per-file in a `DocumentCache`.
 */
export interface CachedDoc {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Mtime-keyed parse cache for board reloads.
 *
 * Every reload of a large board re-parses YAML for documents that did not
 * change — ~76 % of `loadBoard` cost.  A `DocumentCache` keyed on absolute file
 * path → (mtimeNs, size, data, body) lets a reload skip reading and parsing
 * every untouched file.  The two-second safety window closes the classic "racy
 * index" hole git itself guards against: when a file's mtime falls inside the
 * current tick, two same-size rewrites could share one timestamp, so a cache
 * that trusted only mtime+size would serve stale data.  Refusing to trust any
 * recently-written file forces a re-read for the window duration, which is
 * enough to survive a batch git checkout and the cascade rewrites `removeNode`
 * triggers.
 *
 * Only successful parses are cached — error paths are identical with and
 * without a cache.  Cached `data` is deep-frozen so an accidental mutation
 * throws instead of aliasing across reloads.
 */
export class DocumentCache {
  /** Number of times a lookup returned a cached entry. */
  hits = 0;
  /** Number of times a lookup could not serve from cache. */
  misses = 0;

  private readonly _cache = new Map<string, { mtimeNs: bigint; size: number; data: Record<string, unknown>; body: string }>();
  private readonly _windowMs: number;

  constructor(windowMs = 2_000) {
    this._windowMs = windowMs;
  }

  /**
   * Look up `file`.  Returns the cached (data, body) pair when all of:
   *
   * 1. The file's current mtimeNs **and** size match the cached values, and
   * 2. The file's mtime is older than the safety window.
   *
   * Condition (2) is the racy-write defence: a file whose mtime is inside the
   * window is always re-read even on a stat match, because a same-size rewrite
   * inside one coarse clock tick would otherwise serve stale data.
   *
   * Returns `undefined` on a miss — the caller reads, parses and stores.
   */
  get(file: string): CachedDoc | undefined {
    let stat;
    try {
      stat = statSync(file, { bigint: true });
    } catch {
      // File disappeared — cannot serve from cache.  Don't bump misses because
      // the caller will hit the normal read-error path.
      return undefined;
    }

    const entry = this._cache.get(file);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (entry.mtimeNs !== stat.mtimeNs || entry.size !== Number(stat.size)) {
      this.misses++;
      return undefined;
    }

    const fileAge = Date.now() - Number(stat.mtimeNs / 1_000_000n);
    if (fileAge < this._windowMs) {
      // Inside the safety window — re-read regardless of stat match.
      this.misses++;
      return undefined;
    }

    this.hits++;
    return { data: entry.data, body: entry.body };
  }

  /** Record a successful parse for `file`. Deep-freezes `data`. */
  set(file: string, doc: CachedDoc): void {
    let stat;
    try {
      stat = statSync(file, { bigint: true });
    } catch {
      return; // file vanished, don't cache
    }
    this._cache.set(file, {
      mtimeNs: stat.mtimeNs,
      size: Number(stat.size),
      data: deepFreeze(doc.data),
      body: doc.body,
    });
  }

  /** Discard all cached entries and reset counters. */
  clear(): void {
    this._cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function deepFreeze<T extends Record<string, unknown>>(obj: T): T {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value as Record<string, unknown>);
    }
  }
  return obj;
}
