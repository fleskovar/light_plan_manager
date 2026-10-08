<script lang="ts">
  import type { MenuEntry } from './types.js';
  import { isHeading, isSeparator } from './types.js';
  import Self from './MenuList.svelte';

  interface Props {
    entries: MenuEntry[];
    onselect: () => void;
  }

  let { entries, onselect }: Props = $props();
  let openIndex = $state<number | null>(null);
  let submenu = $state<HTMLDivElement | null>(null);
  /** Set once, when the submenu turns out not to fit on that side. */
  let flipped = $state(false);
  let raised = $state(false);

  /**
   * A list of every teammate on the board is long, and a menu is not a page:
   * let a leaf list scroll rather than run off the bottom. Only a leaf — a list
   * with submenus in it cannot clip its own overflow without clipping them.
   */
  const leaf = $derived(
    entries.every((entry) => isSeparator(entry) || isHeading(entry) || !entry.items),
  );

  // Both corrections only ever turn *on*: measuring after a move would read the
  // corrected position and undo itself. A different submenu starts over.
  $effect(() => {
    const node = submenu;
    if (!node) return;
    const box = node.getBoundingClientRect();
    if (box.right > window.innerWidth - 8) flipped = true;
    if (box.bottom > window.innerHeight - 8) raised = true;
  });

  function open(index: number | null): void {
    if (index === openIndex) return;
    openIndex = index;
    flipped = false;
    raised = false;
  }
</script>

<ul class="menu" class:leaf role="menu">
  {#each entries as entry, index (index)}
    {#if isSeparator(entry)}
      <li class="separator" role="separator"></li>
    {:else if isHeading(entry)}
      <li class="heading" role="presentation">{entry.heading}</li>
    {:else}
      <li class="row" role="none" onmouseenter={() => open(entry.items ? index : null)}>
        <button
          type="button"
          role="menuitem"
          class:danger={entry.danger}
          disabled={entry.disabled}
          aria-haspopup={entry.items ? 'menu' : undefined}
          aria-expanded={entry.items ? openIndex === index : undefined}
          onclick={() => {
            if (entry.items) return;
            entry.onSelect?.();
            onselect();
          }}
        >
          <span class="label">{entry.label}</span>
          {#if entry.hint}<span class="hint">{entry.hint}</span>{/if}
          {#if entry.items}<span class="chevron">›</span>{/if}
        </button>

        {#if entry.items && openIndex === index}
          <div bind:this={submenu} class="submenu" class:flipped class:raised>
            <Self entries={entry.items} {onselect} />
          </div>
        {/if}
      </li>
    {/if}
  {/each}
</ul>

<style>
  .menu {
    min-width: 12rem;
    margin: 0;
    padding: var(--space-1);
    list-style: none;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
  }

  .menu.leaf {
    max-height: min(60vh, 26rem);
    overflow-y: auto;
  }

  .row {
    position: relative;
  }

  button {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: 0.3rem 0.5rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    font-size: var(--text-sm);
    text-align: left;
  }

  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--surface-2);
  }

  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .label {
    flex: 1;
    white-space: nowrap;
  }

  .hint,
  .chevron {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .danger {
    color: var(--danger);
  }

  .separator {
    height: 1px;
    margin: var(--space-1) 0;
    background: var(--border);
  }

  .heading {
    padding: 0.25rem 0.5rem;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .submenu {
    position: absolute;
    top: -0.25rem;
    left: 100%;
    z-index: 1;
  }

  .submenu.flipped {
    left: auto;
    right: 100%;
  }

  .submenu.raised {
    top: auto;
    bottom: -0.25rem;
  }
</style>
