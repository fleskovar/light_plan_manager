<script module lang="ts">
  export interface TabItem {
    id: string;
    label: string;
    /** True when the layout of the view waits for a Save. */
    unsaved: boolean;
  }
</script>

<script lang="ts">
  /**
   * The open views of this window, one button for each, in a row.
   *
   * Presentational: the parent owns the tabs and passes the callbacks. A click
   * selects a tab, a middle click or the × closes it, and a right-click asks
   * the parent for a menu. The row takes the width of its container and
   * scrolls sideways when the tabs need more room.
   */
  interface Props {
    tabs: TabItem[];
    active: string | null;
    onselect: (id: string) => void;
    onclose: (id: string) => void;
    onmenu: (event: MouseEvent, id: string) => void;
    onadd: () => void;
  }

  let { tabs, active, onselect, onclose, onmenu, onadd }: Props = $props();

  // The last tab of a window stays open, so it shows no × to press.
  const closable = $derived(tabs.length > 1);

  let strip = $state<HTMLDivElement | null>(null);

  // A window with many tabs scrolls the strip. Keep the active tab in sight.
  $effect(() => {
    void active;
    strip?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
</script>

<div bind:this={strip} class="tabs" role="tablist" aria-label="Open views">
  {#each tabs as tab (tab.id)}
    <div
      class="tab"
      class:active={tab.id === active}
      role="presentation"
      oncontextmenu={(event) => onmenu(event, tab.id)}
    >
      <button
        class="select"
        type="button"
        role="tab"
        aria-selected={tab.id === active}
        title={tab.unsaved ? `${tab.label}: the layout is not saved` : tab.label}
        onclick={() => onselect(tab.id)}
        onauxclick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onclose(tab.id);
        }}
      >
        {#if tab.unsaved}<span class="dot" aria-hidden="true">●</span>{/if}
        <span class="label">{tab.label}</span>
      </button>
      {#if closable}
        <button
          class="close"
          type="button"
          title="Close this tab"
          aria-label="Close {tab.label}"
          onclick={() => onclose(tab.id)}
        >
          ×
        </button>
      {/if}
    </div>
  {/each}
  <button class="add" type="button" title="New view" aria-label="New view" onclick={onadd}>+</button>
</div>

<style>
  .tabs {
    flex: none;
    display: flex;
    align-items: stretch;
    gap: var(--space-1);
    min-width: 0;
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    overflow-x: auto;
    scrollbar-width: none;
  }

  /* Each tab has the border and the surface of a button. */
  .tab {
    flex: none;
    display: flex;
    align-items: center;
    max-width: 14rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    color: var(--ink-muted);
  }

  .tab:hover {
    background: var(--surface-2);
    border-color: var(--border-strong);
    color: var(--ink);
  }

  .tab.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--ink);
  }

  .select {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
    padding: 0.2rem 0.5rem;
    border: none;
    background: none;
    color: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dot {
    flex: none;
    color: var(--warn);
    font-size: 0.6em;
  }

  .close,
  .add {
    flex: none;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-faint);
    font-size: var(--text-md);
    line-height: 1;
  }

  .close {
    margin-right: 0.15rem;
    padding: 0.1rem 0.25rem;
  }

  .add {
    padding: 0 0.5rem;
  }

  .close:hover,
  .add:hover {
    background: var(--surface-3);
    color: var(--ink);
  }
</style>
