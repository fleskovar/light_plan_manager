<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Handle, NodeResizer, Position } from '@xyflow/svelte';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import { flagLabel } from '$shared';
  import type { CanvasNodeData } from '../model.js';
  import { hasFlagInside, isRaisedFlag, isDriftSync, nodeMinSize } from './NodeShell.svelte.js';

  /**
   * The chrome every canvas node shares: the two handles, the type icon, the
   * id, the collapse chevron, the tone and the resize handles. A leaf fills the
   * body with its details; a subflow fills it with its children. Keeping the
   * frame in one place is what makes the two read as the same object at
   * different zooms.
   */
  interface Props {
    data: CanvasNodeData;
    selected: boolean;
    ontoggle: (id: string) => void;
    /** Where a drag on a corner ends up. Omitted where nothing may be resized. */
    onresize?: (id: string, size: { x: number; y: number; width: number; height: number }) => void;
    children?: Snippet;
    footer?: Snippet;
  }

  let { data, selected, ontoggle, onresize, children, footer }: Props = $props();

  const { minWidth, minHeight } = $derived(nodeMinSize(data));
</script>

<div
  class="node tone-{data.tone}"
  class:selected
  class:related={data.related}
  class:current={data.schedule?.current}
  class:group={data.group}
  class:flagged={isRaisedFlag(data)}
  class:holds-flag={hasFlagInside(data)}
  data-node-id={data.node.id}
>
  {#if onresize}
    <NodeResizer
      {minWidth}
      {minHeight}
      isVisible={selected}
      handleClass="lpm-resize-handle"
      lineClass="lpm-resize-line"
      onResizeEnd={(_event, params) => onresize?.(data.node.id, params)}
    />
  {/if}

  <Handle type="target" position={Position.Left} />

  {#if isDriftSync(data.sync)}
    <!-- Sync state is a different axis from status, so it reads as one: a small
         corner mark, never a fill, in colours that never meet the status tones. -->
    <span
      class="sync sync-{data.sync}"
      role="img"
      aria-label="Sync state: {data.sync}"
      title="Sync: {data.sync}"
    ></span>
  {/if}

  <header>
    {#if data.collapsible}
      <button
        class="chevron"
        class:collapsed={data.collapsed}
        type="button"
        title={data.collapsed ? 'Expand' : 'Collapse'}
        aria-label={data.collapsed ? 'Expand' : 'Collapse'}
        onclick={(event) => {
          event.stopPropagation();
          ontoggle(data.node.id);
        }}
      >
        ▾
      </button>
    {/if}
    <span class="icon"><TypeIcon type={data.node.type} depth={data.node.depth} /></span>
    <span class="id">{data.node.id}</span>
    <span class="type">{data.typeLabel}</span>

    <span class="marks">
      {#if data.flag}
        <!-- First in the row and never truncated: everything else on this node
             describes the plan, this one is a person asking for something. -->
        <span class="flag" title="Flagged: {flagLabel(data.flag)}">
          {flagLabel(data.flag)}
        </span>
      {:else if data.flaggedInside}
        <span
          class="flag inside"
          title="{data.flaggedInside} flagged issue{data.flaggedInside === 1 ? '' : 's'} inside"
        >
          ⚑{data.flaggedInside}
        </span>
      {/if}
      {#if data.schedule}
        <!-- The whole chain, because a sprint name alone does not say which
             increment it belongs to. -->
        <span
          class="period"
          class:now={data.schedule.current}
          title="Scheduled in {data.schedule.chain.join(' › ')}{data.schedule.current
            ? ' (current)'
            : ''}"
        >
          {data.schedule.chain.join(' · ')}
        </span>
      {/if}
      {#if data.templateRoot}
        <!-- The registry's one distinction: this is what `lpm template apply`
             takes, and everything under it comes with it. -->
        <span class="badge root" title="Template root">template</span>
      {/if}
      {#if data.hiddenChildren}
        <span class="badge" title="{data.hiddenChildren} child issues not in this view">
          +{data.hiddenChildren}
        </span>
      {/if}
    </span>
  </header>

  {#if data.lineage.length}
    <!-- The levels this view draws as labels rather than as boxes: the parent
         each node would have been nested inside. -->
    <p class="lineage">
      {#each data.lineage as ancestor (ancestor.id)}
        <span class="ancestor" title="{ancestor.typeLabel} {ancestor.id} — {ancestor.title}">
          {ancestor.id}
        </span>
      {/each}
    </p>
  {/if}

  <p class="title" title={data.node.title}>{data.node.title}</p>

  {#if children}
    <div class="body">{@render children()}</div>
  {/if}

  {#if footer}
    <footer>{@render footer()}</footer>
  {/if}

  <Handle type="source" position={Position.Right} />
</div>

<style>
  .node {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    padding: var(--space-2);
    border: 1px solid var(--tone);
    border-left: 3px solid var(--tone);
    border-radius: var(--radius-md);
    background: var(--tone-bg);
    color: var(--ink);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }

  /*
   * Sync state, as a corner triangle in the top-right. It is deliberately an
   * outline-shaped corner mark rather than a fill, because sync is a different
   * axis from status and must read as one. Its colours live in --sync-* tokens
   * so they can never be mistaken for a status tone.
   */
  .sync {
    position: absolute;
    top: 0;
    right: 0;
    width: 0;
    height: 0;
    border-top: 9px solid;
    border-left: 9px solid transparent;
    pointer-events: none;
  }

  .sync-ahead { border-top-color: var(--sync-ahead); }
  .sync-behind { border-top-color: var(--sync-behind); }
  .sync-conflicted { border-top-color: var(--sync-conflicted); }
  .sync-unlinked { border-top-color: var(--sync-unlinked); }

  .node.group {
    background: color-mix(in srgb, var(--tone-bg) 45%, var(--surface-0));
    border-style: dashed;
  }

  /*
   * Scheduled in the sprint that is running today: a strip along the top and a
   * wash in the same colour the chip uses, so "what should I be doing?" is
   * answered by the shape of the canvas rather than by reading every badge.
   *
   * Neither cue is a border or a box-shadow, because selection and neighbour
   * highlighting own those and a node can perfectly well be all three at once —
   * the strip is a pseudo-element for exactly that reason.
   */
  .node.current {
    background: color-mix(in srgb, var(--warn) 18%, var(--tone-bg));
  }

  .node.current.group {
    background: color-mix(in srgb, var(--warn) 10%, var(--surface-0));
  }

  .node.current::before {
    content: '';
    position: absolute;
    inset: 0 0 auto 0;
    height: 3px;
    background: var(--warn);
    pointer-events: none;
  }

  /*
   * Flagged: red, and red enough to find by scanning rather than by reading.
   *
   * It overrides the status tone rather than sitting beside it, because a
   * flagged issue's column has stopped being the interesting fact about it. The
   * strip is the same device the running-period cue uses, for the same reason —
   * selection and neighbour highlighting own the border and the shadow, and a
   * node can be flagged, selected and in this sprint at once.
   */
  .node.flagged {
    --tone: var(--danger);
    border-color: var(--danger);
    border-left-width: 5px;
    background: color-mix(in srgb, var(--danger) 16%, var(--surface-0));
  }

  .node.flagged.group {
    background: color-mix(in srgb, var(--danger) 9%, var(--surface-0));
  }

  .node.flagged::after {
    content: '';
    position: absolute;
    inset: auto 0 0 0;
    height: 3px;
    background: var(--danger);
    pointer-events: none;
  }

  /* Something inside is flagged. A quieter edge: this node is not stuck, it is
     standing in front of something that is. */
  .node.holds-flag {
    border-color: color-mix(in srgb, var(--danger) 55%, var(--border));
    border-style: dashed;
  }

  .selected {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /*
   * One hop away: a heavier border in the accent colour, so a glance at a
   * selected issue also answers "what does it block, and what is holding it
   * up?" without reading the arrows.
   */
  .related {
    border-color: var(--accent);
    border-width: 2px;
    border-style: solid;
    box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-sm);
  }

  .tone-todo {
    --tone: var(--tone-todo);
    --tone-bg: var(--tone-todo-soft);
  }
  .tone-active {
    --tone: var(--tone-active);
    --tone-bg: var(--tone-active-soft);
  }
  .tone-blocked {
    --tone: var(--tone-blocked);
    --tone-bg: var(--tone-blocked-soft);
  }
  .tone-review {
    --tone: var(--tone-review);
    --tone-bg: var(--tone-review-soft);
  }
  .tone-done {
    --tone: var(--tone-done);
    --tone-bg: var(--tone-done-soft);
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .icon {
    display: inline-flex;
    color: var(--tone);
  }

  .id {
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--tone);
  }

  .type {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .marks {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
    min-width: 0;
  }

  .badge {
    padding: 0 0.3rem;
    border-radius: 999px;
    background: var(--surface-3);
    font-weight: 600;
  }

  .badge.root {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .period {
    max-width: 11rem;
    padding: 0 0.35rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-1);
    color: var(--ink-muted);
    font-size: 0.92em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .flag {
    flex: none;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--danger);
    color: var(--danger-ink);
    font-weight: 700;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  .flag.inside {
    background: none;
    border: 1px solid var(--danger);
    color: var(--danger);
    font-weight: 600;
  }

  .period.now {
    border-color: var(--warn);
    background: color-mix(in srgb, var(--warn) 18%, var(--surface-1));
    color: var(--ink);
    font-weight: 600;
  }

  /* A dot rather than the word "now": the chip is already short of room. */
  .period.now::before {
    content: '●';
    margin-right: 0.25rem;
    color: var(--warn);
  }

  .chevron {
    border: none;
    background: none;
    padding: 0;
    width: 1rem;
    color: var(--ink-muted);
    line-height: 1;
    transition: transform var(--duration-fast);
  }

  .chevron.collapsed {
    transform: rotate(-90deg);
  }

  .lineage {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem;
    margin: 0.2rem 0 0;
    min-height: 0;
    overflow: hidden;
  }

  .ancestor {
    padding: 0 0.3rem;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--ink-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.4;
    white-space: nowrap;
  }

  .title {
    margin: 0.15rem 0 0;
    font-size: var(--text-sm);
    font-weight: 600;
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .body {
    flex: 1;
    min-height: 0;
  }

  footer {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: auto;
    padding-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }
</style>
