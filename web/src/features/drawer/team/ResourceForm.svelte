<script lang="ts">
  import type { ConfigDto, NodePatch, ResourceDto } from '$shared';
  import AttributeField from '$lib/ui/fields/AttributeField.svelte';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import type { Coverage } from './roster.js';

  /**
   * The fields of one person or pool. Presentational: it reads a resource and
   * reports edits, and whoever holds it decides whether an edit lands on the
   * board straight away (`ResourceDialog`) or on a draft that is created later
   * (`NewResourceDialog`).
   */
  interface Props {
    resource: ResourceDto;
    config: ConfigDto;
    /** Every type it can be, the current one included. */
    types: { value: string; label: string }[];
    /** Teams it can sit in; empty when the roster does not nest at its level. */
    parents: ResourceDto[];
    coverage: Coverage | null;
    /** Whether a person covers this pool. Asked rather than read, see `toggleCoverer`. */
    covering: (coverer: ResourceDto) => boolean;
    onedit: (patch: NodePatch) => void;
    ontype: (type: string) => void;
    oncover: (poolId: string, on: boolean) => void;
    oncoverer: (coverer: ResourceDto, on: boolean) => void;
    /** Report the name on every keystroke and put the cursor in it — for a draft. */
    eager?: boolean;
    /** Enter in the name field. */
    onsubmit?: () => void;
  }

  let {
    resource,
    config,
    types,
    parents,
    coverage,
    covering,
    onedit,
    ontype,
    oncover,
    oncoverer,
    eager = false,
    onsubmit,
  }: Props = $props();

  const type = $derived(config.types[resource.type]);

  let nameInput = $state<HTMLInputElement>();
  $effect(() => {
    if (eager) nameInput?.focus();
  });
</script>

<div class="fields">
  <label>
    <span>Name</span>
    <input
      bind:this={nameInput}
      value={resource.title}
      placeholder={eager ? `Name this ${type?.label ?? 'resource'}` : undefined}
      oninput={(event) => eager && onedit({ title: event.currentTarget.value })}
      onchange={(event) => !eager && onedit({ title: event.currentTarget.value })}
      onkeydown={(event) => {
        if (event.key === 'Enter' && onsubmit) {
          event.preventDefault();
          onsubmit();
        }
      }}
    />
  </label>

  <label>
    <span>Type</span>
    <select value={resource.type} onchange={(event) => ontype(event.currentTarget.value)}>
      {#each types as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  </label>

  {#if parents.length}
    <label>
      <span>Team</span>
      <select
        value={resource.parentId ?? ''}
        onchange={(event) => onedit({ parentId: event.currentTarget.value || null })}
      >
        <option value="">Unattached</option>
        {#each parents as parent (parent.id)}
          <option value={parent.id}>{parent.title}</option>
        {/each}
      </select>
    </label>
  {/if}

  <label>
    <span>Capacity</span>
    <input
      type="number"
      min="0"
      step="0.5"
      value={resource.capacity}
      onchange={(event) => onedit({ capacity: Number(event.currentTarget.value) || 0 })}
    />
  </label>
</div>

{#if coverage?.pools.length}
  <h4>Covers</h4>
  <p class="note">Pools this {type?.label ?? 'resource'} can pick work up from.</p>
  <ul class="checks">
    {#each coverage.pools as pool (pool.id)}
      <li>
        <label>
          <input
            type="checkbox"
            checked={resource.covers.includes(pool.id)}
            onchange={(event) => oncover(pool.id, event.currentTarget.checked)}
          />
          <span class="icon"><TypeIcon type={pool.type} depth={pool.depth} /></span>
          {pool.title}
          <span class="muted">{config.types[pool.type]?.label ?? pool.type}</span>
        </label>
      </li>
    {/each}
  </ul>
{/if}

{#if resource.generic}
  <h4>Covered by</h4>
  {#if coverage?.coverers.length}
    <p class="note">Who can take work from this pool.</p>
    <ul class="checks">
      {#each coverage.coverers as coverer (coverer.id)}
        <li>
          <label>
            <input
              type="checkbox"
              checked={covering(coverer)}
              onchange={(event) => oncoverer(coverer, event.currentTarget.checked)}
            />
            <span class="icon"><TypeIcon type={coverer.type} depth={coverer.depth} /></span>
            {coverer.title}
          </label>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="note">Add a person to the team to cover this pool.</p>
  {/if}
{/if}

{#if type?.attributes.length}
  <h4>Attributes</h4>
  <div class="fields">
    {#each type.attributes as attribute (attribute.name)}
      <label>
        <span title={attribute.description}>{attribute.name.replace(/_/g, ' ')}</span>
        <AttributeField
          {attribute}
          value={resource.attributes[attribute.name]}
          onchange={(value) => onedit({ attributes: { [attribute.name]: value } })}
        />
      </label>
    {/each}
  </div>
{/if}

<h4>Notes</h4>
<textarea
  class="body"
  rows="6"
  value={resource.body}
  onchange={(event) => onedit({ body: event.currentTarget.value })}
></textarea>

<style>
  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  label {
    display: grid;
    grid-template-columns: 6rem 1fr;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  .fields label > span:first-child {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: capitalize;
  }

  .fields input,
  .fields select {
    width: 100%;
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-sm);
  }

  h4 {
    margin: var(--space-4) 0 var(--space-1);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-muted);
  }

  .note {
    margin: 0 0 var(--space-2);
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .checks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .checks label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0.15rem 0.3rem;
    border-radius: var(--radius-sm);
  }

  .checks label:hover {
    background: var(--surface-2);
  }

  .icon {
    display: inline-flex;
    color: var(--ink-muted);
  }

  .muted {
    margin-left: auto;
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .body {
    width: 100%;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.6;
    resize: vertical;
  }
</style>
