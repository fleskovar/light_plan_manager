<script lang="ts">
  /**
   * The control beside one tracker item: the board items that map to it, and a
   * dropdown that adds one. Each chosen item has a button that removes it.
   *
   * Presentational. The caller decides what adding and removing mean.
   */
  interface Option {
    id: string;
    label: string;
    /** Where the board item maps now, shown in the dropdown. */
    hint?: string;
  }

  interface Props {
    chosen: Option[];
    /** The board items that the dropdown offers. The chosen ones are not in the list. */
    options: Option[];
    placeholder: string;
    disabled?: boolean;
    onadd: (id: string) => void;
    onremove: (id: string) => void;
  }

  let { chosen, options, placeholder, disabled = false, onadd, onremove }: Props = $props();

  function pick(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    if (select.value) onadd(select.value);
    // The dropdown adds an item and goes back to its placeholder.
    select.value = '';
  }
</script>

<span class="picker">
  {#each chosen as item (item.id)}
    <span class="chip">
      {item.label}
      <button
        type="button"
        {disabled}
        aria-label="Remove {item.label}"
        title="Remove {item.label}"
        onclick={() => onremove(item.id)}
      >
        ×
      </button>
    </span>
  {/each}
  <select aria-label={placeholder} disabled={disabled || options.length === 0} onchange={pick}>
    <option value="">{placeholder}</option>
    {#each options as option (option.id)}
      <option value={option.id}>{option.label}{option.hint ? ` (${option.hint})` : ''}</option>
    {/each}
  </select>
</span>

<style>
  .picker {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-1);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 0.15rem 0 0.45rem;
    border: 1px solid var(--accent);
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .chip button {
    border: none;
    background: none;
    padding: 0 0.2rem;
    color: inherit;
    font-size: var(--text-sm);
    line-height: 1;
  }

  select {
    max-width: 11rem;
    padding: 0.15rem 0.3rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-xs);
  }
</style>
