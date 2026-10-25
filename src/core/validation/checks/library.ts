import path from 'node:path';
import type { LoadedBoard } from '../../board/load.js';
import type { Problem } from '../../model/types.js';
import {
  libraryDir,
  libraryDocExists,
  libraryRefsInBody,
  listLibraryFiles,
  normalizeLibraryId,
  parseLibraryRef,
  isLibraryRef,
} from '../../storage/library.js';
import { displayPath } from '../../storage/paths.js';

/**
 * The board library (`.lpm/library/`) and the references to it.
 *
 * A library document is not part of the plan, so nothing here is an error:
 * every finding is a warning, and `--fix` repairs none of them, because only a
 * person knows whether to rename the file or the reference.
 *
 * Three findings:
 *
 * - An issue or a template holds `library:<id>` in `related_files`, or links to
 *   `library:<id>` in its body, and `.lpm/library/<id>.md` does not exist.
 * - A `related_files` entry starts with `library:` and the text after the
 *   prefix is not a valid id.
 * - A markdown file below `.lpm/library/` has a path that is not a valid id,
 *   for example because it holds a capital letter or a space. `lpm library`
 *   does not list such a file.
 */
export function checkLibrary(board: LoadedBoard, problems: Problem[]): void {
  for (const node of [...board.issues, ...board.templates]) {
    const where = displayPath(board.paths, node.file);
    const missing: string[] = [];
    for (const ref of node.related_files) {
      if (!isLibraryRef(ref)) continue;
      const id = parseLibraryRef(ref);
      if (id === null) {
        problems.push({
          level: 'warn',
          path: where,
          message: `${node.id}: "${ref}" is not a valid library reference. An id holds lowercase letters, digits, "-", "_", "." and "/"`,
        });
      } else if (!missing.includes(id) && !libraryDocExists(board.paths, id)) {
        missing.push(id);
      }
    }
    for (const id of libraryRefsInBody(node.body)) {
      if (!missing.includes(id) && !libraryDocExists(board.paths, id)) missing.push(id);
    }
    for (const id of missing) {
      problems.push({
        level: 'warn',
        path: where,
        message: `${node.id} references library:${id}, and .lpm/library/${id}.md does not exist`,
      });
    }
  }

  for (const file of listLibraryFiles(board.paths)) {
    if (file.id !== null) continue;
    const suggestion = normalizeLibraryId(file.relative);
    problems.push({
      level: 'warn',
      path: displayPath(board.paths, path.join(libraryDir(board.paths), file.relative)),
      message: suggestion
        ? `The library file name is not a valid id, so lpm does not list it. Rename it to ${suggestion}.md`
        : 'The library file name is not a valid id, so lpm does not list it. Use lowercase letters, digits, "-", "_" and "."',
    });
  }
}
