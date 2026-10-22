<script lang="ts">
  import type { Crumb } from './scope.js';

  /**
   * The bar across the top of the canvas in edit mode.
   *
   * The left part shows the path from the whole view to the active item. A
   * click on a step makes that step the active item. The right part chooses
   * the type of a new item and adds one. The bar only reports clicks: the
   * canvas changes the active item and opens the title field.
   */
  interface Props {
    crumbs: Crumb[];
    /** The types that a new item can take here, in hierarchy order. */
    types: { value: string; label: string }[];
    /** The type that a new item takes, or null when no type is allowed. */
    chosen: string | null;
    onnavigate: (id: string | null) => void;
    onchoose: (type: string) => void;
    onadd: () => void;
  }

  let { crumbs, types, chosen, onnavigate, onchoose, onadd }: Props = $props();

  const chosenLabel = $derived(types.find((type) => type.value === chosen)?.label ?? '');
</script>

<div class="scope-bar" role="toolbar" aria-label="Edit mode">
  <nav aria-label="Active item">
    <ol>
      {#each crumbs as crumb, index (crumb.id ?? '')}
        {@const last = index === crumbs.length - 1}
        <li>
          {#if index > 0}<span class="separator" aria-hidden="true">›</span>{/if}
          <button
            type="button"
            class:current={last}
            aria-current={last ? 'location' : undefined}
            title={crumb.id ? `${crumb.typeLabel} ${crumb.id}: ${crumb.label}` : 'The whole view'}
            onclick={() => onnavigate(crumb.id)}
          >
            {#if crumb.id}<span class="id">{crumb.id}</span>{/if}
            <span class="label">{crumb.label}</span>
          </button>
        </li>
      {/each}
    </ol>
  </nav>

  {#if chosen}
    <div class="create">
      <label>
        <span class="visually-hidden">Type of a new item</span>
        <select
          value={chosen}
          onchange={(event) => onchoose((event.currentTarget as HTMLSelectElement).value)}
          disabled={types.length < 2}
        >
          {#each types as type (type.value)}
            <option value={type.value}>{type.label}</option>
          {/each}
        </select>
      </label>
      <button
        type="button"
        class="add"
        title="Add a {chosenLabel} (N). Double-click the canvas to add one at the pointer."
        onclick={onadd}
      >
        + Add
      </button>
    </div>
  {/if}
</div>

<style>
  .scope-bar {
    position: absolute;
    top: var(--space-3);
    left: var(--space-3);
    /* The toolbar with Arrange and Fit keeps the top-right corner. */
    right: 9rem;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--accent);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    box-shadow: var(--shadow-sm);
    font-size: var(--text-sm);
  }

  nav {
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  ol {
    display: flex;
    align-items: center;
    margin: 0;
    padding: 0;
    list-style: none;
    white-space: nowrap;
  }

  li {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  /* The steps before the last one give up their room first. */
  li:not(:last-child) {
    flex-shrink: 1;
  }

  li:last-child {
    flex-shrink: 0;
    max-width: 60%;
  }

  .separator {
    padding: 0 var(--space-1);
    color: var(--ink-faint);
  }

  nav button {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    min-width: 0;
    padding: 1px var(--space-1);
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-muted);
    font: inherit;
    cursor: pointer;
  }

  nav button:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  nav button.current {
    color: var(--ink);
    font-weight: 600;
  }

  .id {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--accent);
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .create {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-1);
  }

  select {
    padding: 1px var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
  }

  .add {
    padding: 1px var(--space-2);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-ink);
    font-size: var(--text-xs);
    font-weight: 600;
    cursor: pointer;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
