import type { BoardSnapshot } from './model.js';
import type { NodeLayout, TypeDisplay, ViewDocument } from './view.js';

/**
 * A board frozen into one file, for a viewer that has no server behind it.
 *
 * `lpm export` writes this next to the board; a static page fetches it and
 * renders the graph. That is the whole contract — one request, no API, no
 * directory listing — which is what lets a GitHub Pages site show a board that
 * nothing is serving.
 *
 * It is deliberately a narrowing, not a dump of the working state:
 *
 *   - the snapshot is the board *as committed*. A view's queued-but-unpushed
 *     changes are somebody's draft, and a published board must not show them as
 *     though they were true, so `changes` does not travel.
 *   - a view keeps only `members` and `layout`: which documents it shows and
 *     where they sit. Drawer and panel state is editor chrome and means nothing
 *     to a viewer.
 *
 * The file is public by construction. Nothing in it may be secret that the
 * `.lpm` folder it was generated from does not already publish.
 */
export const STATIC_BOARD_VERSION = 1;

/** The published name of the data file, relative to whatever hosts it. */
export const STATIC_BOARD_FILE = 'board.json';

/** A saved view, narrowed to what a read-only viewer can act on. */
export interface StaticView {
  id: string;
  name: string;
  updated: string;
  members: string[];
  layout: Record<string, NodeLayout>;
  /**
   * Levels drawn as badges rather than as nodes. It travels because it is part
   * of the picture, not part of the editing: a view arranged with features
   * badged is a different graph, and a reader should see the one that was
   * published. Optional, so a board exported before this existed still reads.
   */
  display?: Record<string, TypeDisplay>;
}

export interface StaticBoard {
  version: number;
  /** When `lpm export` ran, ISO 8601. */
  generated: string;
  /** What wrote the file, e.g. `light-plan 0.1.0`. */
  generator: string;
  board: BoardSnapshot;
  views: StaticView[];
}

/**
 * Narrow a view for publication. `alive` decides which members survive: a view
 * can name a document that was created in its queue and never pushed, and that
 * id means nothing to anyone reading the exported board.
 */
export function toStaticView(view: ViewDocument, alive: (id: string) => boolean): StaticView {
  return {
    id: view.id,
    name: view.name,
    updated: view.updated,
    members: view.members.filter(alive),
    layout: Object.fromEntries(Object.entries(view.layout).filter(([id]) => alive(id))),
    display: view.display,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * List fields an issue gained after some boards were already published.
 *
 * The version guard only refuses a file *newer* than the reader; an older one is
 * meant to keep working, and a page deployed today will be fetching boards
 * exported months ago. A missing list would arrive as `undefined` and turn the
 * first `.length` in the viewer into a blank page, so the reader fills them in —
 * the same forgiveness `load.ts` shows a hand-written folder, at the one seam
 * where an old file meets a new reader.
 *
 * Add to this whenever a list field is added to `IssueDto`.
 */
const ISSUE_LISTS = ['dependsOn', 'relatesTo', 'relatedFiles'] as const;

function healIssues(issues: unknown[]): unknown[] {
  return issues.map((issue) => {
    if (!isRecord(issue)) return issue;
    const filled: Record<string, unknown> = { ...issue };
    for (const field of ISSUE_LISTS) {
      if (!Array.isArray(filled[field])) filled[field] = [];
    }
    // `flag` is nullable rather than a list, and absent means "not flagged".
    if (typeof filled.flag !== 'string') filled.flag = null;
    return filled;
  });
}

/**
 * Check a fetched file before rendering it.
 *
 * The viewer loads this from a URL, so "it parsed as JSON" is not enough to know
 * it is a board. The check stays shallow on purpose — the same forgiveness
 * `load.ts` shows a hand-edited folder, applied to a hand-edited export: enough
 * structure to render, and a clear message when there is not. The one thing it
 * does repair is a list field an older export predates; see `healIssues`.
 */
export function parseStaticBoard(value: unknown): StaticBoard {
  if (!isRecord(value)) throw new Error('That file is not a light-plan export');

  const version = value.version;
  if (typeof version !== 'number') throw new Error('That file is not a light-plan export');
  if (version > STATIC_BOARD_VERSION) {
    throw new Error(
      `This board was exported by a newer light-plan (format ${version}, this viewer reads ${STATIC_BOARD_VERSION})`,
    );
  }

  const board = value.board;
  if (!isRecord(board) || !Array.isArray(board.issues) || !isRecord(board.config)) {
    throw new Error('That export has no board in it');
  }

  return {
    version,
    generated: typeof value.generated === 'string' ? value.generated : '',
    generator: typeof value.generator === 'string' ? value.generator : '',
    board: {
      ...board,
      issues: healIssues(board.issues),
      squads: Array.isArray(board.squads) ? board.squads : [],
      // A board exported before the registry existed simply has none; a viewer
      // that read `undefined` here would blank the page on the first `.length`.
      templates: Array.isArray(board.templates) ? board.templates : [],
    } as unknown as BoardSnapshot,
    views: Array.isArray(value.views) ? (value.views as StaticView[]) : [],
  };
}
