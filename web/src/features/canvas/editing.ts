import { getContext, setContext } from 'svelte';

/**
 * What a canvas node needs from edit mode.
 *
 * SvelteFlow constructs the node components itself, so they cannot receive
 * props from the canvas. The editor's canvas provides this object through
 * context instead. The read-only viewer provides nothing, and
 * `useCanvasEditing` then returns undefined, so its nodes offer no edit
 * controls.
 */
export interface CanvasEditing {
  /** True while the canvas is in edit mode. */
  readonly enabled: boolean;
  /**
   * The document whose title field is open on the canvas, or null. The field
   * opens in both modes: **Add new…** opens it on the item that it creates.
   */
  readonly renaming: string | null;
  /** True when edit mode can make `id` the active item. */
  canEnter(id: string): boolean;
  /** Make `id` the active item. */
  enter(id: string): void;
  /**
   * Write `title` as the title of `id`. A null title closes the field without
   * a change, or removes `id` when **Add new…** created it for the field.
   */
  finishRename(id: string, title: string | null): void;
  /**
   * Count a title field as on screen, so the automatic push waits. Returns
   * the function that the field calls when it unmounts.
   */
  openField(): () => void;
}

const KEY = Symbol('canvas-editing');

export function provideCanvasEditing(editing: CanvasEditing): CanvasEditing {
  return setContext(KEY, editing);
}

export function useCanvasEditing(): CanvasEditing | undefined {
  return getContext<CanvasEditing | undefined>(KEY);
}

/**
 * The title that a title field submits: the typed text without spaces at the
 * ends, or null when nothing is left.
 */
export function cleanTitle(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length ? trimmed : null;
}
