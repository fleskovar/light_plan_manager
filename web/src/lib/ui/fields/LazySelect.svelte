<script lang="ts">
  /**
   * A select that stays cheap until someone wants to change it.
   *
   * Every row in the table had a full `<select>` with one `<option>` per
   * resource or period — thousands of option elements on a large board, even
   * with virtualization. A row in read mode now shows the current value as
   * text; the `<select>` is only mounted while the cell is being edited.
   *
   * Keyboard: Enter or Space while focused activates editing; Escape or a
   * committed change returns to display mode.
   */
  interface Props {
    /** The current value (the id), or empty string for none. */
    value: string;
    /** Options for the select, as { value, label }. */
    options: { value: string; label: string }[];
    /** Shown when `value` is empty. */
    placeholder?: string;
    /** Called with the new value (the empty string for "none"). */
    onchange: (value: string) => void;
  }

  let { value, options, placeholder = '—', onchange }: Props = $props();

  let editing = $state(false);

  const display = $derived(options.find((option) => option.value === value)?.label ?? placeholder);

  function activate(): void {
    editing = true;
  }

  function commit(next: string): void {
    editing = false;
    if (next !== value) onchange(next);
  }

  function cancel(): void {
    editing = false;
  }

  function focusOnMount(node: HTMLElement): void {
    node.focus();
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      cancel();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation();
      activate();
    }
  }
</script>

{#if editing}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <select
    class="control editing"
    value={value}
    onclick={(event) => event.stopPropagation()}
    onchange={(event) => commit(event.currentTarget.value)}
    onkeydown={(event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        cancel();
      }
    }}
    onblur={() => cancel()}
    use:focusOnMount
  >
    <option value="">{placeholder}</option>
    {#each options as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </select>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span
    class="display"
    class:empty={!value}
    role="button"
    tabindex="0"
    title={display}
    onclick={(event) => {
      event.stopPropagation();
      activate();
    }}
    onkeydown={keydown}
  >
    {display}
  </span>
{/if}

<style>
  .display {
    display: block;
    max-width: 10rem;
    padding: 0.1rem 0.25rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: default;
  }

  .display.empty {
    color: var(--ink-faint);
  }

  .display:hover,
  .display:focus {
    border-color: var(--border);
    background: var(--surface-0);
  }

  .control {
    max-width: 10rem;
    padding: 0.1rem 0.25rem;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-xs);
  }
</style>
