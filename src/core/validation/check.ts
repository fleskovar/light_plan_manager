import type { LoadedBoard } from '../board/load.js';
import type { Problem } from '../model/types.js';
import {
  checkCentralProject,
  checkCollection,
  checkCounters,
  checkDependencies,
  checkGitignore,
  checkIndex,
  checkIssues,
  checkLibrary,
  checkPeriods,
  checkRemoteScopes,
  checkResources,
  checkFlagRollup,
  checkRollup,
  checkSquads,
  checkTemplates,
} from './checks/index.js';
import { KINDS } from './shared.js';

/** Validate a loaded board. Never writes; see `applyFixes` for the repairs. */
export function checkBoard(board: LoadedBoard): Problem[] {
  const problems: Problem[] = [...board.problems];
  for (const kind of KINDS) checkCollection(board, kind, problems);
  checkIssues(board, problems);
  checkPeriods(board, problems);
  checkResources(board, problems);
  checkSquads(board, problems);
  checkTemplates(board, problems);
  checkLibrary(board, problems);
  checkRollup(board, problems);
  checkFlagRollup(board, problems);
  checkDependencies(board, problems);
  checkCounters(board, problems);
  checkIndex(board, problems);
  checkGitignore(board, problems);
  checkCentralProject(board, problems);
  checkRemoteScopes(board, problems);
  return problems;
}
