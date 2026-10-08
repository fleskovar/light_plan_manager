<script lang="ts">
  import type { ConfigDto } from '$shared';
  import { statusTone } from '$lib/board/selectors.js';

  interface Props {
    config: ConfigDto;
    status: string;
    /** Render as a select so the status can be changed in place. */
    editable?: boolean;
    onchange?: (status: string) => void;
  }

  let { config, status, editable = false, onchange }: Props = $props();

  const tone = $derived(statusTone(config, status));
  const label = $derived(config.statuses.find((entry) => entry.id === status)?.label ?? status);
</script>

{#if editable}
  <select
    class="chip tone-{tone}"
    value={status}
    onchange={(event) => onchange?.(event.currentTarget.value)}
    aria-label="Status"
  >
    {#each config.statuses as option (option.id)}
      <option value={option.id}>{option.label}</option>
    {/each}
  </select>
{:else}
  <span class="chip tone-{tone}">{label}</span>
{/if}

<style>
  .chip {
    display: inline-block;
    max-width: 12rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    border: 1px solid transparent;
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  select.chip {
    appearance: none;
    cursor: pointer;
  }

  .tone-todo {
    background: var(--tone-todo-soft);
    color: var(--tone-todo);
    border-color: color-mix(in srgb, var(--tone-todo) 30%, transparent);
  }
  .tone-active {
    background: var(--tone-active-soft);
    color: var(--tone-active);
    border-color: color-mix(in srgb, var(--tone-active) 30%, transparent);
  }
  .tone-blocked {
    background: var(--tone-blocked-soft);
    color: var(--tone-blocked);
    border-color: color-mix(in srgb, var(--tone-blocked) 30%, transparent);
  }
  .tone-review {
    background: var(--tone-review-soft);
    color: var(--tone-review);
    border-color: color-mix(in srgb, var(--tone-review) 30%, transparent);
  }
  .tone-done {
    background: var(--tone-done-soft);
    color: var(--tone-done);
    border-color: color-mix(in srgb, var(--tone-done) 30%, transparent);
  }
</style>
