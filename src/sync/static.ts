import type { LoadedBoard } from '../core/index.js';
import type { StaticBoard, ViewDocument } from '../shared/index.js';
import { STATIC_BOARD_VERSION, toStaticView } from '../shared/index.js';
import { toSnapshot } from './dto.js';

/**
 * A board, frozen into the file a serverless viewer reads.
 *
 * There is nothing here but assembly: the snapshot comes from `toSnapshot`, the
 * same one `lpm ui` serves, so an exported board and a served board cannot
 * disagree about what the board *is*. Anything this file had to compute for
 * itself would be a second engine, which is the mistake to avoid.
 */
export function toStaticBoard(
  board: LoadedBoard,
  views: ViewDocument[],
  generator: string,
): StaticBoard {
  const snapshot = toSnapshot(board);

  // Only documents that actually exist on the board travel. A view can name an
  // id that its queue was going to create, and that id means nothing to a
  // reader who never sees the queue.
  const known = new Set([
    ...snapshot.issues.map((issue) => issue.id),
    ...snapshot.periods.map((period) => period.id),
    ...snapshot.resources.map((resource) => resource.id),
    ...snapshot.squads.map((squad) => squad.id),
    ...snapshot.templates.map((template) => template.id),
  ]);

  return {
    version: STATIC_BOARD_VERSION,
    generated: snapshot.readAt,
    generator,
    board: snapshot,
    views: views
      .map((view) => toStaticView(view, (id) => known.has(id)))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
