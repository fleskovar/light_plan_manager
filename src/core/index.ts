/**
 * light-plan core.
 *
 * The CLI is a thin shell over this module; a future GUI can import the same
 * engine. Everything here is synchronous filesystem work over a `.lpm` folder.
 *
 * Layers, each depending only on the ones above it:
 *
 *   model/       what an issue, period, type and problem are; pure logic
 *   config/      parsing .lpm/config.yml and answering questions about it
 *   storage/     how a board is encoded on disk: paths, frontmatter, ids, git
 *   board/       loading both collections into memory, querying and scoping them
 *   gitsync/     sharing the board through its own git repository: pull, the
 *                write transaction, status, the hosts setup knows about
 *   profile/     the file one developer is handed: who they are, what they see
 *   instructions/ one issue plus its ancestry, rendered as a working brief
 *   operations/  the commands that change a board: init, create, move, link
 *   validation/  check (read-only) and fix (repairs what check marks fixable)
 *
 * `errors.ts` sits outside the stack: every layer may throw a BoardError.
 */
export * from './board/index.js';
export * from './config/index.js';
export * from './errors.js';
export * from './gitsync/index.js';
export * from './instructions/index.js';
export * from './model/index.js';
export * from './operations/index.js';
export * from './profile/index.js';
export * from './storage/index.js';
export * from './validation/index.js';
