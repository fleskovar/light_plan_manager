import path from 'node:path';
import type { LoadedBoard } from '../../board/load.js';
import type { Problem } from '../../model/types.js';
import { isCentralBoard, samePath } from '../../storage/central.js';
import type { BoardPaths } from '../../storage/paths.js';
import { PROJECT_FILE, displayPath, readProjectPath } from '../../storage/paths.js';

/**
 * A central board keeps `project.json`, which names the project that points at
 * it. The landing page of `lpm ui` and `lpm store list` read the file to show
 * the project of each board. `check` reports a file that is missing or names
 * another project. `--fix` writes the project that this command came from.
 */
export interface ProjectFileProblem {
  message: string;
  /** False when no project is known: the board was named directly, without a pointer. */
  fixable: boolean;
}

/** What is wrong with `project.json` of this board, or null for a local board or a correct file. */
export function projectFileProblem(paths: BoardPaths): ProjectFileProblem | null {
  if (!isCentralBoard(paths)) return null;
  // A central board named directly (LPM_BOARD_PATH) without the file is its own root.
  const projectKnown = !samePath(paths.root, paths.lpmDir);
  const named = readProjectPath(paths.lpmDir);
  if (named === null) {
    return {
      message: projectKnown
        ? `${PROJECT_FILE} is missing. It must name the project folder ${paths.root}`
        : `${PROJECT_FILE} is missing, and no project points at this board here`,
      fixable: projectKnown,
    };
  }
  if (projectKnown && !samePath(named, paths.root)) {
    return {
      message: `${PROJECT_FILE} names the project ${named}, but the pointer in ${paths.root} leads here. Two projects can point at this board, or the project moved`,
      fixable: true,
    };
  }
  return null;
}

export function checkCentralProject(board: LoadedBoard, problems: Problem[]): void {
  const problem = projectFileProblem(board.paths);
  if (!problem) return;
  problems.push({
    level: 'warn',
    path: displayPath(board.paths, path.join(board.paths.lpmDir, PROJECT_FILE)),
    message: problem.message,
    fixable: problem.fixable,
  });
}
