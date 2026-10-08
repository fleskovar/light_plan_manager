<script lang="ts">
  import { renderMarkdown } from './markdown.js';

  /**
   * A rendered document body. The HTML comes from `markdown.ts`, which escapes
   * its input before it does anything else — that is what makes `{@html}` here
   * a statement about this component rather than about the board.
   */
  interface Props {
    source: string;
    /** Shown when the body is empty, so the panel is never a blank box. */
    placeholder?: string;
  }

  let { source, placeholder = 'No description yet.' }: Props = $props();

  const html = $derived(renderMarkdown(source));
</script>

{#if html}
  <div class="prose">{@html html}</div>
{:else}
  <p class="empty">{placeholder}</p>
{/if}

<style>
  .prose {
    font-size: var(--text-sm);
    line-height: 1.6;
    overflow-wrap: anywhere;
  }

  .empty {
    margin: 0;
    color: var(--ink-faint);
    font-size: var(--text-sm);
    font-style: italic;
  }

  .prose :global(h1),
  .prose :global(h2),
  .prose :global(h3),
  .prose :global(h4),
  .prose :global(h5),
  .prose :global(h6) {
    margin: var(--space-3) 0 var(--space-1);
    font-size: var(--text-sm);
    font-weight: 700;
    line-height: 1.3;
  }

  .prose :global(h1) {
    font-size: var(--text-md);
  }

  .prose :global(:first-child) {
    margin-top: 0;
  }

  .prose :global(p) {
    margin: 0 0 var(--space-2);
  }

  .prose :global(ul),
  .prose :global(ol) {
    margin: 0 0 var(--space-2);
    padding-left: 1.2rem;
  }

  .prose :global(li) {
    margin: 0.1rem 0;
  }

  .prose :global(li.task) {
    list-style: none;
    margin-left: -1.1rem;
  }

  .prose :global(li.task input) {
    margin-right: 0.35rem;
    vertical-align: -1px;
  }

  /* A paragraph that continued a list item, not one of its own. */
  .prose :global(p.loose) {
    margin: 0 0 var(--space-1);
    padding-left: 1.2rem;
  }

  .prose :global(blockquote) {
    margin: 0 0 var(--space-2);
    padding: 0.1rem 0 0.1rem var(--space-2);
    border-left: 3px solid var(--border-strong);
    color: var(--ink-muted);
  }

  .prose :global(code) {
    padding: 0.05rem 0.25rem;
    border-radius: var(--radius-sm);
    background: var(--surface-3);
    font-family: var(--font-mono);
    font-size: 0.92em;
  }

  .prose :global(pre) {
    margin: 0 0 var(--space-2);
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    overflow-x: auto;
  }

  .prose :global(pre code) {
    padding: 0;
    background: none;
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .prose :global(hr) {
    margin: var(--space-3) 0;
    border: none;
    border-top: 1px solid var(--border);
  }

  .prose :global(a) {
    color: var(--accent);
  }

  .prose :global(del) {
    color: var(--ink-faint);
  }
</style>
