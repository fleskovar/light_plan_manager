<script lang="ts">
  import type { ConfigDto, NodeDto } from '$shared';
  import { plansWithPeriods } from '$shared';
  import { nodesOfKind } from '$lib/board/selectors.js';
  import type { WorkingNodes } from '$lib/board/working.js';
  import { conversionOptions } from '$features/canvas/menus.js';
  import type { Workspace } from '$lib/workspace/workspace.svelte.js';

  /** The reserved fields: the ones every document of this kind has. */
  interface Props {
    workspace: Workspace;
    node: NodeDto;
    config: ConfigDto;
    nodes: WorkingNodes;
    onedit: (patch: Record<string, unknown>) => void;
  }

  let { workspace, node, config, nodes, onedit }: Props = $props();

  const issue = $derived(node.kind === 'issue' ? node : null);
  const period = $derived(node.kind === 'period' ? node : null);
  const resource = $derived(node.kind === 'resource' ? node : null);
  const conversions = $derived(conversionOptions(workspace, node));
</script>

<div class="fields">
  <label>
    <span>Title</span>
    <input value={node.title} onchange={(event) => onedit({ title: event.currentTarget.value })} />
  </label>

  <label>
    <span>Type</span>
    <select
      value={node.type}
      onchange={(event) => {
        const option = conversions.find((entry) => entry.type === event.currentTarget.value);
        if (option) onedit({ type: option.type, parentId: option.parentId });
      }}
    >
      <option value={node.type}>{config.types[node.type]?.label ?? node.type}</option>
      {#each conversions as option (option.type)}
        <option value={option.type}>{option.label}</option>
      {/each}
    </select>
  </label>

  {#if issue}
    <label>
      <span>Status</span>
      <select value={issue.status} onchange={(event) => onedit({ status: event.currentTarget.value })}>
        {#each config.statuses as status (status.id)}
          <option value={status.id}>{status.label}</option>
        {/each}
      </select>
    </label>

    {#if config.hasResources}
      <label>
        <span>Assignee</span>
        <select
          value={issue.assignee ?? ''}
          onchange={(event) => onedit({ assignee: event.currentTarget.value || null })}
        >
          <option value="">Unassigned</option>
          {#each nodesOfKind(nodes, 'resource') as one (one.id)}
            <option value={one.id}>{one.title}{one.generic ? ' (pool)' : ''}</option>
          {/each}
        </select>
      </label>
    {/if}

    <!-- Queue mode keeps every issue's period on disk and out of sight: the
         board is one run, and switching back restores the plan unchanged. -->
    {#if plansWithPeriods(config)}
      <label>
        <span>Period</span>
        <select
          value={issue.period ?? ''}
          onchange={(event) => onedit({ period: event.currentTarget.value || null })}
        >
          <option value="">Unscheduled</option>
          {#each nodesOfKind(nodes, 'period') as one (one.id)}
            <option value={one.id}>{one.title}</option>
          {/each}
        </select>
      </label>
    {/if}
  {/if}

  {#if period}
    <label>
      <span>Starts</span>
      <input
        type="date"
        value={period.starts ?? ''}
        onchange={(event) => onedit({ starts: event.currentTarget.value })}
      />
    </label>
    <label>
      <span>Ends</span>
      <input
        type="date"
        value={period.ends ?? ''}
        onchange={(event) => onedit({ ends: event.currentTarget.value })}
      />
    </label>
  {/if}

  {#if resource}
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
  {/if}

  <!-- Parenting is changed by dragging on the canvas or by converting a type,
       never by typing here, so it is shown rather than edited. -->
  <div class="row">
    <span>Parent</span>
    <span class="readonly">
      {node.parentId ? (nodes[node.parentId]?.title ?? node.parentId) : '—'}
    </span>
  </div>
</div>

<style>
  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  label,
  .row {
    display: grid;
    grid-template-columns: 5.5rem 1fr;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  label > span:first-child,
  .row > span:first-child {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  input,
  select {
    width: 100%;
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-sm);
  }

  .readonly {
    color: var(--ink-muted);
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
