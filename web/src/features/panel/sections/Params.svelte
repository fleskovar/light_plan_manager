<script lang="ts">
  import type { ParamDefs } from '$shared';
  import Button from '$lib/ui/Button.svelte';
  import { PARAM_TYPES, blankRow, fromRows, toRows, type ParamRow } from './params.js';

  /**
   * What a template asks for, on the template that is instantiated.
   *
   * Presentational: rows in, a whole parameter map out. Every rule about what a
   * row means lives in `params.ts` beside it.
   */
  interface Props {
    params: ParamDefs;
    /** True only on a root; nested templates take the root's answers. */
    root: boolean;
    onchange: (params: ParamDefs) => void;
  }

  let { params, root, onchange }: Props = $props();

  // Seeded once per selection: the panel is keyed on the node, so switching
  // documents rebuilds this component and re-reads the parameters.
  // svelte-ignore state_referenced_locally
  let rows = $state<ParamRow[]>(toRows(params));
  const result = $derived(fromRows(rows));

  function commit(): void {
    onchange(result.params);
  }
</script>

<h4>Parameters</h4>

{#if !root}
  <p class="hint">
    Uses the root template's parameters.
  </p>
{:else}
  <p class="hint">
    Use as <code>&#123;&#123;name&#125;&#125;</code> in titles, bodies, related files and attributes.
  </p>

  <div class="rows">
    {#each rows as row, index (index)}
      <div class="row">
        <input
          class="name"
          bind:value={row.name}
          onchange={commit}
          placeholder="name"
          aria-label="Parameter name"
        />
        <select bind:value={row.type} onchange={commit} aria-label="Parameter type">
          {#each PARAM_TYPES as type (type)}
            <option value={type}>{type}</option>
          {/each}
        </select>
        <label class="required">
          <input type="checkbox" bind:checked={row.required} onchange={commit} />
          required
        </label>
        <button
          class="discard"
          type="button"
          aria-label="Remove {row.name || 'parameter'}"
          onclick={() => {
            rows = rows.filter((_, at) => at !== index);
            commit();
          }}
        >
          ×
        </button>
        <input
          class="wide"
          bind:value={row.defaultText}
          onchange={commit}
          placeholder="default"
          aria-label="Default value"
        />
        <input
          class="wide"
          bind:value={row.description}
          onchange={commit}
          placeholder="what it is for"
          aria-label="Parameter description"
        />
        {#if row.type === 'enum'}
          <textarea
            class="wide values"
            bind:value={row.valuesText}
            onchange={commit}
            rows="3"
            placeholder="one allowed value per line"
            aria-label="Allowed values"
          ></textarea>
        {/if}
      </div>
    {/each}
  </div>

  {#each result.errors as error (error)}
    <p class="error">{error}</p>
  {/each}

  <Button size="sm" onclick={() => (rows = [...rows, blankRow()])}>Add parameter</Button>
{/if}

<style>
  .hint {
    margin: 0 0 var(--space-2);
    color: var(--ink-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }

  .row {
    display: grid;
    grid-template-columns: 1fr auto auto auto;
    gap: var(--space-1) var(--space-2);
    align-items: center;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .wide {
    grid-column: 1 / -1;
    width: 100%;
    box-sizing: border-box;
  }

  .values {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    resize: vertical;
  }

  .required {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--ink-muted);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .discard {
    border: none;
    background: none;
    color: var(--ink-faint);
    font-size: var(--text-md);
    line-height: 1;
  }

  .discard:hover {
    color: var(--danger);
  }

  .error {
    margin: 0 0 var(--space-2);
    color: var(--danger);
    font-size: var(--text-xs);
  }

  code {
    font-family: var(--font-mono);
  }
</style>
