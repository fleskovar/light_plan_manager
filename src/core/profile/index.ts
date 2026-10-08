/**
 * Developer profiles: the file one person is handed that says who they are and
 * which part of the board is theirs.
 *
 *   schema.ts   parsing and validating the file (strict: a typo is an error)
 *   current.ts  finding the one in force, and resolving its scope for a board
 *
 * The types live in `model/profile.ts` and the evaluation in `board/scope.ts`,
 * because a scope is a way of reading a board and this layer is only the file
 * it arrived in. Nothing here is board truth: a profile is never committed to
 * `.lpm`, and `check` neither reads one nor cares that it exists.
 */
export * from './current.js';
export * from './schema.js';
