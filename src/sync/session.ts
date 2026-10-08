import type { AnyNode, BoardPaths, LoadedBoard } from '../core/index.js';
import { BoardError, DocumentCache, findNode, loadBoard, nodesOf } from '../core/index.js';
import type { NodeKind, NodePatch } from '../shared/index.js';
import { isTempId, remapPatch } from '../shared/index.js';

/**
 * The board as a push sees it.
 *
 * Core operations take a `LoadedBoard` and write straight to disk, which makes
 * every handle stale the moment one of them runs. Rather than teach the engine
 * about in-place updates, a push simply reloads between steps: boards are small,
 * loading is cheap, and "always read what is actually on disk" removes a whole
 * class of bug from the replay.
 */
export class PushSession {
  board: LoadedBoard;

  /** Parse cache shared across every reload in this push. */
  readonly #cache = new DocumentCache();

  /** Temporary id (`new:1`) -> the id the board allocated. */
  readonly idMap: Record<string, string> = {};

  constructor(readonly paths: BoardPaths) {
    this.board = loadBoard(paths, { cache: this.#cache });
  }

  reload(): LoadedBoard {
    this.board = loadBoard(this.paths, { cache: this.#cache });
    return this.board;
  }

  record(tempId: string, realId: string): void {
    this.idMap[tempId] = realId;
  }

  /** A reference as the board knows it, translating ids created earlier in this push. */
  resolveId(id: string): string {
    return this.idMap[id] ?? id;
  }

  /** True for a temporary id that no change in this push has allocated yet. */
  unresolved(id: string): boolean {
    return isTempId(id) && this.resolveId(id) === id;
  }

  /** Re-read a document after an operation moved or rewrote it. */
  require(kind: NodeKind, id: string): AnyNode {
    const wanted = this.resolveId(id).toLowerCase();
    const node = nodesOf(this.board, kind).find((entry) => entry.id.toLowerCase() === wanted);
    if (!node) throw new BoardError(`No ${kind} with id "${this.resolveId(id)}"`);
    return node as AnyNode;
  }

  /** True when the board still holds this id in any namespace. */
  exists(id: string): boolean {
    return findNode(this.board, this.resolveId(id)) !== null;
  }

  /** Rewrite every id a patch points at, so temporary ids never reach core. */
  resolvePatch(patch: NodePatch): NodePatch {
    return remapPatch(patch, this.idMap);
  }
}
