<script lang="ts">
  import type { ConfigDto } from '$shared';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import type { RosterEntry } from './roster.js';

  /**
   * A person or a pool. Draggable: dropping one onto a canvas node assigns it,
   * which is the fastest way to staff a graph.
   */
  interface Props {
    entry: RosterEntry;
    config: ConfigDto;
    selected: boolean;
    onselect: (id: string) => void;
    onedit: (id: string, patch: Record<string, unknown>) => void;
    /** Open the full editor: type, team, coverage, attributes, notes. */
    onopen: (id: string) => void;
    onremove: (id: string) => void;
  }

  let { entry, config, selected, onselect, onedit, onopen, onremove }: Props = $props();

  const resource = $derived(entry.resource);
  const utilisation = $derived(
    resource.capacity > 0 ? (entry.load + entry.poolLoad) / resource.capacity : 0,
  );
</script>

<article
  class="card"
  class:selected
  class:generic={resource.generic}
  draggable="true"
  aria-label={resource.title}
  ondragstart={(event) => {
    event.dataTransfer?.setData('application/x-lpm-resource', resource.id);
    event.dataTransfer?.setData('text/plain', resource.title);
  }}
>
  <header>
    <button
      class="pick"
      type="button"
      aria-label="Select {resource.title}"
      onclick={() => onselect(resource.id)}
    >
      <TypeIcon type={resource.type} depth={resource.depth} />
    </button>
    <input
      class="name"
      value={resource.title}
      onchange={(event) => onedit(resource.id, { title: event.currentTarget.value })}
    />
    <button
      class="icon-button"
      type="button"
      title="Edit {resource.title}"
      aria-label="Edit {resource.title}"
      onclick={() => onopen(resource.id)}
    >
      <!-- Pencil. Inline rather than in TypeIcon: that maps document types to
           glyphs, and this is an action. -->
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M11.4 2.3a1.6 1.6 0 0 1 2.3 2.3L5.5 12.8l-3 .7.7-3z" />
        <path d="M10.2 3.5 12.5 5.8" />
      </svg>
    </button>
    <button
      class="icon-button remove"
      type="button"
      aria-label="Remove {resource.title}"
      onclick={() => onremove(resource.id)}
    >
      ×
    </button>
  </header>

  <p class="type">
    {config.types[resource.type]?.label ?? resource.type}
    {#if resource.generic}<span class="pill">pool</span>{/if}
  </p>

  <dl>
    <div>
      <dt>Capacity</dt>
      <dd>
        <input
          class="capacity"
          type="number"
          min="0"
          step="0.5"
          value={resource.capacity}
          onchange={(event) =>
            onedit(resource.id, { capacity: Number(event.currentTarget.value) || 0 })}
        />
      </dd>
    </div>
    <div>
      <dt>Assigned</dt>
      <dd>{entry.assigned} issue{entry.assigned === 1 ? '' : 's'} · {entry.load}</dd>
    </div>
    {#if entry.poolLoad > 0}
      <div>
        <dt>In pools</dt>
        <dd>{entry.poolLoad}</dd>
      </div>
    {/if}
  </dl>

  <!-- Coverage reads on the card and is edited in the dialog: a multi-select
       big enough to be usable took more room than everything else together. -->
  {#if !resource.generic}
    <p class="covered">
      <button type="button" class="link" onclick={() => onopen(resource.id)}>
        {#if entry.covers.length}
          Covers {entry.covers.map((one) => one.title).join(', ')}
        {:else}
          Covers no pool
        {/if}
      </button>
    </p>
  {:else}
    <p class="covered">
      <button type="button" class="link" onclick={() => onopen(resource.id)}>
        {#if entry.coveredBy.length}
          Covered by {entry.coveredBy.map((one) => one.title).join(', ')}
        {:else}
          Not covered by anyone
        {/if}
      </button>
    </p>
  {/if}

  <div
    class="meter"
    title="{Math.round(utilisation * 100)}% of capacity"
    style="--fill: {Math.min(utilisation, 1.5) * 100}%"
    class:over={utilisation > 1}
  ></div>
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    cursor: grab;
  }

  .card.generic {
    border-style: dashed;
    background: var(--surface-0);
  }

  .card.selected {
    outline: 2px solid var(--accent);
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .pick {
    display: inline-flex;
    padding: 0;
    border: none;
    background: none;
    color: var(--ink-muted);
  }

  .name {
    flex: 1;
    min-width: 4rem;
    padding: 0.1rem 0.25rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    font-weight: 600;
    font-size: var(--text-sm);
  }

  .name:hover,
  .name:focus {
    border-color: var(--border);
    background: var(--surface-0);
  }

  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.3rem;
    height: 1.3rem;
    flex: none;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-faint);
    line-height: 1;
  }

  .icon-button:hover {
    background: var(--surface-3);
    color: var(--ink);
  }

  .remove {
    font-size: 1rem;
  }

  .type {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .pill {
    margin-left: var(--space-1);
    padding: 0 0.3rem;
    border-radius: 999px;
    background: var(--surface-3);
  }

  dl {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    font-size: var(--text-xs);
  }

  dl div {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  dt {
    color: var(--ink-faint);
  }

  dd {
    margin: 0;
  }

  .capacity {
    width: 3.5rem;
    padding: 0.05rem 0.2rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-xs);
  }

  .covered {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .link {
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    font-size: inherit;
    text-align: left;
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }

  .link:hover {
    color: var(--ink);
  }

  .meter {
    height: 3px;
    margin-top: var(--space-1);
    border-radius: 999px;
    background: var(--surface-3);
    background-image: linear-gradient(var(--tone-active), var(--tone-active));
    background-repeat: no-repeat;
    background-size: var(--fill) 100%;
  }

  .meter.over {
    background-image: linear-gradient(var(--tone-blocked), var(--tone-blocked));
  }
</style>
