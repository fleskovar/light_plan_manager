<script lang="ts">
  import { renderMarkdown } from './markdown.js';
  import { useNodeLinks } from './node-links.js';

  /**
   * A rendered document body. The HTML comes from `markdown.ts`, which escapes
   * its input before it does anything else — that is what makes `{@html}` here
   * a statement about this component rather than about the board.
   *
   * When the window provides `NodeLinks`, `[[ID]]` renders as a link. A click
   * on that link calls `NodeLinks.open`. A click with Ctrl, Cmd, Shift or the
   * middle button goes to the browser, which opens the address in a new tab.
   *
   * When `NodeLinks` has `openLibrary`, `[label](library:<id>)` renders as a
   * link too, and a click on it calls `NodeLinks.openLibrary`.
   */
  interface Props {
    source: string;
    /** Shown when the body is empty, so the panel is never a blank box. */
    placeholder?: string;
  }

  let { source, placeholder = 'No description yet.' }: Props = $props();

  const links = useNodeLinks();
  const html = $derived(
    renderMarkdown(
      source,
      links ? { nodeLink: (id) => links.target(id), libraryLink: links.openLibrary !== undefined } : {},
    ),
  );

  /** The id in the `data-library` attribute of the link that the event targets. */
  function libraryId(event: Event): string | null {
    const link = event.target instanceof Element ? event.target.closest('a[data-library]') : null;
    return link?.getAttribute('data-library') ?? null;
  }

  /** The id in the `data-node` attribute of the link that the event targets. */
  function linkedId(event: Event): string | null {
    const link = event.target instanceof Element ? event.target.closest('a[data-node]') : null;
    return link?.getAttribute('data-node') ?? null;
  }

  function onclick(event: MouseEvent): void {
    const library = libraryId(event);
    if (library !== null) {
      // The address of the link is `#`, so every click stays in the window.
      event.preventDefault();
      links?.openLibrary?.(library);
      return;
    }
    const id = linkedId(event);
    if (!id || !links) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    links.open(id);
  }

  /** A double-click on a link does not reach the parent, which opens the editor on a double-click. */
  function ondblclick(event: MouseEvent): void {
    if (linkedId(event) || libraryId(event) !== null) event.stopPropagation();
  }
</script>

{#if html}
  <!-- The links inside take the keyboard focus, and Enter on a link fires a click. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="prose" {onclick} {ondblclick}>{@html html}</div>
{:else}
  <p class="empty">{placeholder}</p>
{/if}

<style>
  /*
   * Sizes are in `em`, so a caller that sets a larger font-size on the
   * `.prose` element (the issue window does) scales every heading and code
   * span with it.
   */
  .prose {
    font-size: var(--text-sm);
    line-height: 1.6;
    overflow-wrap: break-word;
  }

  .empty {
    margin: 0;
    color: var(--ink-faint);
    font-size: var(--text-sm);
    font-style: italic;
  }

  .prose > :global(:first-child) {
    margin-top: 0;
  }

  .prose > :global(:last-child) {
    margin-bottom: 0;
  }

  .prose :global(h1),
  .prose :global(h2),
  .prose :global(h3),
  .prose :global(h4),
  .prose :global(h5),
  .prose :global(h6) {
    margin: 1.4em 0 0.5em;
    font-weight: 700;
    line-height: 1.3;
  }

  .prose :global(h1) {
    font-size: 1.45em;
    padding-bottom: 0.25em;
    border-bottom: 1px solid var(--border);
  }

  .prose :global(h2) {
    font-size: 1.25em;
    padding-bottom: 0.2em;
    border-bottom: 1px solid var(--surface-3);
  }

  .prose :global(h3) {
    font-size: 1.1em;
  }

  .prose :global(h4) {
    font-size: 1em;
  }

  .prose :global(h5),
  .prose :global(h6) {
    font-size: 0.92em;
    color: var(--ink-muted);
  }

  .prose :global(p) {
    margin: 0 0 0.75em;
  }

  .prose :global(ul),
  .prose :global(ol) {
    margin: 0 0 0.75em;
    padding-left: 1.5em;
  }

  /* A list inside an item sits close to the item's text. */
  .prose :global(li > ul),
  .prose :global(li > ol) {
    margin: 0.2em 0;
  }

  .prose :global(li) {
    margin: 0.2em 0;
  }

  .prose :global(li > p) {
    margin: 0 0 0.5em;
  }

  .prose :global(li.task) {
    list-style: none;
    margin-left: -1.3em;
  }

  .prose :global(li.task > input) {
    margin: 0 0.4em 0 0;
    vertical-align: -1px;
  }

  .prose :global(li.task > input + p) {
    display: inline;
  }

  .prose :global(blockquote) {
    margin: 0 0 0.75em;
    padding: 0.25em 0 0.25em 0.9em;
    border-left: 3px solid var(--border-strong);
    color: var(--ink-muted);
  }

  .prose :global(blockquote > :last-child) {
    margin-bottom: 0;
  }

  .prose :global(code) {
    padding: 0.1em 0.3em;
    border-radius: var(--radius-sm);
    background: var(--surface-3);
    font-family: var(--font-mono);
    font-size: 0.9em;
  }

  .prose :global(pre) {
    margin: 0 0 0.75em;
    padding: 0.75em 0.9em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    overflow-x: auto;
  }

  .prose :global(pre code) {
    padding: 0;
    background: none;
    font-size: 0.88em;
    line-height: 1.5;
    white-space: pre;
  }

  /* A wide table scrolls inside its own box rather than squeezing its columns. */
  .prose :global(.table-wrap) {
    margin: 0 0 0.9em;
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .prose :global(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.95em;
    line-height: 1.45;
  }

  .prose :global(th),
  .prose :global(td) {
    padding: 0.4em 0.7em;
    border-bottom: 1px solid var(--surface-3);
    text-align: left;
    vertical-align: top;
    /* Wraps at spaces first, so a column is never narrower than its longest word. */
    overflow-wrap: normal;
    min-width: 4em;
  }

  .prose :global(th + th),
  .prose :global(td + td) {
    border-left: 1px solid var(--surface-3);
  }

  .prose :global(th) {
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }

  .prose :global(tbody tr:nth-child(even)) {
    background: color-mix(in srgb, var(--surface-2) 45%, transparent);
  }

  .prose :global(tbody tr:last-child td) {
    border-bottom: none;
  }

  .prose :global(.align-center) {
    text-align: center;
  }

  .prose :global(.align-right) {
    text-align: right;
  }

  .prose :global(hr) {
    margin: 1.2em 0;
    border: none;
    border-top: 1px solid var(--border);
  }

  .prose :global(a) {
    color: var(--accent);
    overflow-wrap: anywhere;
  }

  /* A link to another document on the board, written `[[ID]]`. */
  .prose :global(.node-link) {
    padding: 0 0.25em;
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    font-family: var(--font-mono);
    font-size: 0.9em;
    text-decoration: none;
    white-space: nowrap;
  }

  .prose :global(a.node-link:hover) {
    text-decoration: underline;
  }

  /* An id that the board does not hold. */
  /* A link to a document of the board library, written `[label](library:<id>)`. */
  .prose :global(a.library-link) {
    color: var(--accent);
    text-decoration: underline dotted;
    text-underline-offset: 0.15em;
  }

  .prose :global(.node-link.missing) {
    background: var(--surface-3);
    color: var(--ink-faint);
    text-decoration: line-through;
  }

  .prose :global(del) {
    color: var(--ink-faint);
  }
</style>
