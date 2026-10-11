<script lang="ts" module>
  /**
   * The open dialogs, the newest last. A dialog can open another dialog: the
   * board configuration opens the git setup form and the confirmation of a
   * removal. Each dialog listens for Escape on the window, so without this
   * list one key press closes every dialog at once.
   */
  const stack: symbol[] = [];
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    /** Width of the dialog; wide dialogs (the import table) ask for 'lg'. */
    size?: 'sm' | 'md' | 'lg';
    /**
     * Give the dialog one height, whatever it holds. Without it the dialog is
     * as tall as its content, up to 85% of the window. A dialog with tabs sets
     * this, or the dialog changes height with each tab and its controls move.
     *
     * With it, the body does not scroll. The body is a column, and the caller
     * marks the part that scrolls with `flex: 1; min-height: 0; overflow: auto`.
     */
    fixedHeight?: boolean;
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
  }

  let { title, size = 'md', fixedHeight = false, onclose, children, footer }: Props = $props();

  const self = Symbol('modal');

  onMount(() => {
    stack.push(self);
    return () => {
      const index = stack.indexOf(self);
      if (index !== -1) stack.splice(index, 1);
    };
  });

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || stack.at(-1) !== self) return;
    event.stopPropagation();
    onclose();
  }
</script>

<svelte:window on:keydown={onkeydown} />

<!-- Clicking the backdrop closes; clicks inside the dialog bubble to here too,
     so the target check is what tells the two apart. -->
<div
  class="scrim"
  role="presentation"
  onclick={(event) => event.target === event.currentTarget && onclose()}
>
  <div
    class="dialog {size}"
    class:fixed={fixedHeight}
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
  >
    <header>
      <h2>{title}</h2>
      <button class="close" type="button" onclick={onclose} aria-label="Close">×</button>
    </header>
    <div class="body" class:column={fixedHeight}>{@render children()}</div>
    {#if footer}
      <footer>{@render footer()}</footer>
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: var(--space-5);
    background: rgb(0 0 0 / 0.45);
  }

  .dialog {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-height: 85vh;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
  }

  /* The lesser of 85% of the window and 48rem: a tall monitor does not get a
     dialog that is mostly empty, and a small window still shows the footer. */
  .dialog.fixed {
    height: min(85vh, 48rem);
  }

  .sm {
    max-width: 24rem;
  }
  .md {
    max-width: 34rem;
  }
  .lg {
    max-width: 62rem;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  h2 {
    margin: 0;
    font-size: var(--text-lg);
  }

  .close {
    border: none;
    background: none;
    font-size: 1.4rem;
    line-height: 1;
    color: var(--ink-muted);
    padding: 0 var(--space-2);
  }

  .body {
    flex: 1;
    overflow: auto;
    padding: var(--space-4);
  }

  .body.column {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border);
  }
</style>
