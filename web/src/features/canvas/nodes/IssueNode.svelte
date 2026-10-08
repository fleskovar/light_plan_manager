<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import type { CanvasNodeData } from '../model.js';
  import { useGraphSource } from '../source.js';
  import NodeShell from './NodeShell.svelte';

  /** A leaf on the canvas, or a collapsed subflow standing in for its contents. */
  let { data, selected }: NodeProps & { data: CanvasNodeData } = $props();

  // SvelteFlow constructs these itself, so the collapse and resize handlers
  // arrive through the canvas's context rather than as props. Neither touches
  // the board — a size is view state — which is why the same component serves
  // the read-only viewer.
  const source = useGraphSource();
</script>

<NodeShell
  {data}
  selected={selected ?? false}
  ontoggle={(id) => source.toggleCollapsed(id)}
  onresize={(id, size) => source.setLayout(id, size)}
>
  {#snippet footer()}
    {#if data.assigneeLabel}
      <span class="assignee" title="Assigned to {data.assigneeLabel}">{data.assigneeLabel}</span>
    {/if}
    {#if data.effort !== null}
      <span class="effort" title="Effort">{data.effort}</span>
    {/if}
    {#if data.collapsed}
      <span class="rolled">collapsed</span>
    {/if}
  {/snippet}
</NodeShell>

<style>
  .assignee {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .effort,
  .rolled {
    margin-left: auto;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--surface-3);
    font-weight: 600;
  }
</style>
