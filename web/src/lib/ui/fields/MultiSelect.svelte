<script lang="ts">
  /**
   * A multi-select dropdown with fuzzy search and a one-click clear.
   *
   * Renders as a compact trigger button showing the count of selected items.
   * The dropdown opens on click and offers a search input that filters the
   * option list with case-insensitive substring matching.  A "Clear all"
   * button resets the selection in one gesture.
   *
   * The caller owns the selection (a `Set<string>`) and receives a new Set
   * via `onchange` on every toggle or clear — never mutated in place.
   */
  interface Props {
    /** Available options. */
    options: { value: string; label: string }[];
    /** Currently selected values (caller-owned, not mutated internally). */
    selected: Set<string>;
    /** Shown on the trigger when nothing is selected. */
    placeholder?: string;
    /** Called with a *new* Set whenever the selection changes. */
    onchange: (selected: Set<string>) => void;
  }

  let {
    options,
    selected,
    placeholder = 'Select…',
    onchange,
  }: Props = $props();

  let open = $state(false);
  let search = $state('');
  let container = $state<HTMLElement | null>(null);

  const filtered = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        option.value.toLowerCase().includes(needle),
    );
  });

  const display = $derived(
    selected.size > 0 ? `${placeholder} (${selected.size})` : placeholder,
  );

  function toggle(value: string): void {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onchange(next);
  }

  function clearAll(): void {
    if (selected.size === 0) return;
    onchange(new Set());
  }

  function close(): void {
    open = false;
    search = '';
  }

  function handleClickOutside(event: MouseEvent): void {
    if (open && container && !container.contains(event.target as Node)) {
      close();
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }
</script>

<svelte:window onclick={handleClickOutside} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="multi-select" bind:this={container} onkeydown={handleKeydown}>
  <button
    type="button"
    class="trigger"
    class:active={open || selected.size > 0}
    onclick={() => (open = !open)}
    aria-expanded={open}
    aria-haspopup="listbox"
  >
    <span class="label">{display}</span>
    <span class="arrow">{open ? '▴' : '▾'}</span>
  </button>

  {#if open}
    <div class="dropdown" role="listbox" aria-multiselectable="true">
      <div class="head">
        <input
          class="search"
          type="text"
          bind:value={search}
          placeholder="Search…"
          aria-label="Search options"
        />
        {#if selected.size > 0}
          <button type="button" class="clear" onclick={clearAll}>
            Clear all
          </button>
        {/if}
      </div>
      <div class="list">
        {#each filtered as option (option.value)}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            class="item"
            class:checked={selected.has(option.value)}
            role="option"
            aria-selected={selected.has(option.value)}
          >
            <input
              type="checkbox"
              checked={selected.has(option.value)}
              onchange={() => toggle(option.value)}
            />
            <span>{option.label}</span>
          </div>
        {/each}
        {#if filtered.length === 0}
          <span class="empty">No matches</span>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .multi-select {
    position: relative;
    display: inline-flex;
  }

  .trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    font-size: var(--text-xs);
    cursor: default;
    white-space: nowrap;
  }

  .trigger.active {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  .arrow {
    font-size: 0.6rem;
    color: var(--ink-faint);
  }

  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 20;
    min-width: 12rem;
    max-height: 18rem;
    display: flex;
    flex-direction: column;
    margin-top: 2px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1);
    border-bottom: 1px solid var(--border);
  }

  .search {
    flex: 1;
    min-width: 0;
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-xs);
  }

  .clear {
    flex: none;
    padding: 0.15rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    font-size: var(--text-xs);
    color: var(--ink-muted);
    white-space: nowrap;
  }

  .clear:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .list {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-1) 0;
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0.2rem var(--space-2);
    font-size: var(--text-xs);
    cursor: default;
  }

  .item:hover {
    background: var(--surface-2);
  }

  .item input {
    flex: none;
  }

  .item span {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    display: block;
    padding: var(--space-2);
    text-align: center;
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }
</style>
