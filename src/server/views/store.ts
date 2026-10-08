import type { BoardPaths } from '../../core/index.js';
import {
  BoardError,
  deleteView,
  listViewIds,
  readView,
  viewExists,
  viewIdFor,
  writeView,
} from '../../core/index.js';
import type { BoardSnapshot, ViewDocument, ViewMode, ViewSummary } from '../../shared/index.js';
import { compactChanges, emptyView, summarize } from '../../shared/index.js';
import { parseView } from './schema.js';

/**
 * Reading and writing views, with the two rules the app relies on: a view is
 * always compacted on the way in and out, and a view never keeps a member that
 * the board no longer has.
 */

export function listViews(paths: BoardPaths): ViewSummary[] {
  return listViewIds(paths)
    .map((id) => {
      try {
        return summarize(parseView(readView(paths, id), id));
      } catch {
        // A broken view file must not take the welcome screen down with it.
        return null;
      }
    })
    .filter((entry): entry is ViewSummary => entry !== null)
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

export function loadView(paths: BoardPaths, id: string): ViewDocument {
  return parseView(readView(paths, id), id);
}

/**
 * Drop members and layout entries whose documents are gone. A view is a way of
 * looking at the board, so the board wins whenever the two disagree.
 */
export function pruneView(view: ViewDocument, board: BoardSnapshot): ViewDocument {
  // Whichever collection the view is a canvas over. A registry view whose
  // members were checked against the issues would come back empty every time.
  const drawn = view.mode === 'templates' ? board.templates : board.issues;
  const known = new Set(drawn.map((node) => node.id));
  const pending = new Set(
    view.changes.filter((change) => change.kind === 'create').map((change) => change.id),
  );
  const alive = (id: string): boolean => known.has(id) || pending.has(id);

  const members = view.members.filter(alive);
  const layout = Object.fromEntries(Object.entries(view.layout).filter(([id]) => alive(id)));
  return { ...view, members, layout };
}

export function saveView(paths: BoardPaths, view: ViewDocument): ViewDocument {
  const stored: ViewDocument = {
    ...view,
    changes: compactChanges(view.changes),
    updated: new Date().toISOString(),
  };
  writeView(paths, stored.id, stored);
  return stored;
}

export function createView(
  paths: BoardPaths,
  name: string,
  mode: ViewMode = 'board',
): ViewDocument {
  const trimmed = name.trim();
  if (!trimmed) throw new BoardError('A view needs a name');
  const id = viewIdFor(trimmed);
  if (viewExists(paths, id)) {
    throw new BoardError(`A view called "${trimmed}" already exists`, [
      'Pick another name, or open the existing view.',
    ]);
  }
  return saveView(paths, { ...emptyView(id, trimmed), mode });
}

export function removeView(paths: BoardPaths, id: string): void {
  if (!viewExists(paths, id)) throw new BoardError(`No view "${id}"`);
  deleteView(paths, id);
}
