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

  set(ids: string[]): void {
    this.ids = [...new Set(ids)];
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
