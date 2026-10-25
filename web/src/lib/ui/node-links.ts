import { getContext, setContext } from 'svelte';
import type { NodeLinkTarget } from './markdown.js';

/**
 * The connection between `[[ID]]` in a rendered body and the board.
 *
 * A window that renders bodies provides one `NodeLinks` object through the
 * Svelte context. Each `Markdown` component inside that window reads it, so a
 * body and a comment link the same way without a prop on each component.
 */
export interface NodeLinks {
  /** The address and the title for an id, or null when the board has no document with that id. */
  target(id: string): NodeLinkTarget | null;
  /** Show the document `id` to the reader. */
  open(id: string): void;
  /**
   * Show the library document `id` (`[label](library:<id>)`) to the reader.
   * Without this function, a body renders such a link as text.
   */
  openLibrary?(id: string): void;
}

const KEY = Symbol('node-links');

export function provideNodeLinks(links: NodeLinks): NodeLinks {
  return setContext(KEY, links);
}

/** The `NodeLinks` of this window, or undefined when the window provides none. */
export function useNodeLinks(): NodeLinks | undefined {
  return getContext<NodeLinks | undefined>(KEY);
}
