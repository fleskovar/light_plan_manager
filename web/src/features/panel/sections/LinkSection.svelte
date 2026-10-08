<script lang="ts">
  import type { ConfigDto } from '$shared';
  import { statusTone } from '$lib/board/selectors.js';
  import type { WorkingNodes } from '$lib/board/working.js';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';

  /**
   * One labelled list of linked documents, with a button to break each link.
   * Every relationship the panel shows is this
   * shape, so the rendering lives here once and the sections above only decide
   * which ids to pass in and what to call them.
   */
  interface Props {
    nodes: WorkingNodes;
    config: ConfigDto;
    heading: string;
    ids: string[];
    empty: string;
    /** Tooltip on the × button, e.g. "Remove dependency". */
    unlinkLabel?: string;
    onopen: (id: string) => void;
    /**
     * Omitted for a list nobody can edit — a relationship the board reads off
     * the work inside two containers has no edge to break here, so it is shown
     * without the button rather than with one that would do nothing.
     */
    onunlink?: (id: string) => void;
  }

  let { nodes, config, heading, ids, empty, unlinkLabel, onopen, onunlink }: Props = $props();
</script>

<h4>{heading}</h4>
{#if !ids.length}
  <p class="empty">{empty}</p>
{:else}
  <ul>
    {#each ids as id (id)}
      {@const node = nodes[id]}
      <li>
        <button type="button" onclick={() => onopen(id)}>
          <span class="dot tone-{node?.kind === 'issue' ? statusTone(config, node.status) : 'todo'}"
          ></span>
          <span class="icon"><TypeIcon type={node?.type ?? ''} depth={node?.depth ?? 0} /></span>
          <span class="id">{id}</span>
          <span class="title">{node?.title ?? 'not in this board'}</span>
        </button>
        {#if onunlink}
          <button
            class="unlink"
            type="button"
            aria-label={unlinkLabel}
            title={unlinkLabel}
            onclick={() => onunlink(id)}
          >
            ×
          </button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  h4 {
    margin: var(--space-3) 0 var(--space-1);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
  }

  li > button:first-child {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0.2rem 0.3rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    text-align: left;
    font-size: var(--text-sm);
    min-width: 0;
  }

  li > button:first-child:hover {
    background: var(--surface-2);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--tone);
    flex: none;
  }

  .tone-todo {
    --tone: var(--tone-todo);
  }
  .tone-active {
    --tone: var(--tone-active);
  }
  .tone-blocked {
    --tone: var(--tone-blocked);
  }
  .tone-review {
    --tone: var(--tone-review);
  }
  .tone-done {
    --tone: var(--tone-done);
  }

  .icon {
    display: inline-flex;
    color: var(--ink-muted);
  }

  .id {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .unlink {
    border: none;
    background: none;
    color: var(--ink-faint);
    line-height: 1;
  }

  .empty {
    margin: 0;
    padding: 0.2rem 0.3rem;
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }
</style>
