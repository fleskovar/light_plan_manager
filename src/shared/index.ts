/**
 * The contract between the server and the web app.
 *
 * Import-free by design: these modules describe what crosses the wire (`model`),
 * how edits are expressed (`changes`), how the multi-step edits are composed
 * (`plans`), what a saved view holds (`view`), what a board looks like once
 * frozen into a file for a serverless viewer (`static`) and how a failure is
 * reported (`errors`).
 *
 * Eight single-source rule modules — `period-stance`, `work-unit`,
 * `period-query`, `blocking`, `rollup`, `dependency-rollup`, `cohesion` and
 * `template-params` — live here as well. They import nothing, so core and the
 * browser both adapt to the same definition and cannot disagree about when a
 * period runs, what counts as a unit of work, where the next period sits, what
 * an issue is waiting on, what status a parent takes from the work inside it,
 * which containers the work inside them puts in order, which part of the plan
 * is already under way, or what a registry template asks for.
 *
 * Both sides depend on this folder and on nothing of each other's.
 */
export * from './adf.js';
export * from './blocking.js';
export * from './changes.js';
export * from './cohesion.js';
export * from './dependency-rollup.js';
export * from './errors.js';
export * from './flag-rollup.js';
export * from './git-sync.js';
export * from './model.js';
export * from './period-stance.js';
export * from './plans/index.js';
export * from './remote-api.js';
export * from './remote-coverage.js';
export * from './remote-readiness.js';
export * from './remote-status.js';
export * from './rollup.js';
export * from './static.js';
export * from './template-params.js';
export * from './view.js';
export * from './work-unit.js';
