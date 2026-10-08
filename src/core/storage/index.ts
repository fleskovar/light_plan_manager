/**
 * The filesystem and git adapters — everything that knows how a board is laid
 * out on disk: where things live (paths), how a document is encoded
 * (frontmatter, document), the work log beside it (comments), the activity
 * section inside a document's body (activity), the id counters (state),
 * per-checkout settings (local), saved views (views), the context templates a
 * brief is rendered with (templates), and authorship (git).  Nothing here knows
 * what a valid board looks like; that is validation's job.
 *
 * Two of them are about sharing the folder rather than laying it out: `atomic`
 * (a write nobody can see half of, and the stamp that says whether a file moved
 * underneath a reader) and `lock` (one writer at a time, across processes).
 * Every write in this folder goes through the first; every operation that
 * changes a board goes through the second.
 */
export * from './activity.js';
export * from './atomic.js';
export * from './comments.js';
export * from './document.js';
export * from './frontmatter.js';
export * from './git.js';
export * from './local.js';
export * from './lock.js';
export * from './paths.js';
export * from './state.js';
export * from './templates.js';
export * from './views.js';
