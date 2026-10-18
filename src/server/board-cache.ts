import type { BoardPaths, LoadedBoard } from '../core/index.js';
import { DocumentCache, loadBoard } from '../core/index.js';

/**
 * The parse cache that `lpm ui` keeps for as long as it runs.
 *
 * The app polls `GET /api/board` every five seconds from every open window,
 * and most other routes load the board too. Without a cache, each request
 * reads and parses the YAML of every document again: about 0.8 s for a board
 * of 600 issues. `DocumentCache` keeps the parsed frontmatter and body of each
 * file, keyed on the file's path, mtime and size, so a request reads only the
 * files that changed since the last one. The cache distrusts a file written in
 * the last two seconds. `src/core/board/load/cache.ts` explains why.
 *
 * Every route loads through `readBoard`, the routes that write included. A
 * load through the cache takes the same stamps as one without it, so
 * `requireUnchanged` still refuses a write over a change that the load did not
 * see.
 */
const caches = new Map<string, DocumentCache>();

/** The cache of the board at `paths`. The server serves one board, so this map holds one entry. */
export function documentCache(paths: BoardPaths): DocumentCache {
  let cache = caches.get(paths.lpmDir);
  if (!cache) {
    cache = new DocumentCache();
    caches.set(paths.lpmDir, cache);
  }
  return cache;
}

/** Load the board through the cache of the server. */
export function readBoard(paths: BoardPaths): LoadedBoard {
  return loadBoard(paths, { cache: documentCache(paths) });
}
