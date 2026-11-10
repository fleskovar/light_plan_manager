import { untrack } from 'svelte';

/**
 * What the user has selected, and what the canvas should be looking at.
 *
 * Selection is deliberately independent of the canvas: the table, the Gantt
 * chart and the side panel all select things, and the canvas reacts by focusing
 * whatever became primary.
 */
export class Selection {
  ids = $state<string[]>([]);

  /** Bumped whenever something asks the canvas to move to the primary node. */
  focusRequest = $state(0);

  /** The node the side panel edits: the last one added to the selection. */
  get primary(): string | null {
    return this.ids.at(-1) ?? null;
  }

  get size(): number {
    return this.ids.length;
  }

  has(id: string): boolean {
    return this.ids.includes(id);
  }

  /**
   * Replace the selection with `ids`. An id that was already selected keeps
   * its place, and a new id goes after them in the order of `ids`. The
   * canvas reports a selection in the order of its nodes, and this rule keeps
   * the order of the clicks, which the key F reads (`linkSelection`).
   */
  set(ids: string[]): void {
    const next = new Set(ids);
    // Untracked: an effect that calls `set` must not depend on the selection
    // that it writes, or it runs again after each write.
    const kept = untrack(() => this.ids).filter((id) => next.has(id));
    const added = [...next].filter((id) => !kept.includes(id));
    this.ids = [...kept, ...added];
  }

  /** Select one node, replacing the selection, and ask the canvas to focus it. */
  focus(id: string): void {
    this.ids = [id];
    this.focusRequest += 1;
  }

  toggle(id: string): void {
    this.ids = this.has(id) ? this.ids.filter((entry) => entry !== id) : [...this.ids, id];
  }

  add(ids: string[]): void {
    this.ids = [...new Set([...this.ids, ...ids])];
  }

  clear(): void {
    this.ids = [];
  }

  /** Drop ids that no longer exist, after a delete or a pull. */
  retain(known: (id: string) => boolean): void {
    const kept = this.ids.filter(known);
    if (kept.length !== this.ids.length) this.ids = kept;
  }
}
