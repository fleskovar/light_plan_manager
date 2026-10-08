/**
 * The in-memory board: reading all three collections off disk into a
 * `LoadedBoard` (load.ts), navigating it (query.ts), narrowing it to one
 * person's part of it (scope.ts), answering "who should work on what"
 * (tasks.ts), running that answer forward as one person's whole sequence
 * (simulate.ts), asking which containers are out of step with the work inside
 * them (rollup.ts) and which ones the dependencies inside them put in order
 * (dependency-rollup.ts). Loading is deliberately forgiving — it synthesizes
 * missing fields so a half-written board still loads, and records what it
 * synthesized for `check` to report and `fix` to persist.
 */
export * from './dependency-rollup.js';
export * from './load.js';
export * from './query.js';
export * from './registry.js';
export * from './remote-scopes.js';
export * from './flag-rollup.js';
export * from './rollup.js';
export * from './scope.js';
export * from './simulate.js';
export * from './tasks.js';
