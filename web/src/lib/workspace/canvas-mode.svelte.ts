import { ancestorsOf } from '$lib/board/selectors.js';
import type { WorkingNodes } from '$lib/board/working.js';

/**
 * The way the canvas of one tab is worked: read mode or edit mode.
 *
 * Read mode draws the whole view. Edit mode can make one document the active
 * item, and the canvas then draws only what is inside that document. This
 * class holds the mode, the active item and the type chosen for new items.
 * It does not decide what the canvas draws: `visibleTree` reads `scope`.
 *
 * None of this state goes into the view file. A view is committed and pulled
 * by teammates, and the place one person is working must not move another
 * person's canvas. The workspace holds one instance for each tab, so a switch
 * to another tab and back keeps the mode and the active item.
 */
export type CanvasModeName = 'read' | 'edit';

export class CanvasMode {
  mode = $state<CanvasModeName>('read');

  /** The document that edit mode works inside, or null for the whole view. */
  activeId = $state<string | null>(null);

  /**
   * The ancestors of the active item when it was activated, nearest first.
   * When the active item leaves the board, `retain` falls back to the nearest
   * of these that still exists.
   */
  #trail: string[] = [];

  /** Hierarchy depth of a new item -> the type chosen for it in the type picker. */
  newTypes = $state<Record<number, string>>({});

  /**
   * The document whose title field is open on the canvas, or null. Both modes
   * use the field: **Add new…** opens it on the item that it creates.
   */
  renaming = $state<string | null>(null);

  /**
   * True when the open title field belongs to an item that was created for it.
   * A cancelled field, or an empty title, then removes the item again.
   */
  #removeOnCancel = false;

  /** How many title fields are on screen now. `Workspace` holds the automatic push while this is above 0. */
  #fields = 0;

  /** True while a title field is on screen, on a node or on the card of a new item. */
  get fieldOpen(): boolean {
    return this.#fields > 0;
  }

  /**
   * Count a title field as on screen. The field calls this when it mounts
   * and calls the returned function when it unmounts. The count follows the
   * field itself, not `renaming`: a node that is not drawn has no field, and
   * a push must not wait for a field that nobody can see.
   */
  openField(): () => void {
    this.#fields += 1;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.#fields -= 1;
    };
  }

  get editing(): boolean {
    return this.mode === 'edit';
  }

  /** The document the canvas draws the inside of: the active item in edit mode, else null. */
  get scope(): string | null {
    return this.editing ? this.activeId : null;
  }

  setMode(mode: CanvasModeName): void {
    this.mode = mode;
    if (mode === 'read') this.closeRename();
  }

  /**
   * Open the title field of `id`. With `removeOnCancel`, a cancelled field or
   * an empty title removes `id`, because `id` was created only to be named.
   */
  startRename(id: string, removeOnCancel = false): void {
    this.renaming = id;
    this.#removeOnCancel = removeOnCancel;
  }

  /**
   * Close the title field. Returns true when the item must be removed because
   * it was created for the field and received no title.
   */
  closeRename(): boolean {
    const remove = this.renaming !== null && this.#removeOnCancel;
    this.renaming = null;
    this.#removeOnCancel = false;
    return remove;
  }

  toggle(): void {
    this.setMode(this.editing ? 'read' : 'edit');
  }

  /**
   * Make `id` the active item. `ancestors` holds its ancestors, nearest first,
   * for the fallback in `retain`. Null returns to the whole view.
   */
  activate(id: string | null, ancestors: string[] = []): void {
    this.activeId = id;
    this.#trail = id ? ancestors : [];
    this.closeRename();
  }

  /** Make `id` the active item, with its ancestors read from `nodes`. */
  enter(id: string, nodes: WorkingNodes): void {
    this.activate(
      id,
      ancestorsOf(nodes, id).map((node) => node.id),
    );
  }

  /**
   * Make `id` the active item, or return to the whole view with null. Returns
   * the document that the canvas showed as the active item before, when it is
   * inside `id`. The caller can select that document, so the reader sees where
   * they came from.
   */
  goTo(id: string | null, nodes: WorkingNodes): string | null {
    const previous = this.activeId;
    if (id === null) this.activate(null);
    else this.enter(id, nodes);
    if (!previous || previous === id) return null;
    // The chain from the old active item up to the new one, nearest first.
    const chain = [previous, ...ancestorsOf(nodes, previous).map((node) => node.id)];
    const at = id === null ? chain.length : chain.indexOf(id);
    return at > 0 ? chain[at - 1]! : null;
  }

  /** Make the parent of the active item the active item. Returns what `goTo` returns. */
  goUp(nodes: WorkingNodes): string | null {
    if (!this.activeId) return null;
    return this.goTo(nodes[this.activeId]?.parentId ?? null, nodes);
  }

  /** Give the ids that a push allocated to the temporary ids held here. */
  remap(idMap: Record<string, string>): void {
    const swap = (id: string | null): string | null => (id ? (idMap[id] ?? id) : id);
    this.activeId = swap(this.activeId);
    this.renaming = swap(this.renaming);
    this.#trail = this.#trail.map((id) => idMap[id] ?? id);
  }

  /**
   * Keep the held ids that `exists` accepts. When the active item is gone,
   * the nearest ancestor that still exists becomes the active item.
   */
  retain(exists: (id: string) => boolean): void {
    if (this.renaming && !exists(this.renaming)) this.closeRename();
    if (!this.activeId || exists(this.activeId)) return;
    const index = this.#trail.findIndex(exists);
    this.activeId = index >= 0 ? this.#trail[index]! : null;
    this.#trail = index >= 0 ? this.#trail.slice(index + 1) : [];
  }
}
