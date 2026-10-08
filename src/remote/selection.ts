/**
 * Splitting a push selection: the documents it files, and the periods it files.
 *
 * "Push these" is one gesture on every front end, and a period may be among
 * what somebody points at — filing the timeline is filing part of the plan
 * (`docs/remote-sync.md` §7c-bis), just not a precondition of filing anything
 * else. But the two travel differently: a document id is a *selection*
 * (`RunSyncOptions.only`), while a period is named in `RunSyncOptions.periods`,
 * because a push of work deliberately creates no sprints. A caller that put a
 * period id in `only` would see the push do nothing at all, silently, which is
 * exactly what the web's gap list did before this existed.
 *
 * The repair travels with it, and that is the other half of the rule: filing a
 * sprint also joins every **already mirrored** issue scheduled in it to the
 * run, so the assignment those issues could not carry when they were filed is
 * written now. Without it, filing the sprint would leave the work that was
 * waiting for it still unscheduled upstream — the tool would have created the
 * thing and not used it.
 *
 * One definition, because the CLI and the server both answer the same gesture.
 */

import type { LoadedBoard } from '../core/board/load.js';
import { loadLinkStore } from './links.js';

/** What a push selection turns into: documents to act on, periods to file. */
export interface PushSelection {
  /** Documents this run acts on — never a scope; see `docs/remote-sync.md` §7e. */
  only: string[];
  /** Periods to file, when the selection named any. */
  periods?: string[];
}

/**
 * Split the ids somebody selected into the two things a run takes.
 *
 * Anything the board does not know stays in `only` untouched: this decides
 * *how* a known id travels, and never whether it is valid — that is the
 * planner's and the preflight's answer to give, with better words than a
 * splitter could manage.
 */
export function splitPushSelection(
  board: LoadedBoard,
  remoteName: string,
  ids: readonly string[],
): PushSelection {
  const periodIds = new Set(board.periods.map((period) => period.id));
  const periods = ids.filter((id) => periodIds.has(id));
  const only = new Set(ids.filter((id) => !periodIds.has(id)));

  if (periods.length > 0) {
    const store = loadLinkStore(board.paths, remoteName);
    for (const issue of board.issues) {
      if (issue.period === null || !periods.includes(issue.period)) continue;
      if (!store.links.has(issue.id)) continue; // not filed: the sprint is not its problem
      only.add(issue.id);
    }
  }

  return {
    only: [...only].sort(),
    ...(periods.length > 0 ? { periods } : {}),
  };
}
