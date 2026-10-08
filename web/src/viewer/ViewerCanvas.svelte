<script lang="ts">
  import { untrack } from 'svelte';
  import {
    Background,
    Controls,
    MiniMap,
    SvelteFlow,
    useSvelteFlow,
  } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import { statusTone } from '$lib/board/selectors.js';
  import Button from '$lib/ui/Button.svelte';
  import DependencyEdge from '$features/canvas/edges/DependencyEdge.svelte';
  import { CanvasGraph } from '$features/canvas/graph.svelte.js';
  import GroupNode from '$features/canvas/nodes/GroupNode.svelte';
  import IssueNode from '$features/canvas/nodes/IssueNode.svelte';
  import { startCameraPan } from '$features/canvas/pan.js';
  import { provideGraphSource } from '$features/canvas/source.js';
  import type { ViewerBoard } from './board.svelte.js';

  /**
   * The DAG, with nothing that writes.
   *
   * `CanvasGraph`, the nodes and the edges are the editor's, unchanged — the
   * only difference is what is wired up: no drag-to-reparent, no splice onto an
   * edge, no connect, no context menus. Dragging a node still moves it, because
   * tidying the picture you are reading is not editing the board.
   */
  interface Props {
    board: ViewerBoard;
  }

  let { board }: Props = $props();

  const flow = useSvelteFlow();
  // The store instance is created once by the shell and never swapped, so
  // reading it here rather than in a closure is what is meant.
  // svelte-ignore state_referenced_locally
  const graph = new CanvasGraph(provideGraphSource(board));

  const nodeTypes = { issue: IssueNode, group: GroupNode };
  const edgeTypes = { dependency: DependencyEdge };

  const signature = $derived(graph.signature());
  $effect(() => {
    signature;
    untrack(() => graph.sync());
  });

  $effect(() => {
    board.selection.ids;
    untrack(() => graph.syncSelection());
  });

  // Untracked like the editor's: `fitView` reads SvelteFlow's node store, and an
  // effect that both reads and writes those nodes never settles.
  $effect(() => {
    board.selection.focusRequest;
    untrack(() => {
      const id = board.selection.primary;
      if (!id) return;
      void flow.fitView({ nodes: [{ id }], duration: 320, maxZoom: 1.3, padding: 0.6 });
    });
  });

  /**
   * Ctrl held: nodes stop being draggable and the drag falls through to the
   * pane, so a node that fills the screen can be panned over. The same rule as
   * the editor's, for the same reason.
   */
  let panning = $state(false);

  let _dblClickTimer: ReturnType<typeof setTimeout> | null = null;
  let _dblClickTarget: string | null = null;

  /** Forget the saved positions and lay the whole thing out from scratch. */
  function arrange(): void {
    board.resetLayout();
    graph.arrange();
    void flow.fitView({ duration: 240 });
  }
</script>

<svelte:window
  onkeydown={(event) => (panning = event.ctrlKey || event.metaKey)}
  onkeyup={(event) => (panning = event.ctrlKey || event.metaKey)}
  onblur={() => (panning = false)}
/>

<div
  class="canvas"
  class:panning
  role="application"
  aria-label="Dependency graph"
  onpointerdowncapture={(event) => startCameraPan(event, flow)}
>
  <SvelteFlow
    bind:nodes={graph.nodes}
    bind:edges={graph.edges}
    {nodeTypes}
    {edgeTypes}
    fitView
    onlyRenderVisibleElements
    minZoom={0.1}
    maxZoom={2}
    nodeDragThreshold={2}
    nodesDraggable={!panning}
    selectionKey="Shift"
    multiSelectionKey="Shift"
    deleteKey={null}
    nodesConnectable={false}
    onnodeclick={({ node, event }) => {
      const mouse = event as MouseEvent;
      const clickId = node.id;
      if (mouse.shiftKey || mouse.ctrlKey || mouse.metaKey) board.selection.toggle(clickId);
      else board.selection.set([clickId]);

      // Double-click detection — routes to the existing Inspector which shows
      // plain text only, per the viewer's hard invariant.
      if (_dblClickTimer && _dblClickTarget === clickId) {
        clearTimeout(_dblClickTimer);
        _dblClickTimer = null;
        _dblClickTarget = null;
        return;
      }
      _dblClickTarget = clickId;
      _dblClickTimer = setTimeout(() => {
        _dblClickTimer = null;
        _dblClickTarget = null;
      }, 300);
    }}
    onnodedragstop={() => graph.persistPositions()}
    onpaneclick={() => board.selection.clear()}
    onselectionchange={({ nodes }) => board.selection.set(nodes.map((node) => node.id))}
  >
    <Background gap={22} patternColor="var(--border)" />
    <Controls position="bottom-left" />
    <MiniMap
      position="bottom-right"
      pannable
      zoomable
      nodeColor={(node) =>
        `var(--tone-${statusTone(board.config, (node.data as { node: { status?: string } }).node.status ?? '')})`}
    />
  </SvelteFlow>

  <div class="toolbar">
    <Button size="sm" onclick={arrange} title="Re-arrange the graph">Arrange</Button>
    <Button size="sm" onclick={() => void flow.fitView({ duration: 240 })}>Fit</Button>
  </div>

  {#if !board.members.length}
    <p class="empty">This view is empty.</p>
  {/if}
</div>

<style>
  .canvas {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    background: var(--surface-0);
  }

  .canvas :global(.svelte-flow) {
    background: var(--surface-0);
  }

  /* Nothing connects here, so the handles are decoration that gets in the way. */
  .canvas :global(.svelte-flow__handle) {
    opacity: 0;
    pointer-events: none;
  }

  .canvas :global(.svelte-flow__node) {
    border: none;
    padding: 0;
    background: none;
    font-size: inherit;
  }

  /* Resizing is tidying, not editing, so the reader gets the handles too. */
  .canvas :global(.svelte-flow__resize-control.handle) {
    width: 10px;
    height: 10px;
    border: 1px solid var(--surface-0);
    border-radius: 2px;
    background: var(--accent);
  }

  .canvas :global(.svelte-flow__resize-control.line) {
    border-color: var(--accent);
    border-width: 1.5px;
  }

  .panning :global(.svelte-flow__node) {
    cursor: grab;
  }

  .panning :global(.svelte-flow__pane:active),
  .panning :global(.svelte-flow__node:active) {
    cursor: grabbing;
  }

  .toolbar {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
    z-index: 5;
    display: flex;
    gap: var(--space-2);
  }

  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ink-muted);
    pointer-events: none;
  }
</style>
