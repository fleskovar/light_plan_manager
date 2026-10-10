/**
 * The commands that change a board: scaffolding one (init), adding documents
 * (create), editing them (update), changing what they are (retype), relocating
 * them (move), picking work up (claim), recording dependencies and coverage
 * (link), saying that work has stopped and why (flag), writing down how the work
 * went (comment), deleting them (remove), carrying a status up to the containers
 * above it (rollup), and remembering who is at the keyboard (user) and which
 * profile they run under (profile). `planning` switches the board between
 * planning with its periods and working as one queue — a config edit, never a
 * document edit. `config-edit` changes the types, the statuses and the
 * attributes that `.lpm/config.yml` declares, and rewrites every document that
 * holds a renamed name. `board-template` saves a config as a template for new
 * boards; it writes the user folder and never a board.
 * Each validates its inputs up front and only then touches the filesystem, so
 * a rejected operation leaves nothing half-written. The ones that add, remove,
 * move or rename a document also rewrite `.lpm/INDEX.md` (board-index), which
 * is why a folder named after an id alone still tells a reader what it holds.
 *
 * Every one of them runs under the board lock, so a `.lpm` folder shared by
 * people and agents serializes its writers, and every one of them refuses to
 * write over a document that changed since the handle it was read into. Those
 * two rules live in `shared.ts` (`boardWrite`, `requireUnchanged`) and are what
 * make "several agents on one checkout" a supported way to work rather than a
 * race everybody gets away with until they do not.
 *
 * When the board is shared through git (`git_sync`), the same wrapper commits
 * what each write changed and pushes it, or undoes it and refuses with a
 * `ConflictError` when somebody else pushed a change to the same document
 * first. `git-sync.ts` is that wiring plus the commands that set sharing up.
 *
 * `shared.ts` holds the guards these have in common and is intentionally
 * not re-exported.
 */
export * from './board-index.js';
export * from './board-template.js';
export * from './claim.js';
export * from './comment.js';
export * from './config-edit.js';
export * from './create.js';
export * from './flag.js';
export * from './git-sync.js';
export * from './remotes-off.js';
export * from './init.js';
export * from './link.js';
export * from './move.js';
export * from './planning.js';
export * from './profile.js';
export * from './remove.js';
export * from './retype.js';
export * from './rollup.js';
export * from './update.js';
export * from './user.js';
