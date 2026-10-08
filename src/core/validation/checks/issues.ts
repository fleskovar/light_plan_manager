import type { LoadedBoard } from '../../board/load.js';
import { isTerminalStatus, statusIds } from '../../config/lookup.js';
import type { Issue, Problem } from '../../model/types.js';
import { FLAG_REASONS, hasPeriods, hasResources, isValidFlag } from '../../model/types.js';
import { RETIRED_LINK_FIELD, at, retiredLink } from '../shared.js';

export function checkIssues(board: LoadedBoard, problems: Problem[]): void {
  const valid = statusIds(board.config);
  const derivedOf = (issue: Issue) => board.derived.get(issue.dir) ?? [];

  for (const issue of board.issues) {
    const where = at(board, issue);

    // A board written before `informed_by` was retired still carries the key.
    // Nothing reads it now, so an ordering it recorded is one the queue no
    // longer honours — say so, and offer the merge into `depends_on` that the
    // edge already amounted to. An empty one costs nobody anything and is
    // still reported, because `--fix` removes it and the two have to agree.
    const retired = retiredLink(issue);
    if (retired) {
      problems.push({
        level: 'warn',
        path: where,
        message: retired.length
          ? `${RETIRED_LINK_FIELD} is no longer a link type; ${retired.join(', ')} belongs in depends_on`
          : `${RETIRED_LINK_FIELD} is no longer a link type; the empty field can go`,
        fixable: true,
      });
    }

    if (!valid.includes(issue.status)) {
      problems.push({
        level: 'error',
        path: where,
        message: `unknown status "${issue.status}"; expected one of [${valid.join(', ')}]`,
        fixable: true,
      });
    } else if (derivedOf(issue).includes('status')) {
      problems.push({ level: 'warn', path: where, message: 'missing status', fixable: true });
    }

    if (issue.period) {
      if (!hasPeriods(board.config)) {
        problems.push({
          level: 'error',
          path: where,
          message: `period "${issue.period}" is set but the config declares no period types`,
        });
      } else if (!board.periodsById.has(issue.period)) {
        problems.push({
          level: 'error',
          path: where,
          message: `period "${issue.period}" does not exist in the timeline`,
        });
      }
    }

    if (issue.assignee) {
      const assignee = board.resourcesById.get(issue.assignee);
      if (!hasResources(board.config)) {
        problems.push({
          level: 'error',
          path: where,
          message: `assignee "${issue.assignee}" is set but the config declares no resource types`,
        });
      } else if (!assignee) {
        problems.push({
          level: 'error',
          path: where,
          message: `assignee "${issue.assignee}" is not in the team roster`,
        });
      } else if (assignee.capacity === 0 && !isTerminalStatus(board.config, issue.status)) {
        problems.push({
          level: 'warn',
          path: where,
          message: `assigned to ${assignee.id} (${assignee.title}), which has no capacity`,
        });
      }
    }

    if (issue.flag) {
      if (!isValidFlag(issue.flag)) {
        problems.push({
          level: 'error',
          path: where,
          message: `unknown flag "${issue.flag}"; expected one of [${FLAG_REASONS.join(', ')}]`,
        });
      }
      if (isTerminalStatus(board.config, issue.status)) {
        problems.push({
          level: 'warn',
          path: where,
          message: `is flagged "${issue.flag}" but is "${issue.status}"; clear the flag`,
        });
      }
    }

    const seenFiles = new Set<string>();
    for (const ref of issue.related_files) {
      if (seenFiles.has(ref)) {
        problems.push({
          level: 'warn',
          path: where,
          message: `related_files lists "${ref}" more than once`,
          fixable: true,
        });
      }
      seenFiles.add(ref);
    }

    for (const field of ['depends_on', 'relates_to'] as const) {
      const ids = issue[field];
      const seen = new Set<string>();
      for (const id of ids) {
        if (id === issue.id) {
          problems.push({
            level: 'error',
            path: where,
            message: `${field} lists itself`,
            fixable: true,
          });
          continue;
        }
        if (seen.has(id)) {
          problems.push({
            level: 'warn',
            path: where,
            message: `${field} lists "${id}" more than once`,
            fixable: true,
          });
          continue;
        }
        seen.add(id);
        if (!board.byId.has(id)) {
          problems.push({
            level: 'error',
            path: where,
            message: board.periodsById.has(id)
              ? `${field} points at period "${id}"; only issues can be linked`
              : `${field} points at "${id}", which does not exist`,
          });
        }
      }
    }

    if (isTerminalStatus(board.config, issue.status)) {
      for (const id of issue.depends_on) {
        const blocker = board.byId.get(id);
        if (blocker && !isTerminalStatus(board.config, blocker.status)) {
          problems.push({
            level: 'warn',
            path: where,
            message: `is "${issue.status}" but depends on ${id}, which is "${blocker.status}"`,
          });
        }
      }
    }
  }
}
