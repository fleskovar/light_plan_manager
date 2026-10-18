/**
 * The description of an issue while the reader edits it.
 *
 * The text stays in this draft until the reader saves it. Nothing is recorded
 * in the workspace on each key press or on blur, so the issue window can say
 * exactly what closing it loses. `base` holds the description as the editor
 * opened it, so a description that a pull changes on disk does not count as an
 * edit of the reader.
 */
export class BodyDraft {
  editing = $state(false);
  /** True while the editor shows the rendered draft instead of the source. */
  previewing = $state(false);
  text = $state('');
  #base = $state('');

  /** True when the draft holds text that differs from what the editor opened with. */
  get dirty(): boolean {
    return this.editing && this.text !== this.#base;
  }

  /** Open the editor on `body`. An editor that is already open keeps its draft. */
  open(body: string): void {
    if (this.editing) return;
    this.text = body;
    this.#base = body;
    this.previewing = false;
    this.editing = true;
  }

  /**
   * Take the draft for a save. Returns the text to store, or null when the
   * draft holds no change. With `close`, the editor closes too.
   */
  commit(close: boolean): string | null {
    const changed = this.dirty ? this.text : null;
    this.#base = this.text;
    if (close) this.discard();
    return changed;
  }

  /** Close the editor and drop the draft. */
  discard(): void {
    this.editing = false;
    this.previewing = false;
    this.text = '';
    this.#base = '';
  }
}
