/**
 * Individual check passes, one per file.
 *
 * Each module exports a `check*` function that inspects one aspect of a loaded
 * board and reports `Problem[]`.  Nothing here writes to disk — that is
 * `validation/fix/`'s job.  `shared.ts` keeps the two sides agreeing on what is
 * reportable and what is fixable.
 */
export { checkCollection } from './collection.js';
export { checkCounters } from './counters.js';
export { checkDependencies } from './dependencies.js';
export { checkGitignore } from './gitignore.js';
export { checkIndex } from './index-file.js';
export { checkIssues } from './issues.js';
export { checkPeriods } from './periods.js';
export { checkRemoteScopes } from './remotes.js';
export { checkResources } from './resources.js';
export { checkFlagRollup, checkRollup } from './rollup.js';
export { checkSquads } from './squads.js';
export { checkTemplates } from './templates.js';
