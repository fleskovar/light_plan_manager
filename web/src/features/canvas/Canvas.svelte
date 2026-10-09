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
  import { usePreferences } from '$lib/app/preferences.svelte.js';
  import { useShell } from '$lib/app/shell.svelte.js';
  import { statusTone } from '$lib/board/selectors.js';
  import Button from '$lib/ui/Button.svelte';
  import { addDependency } from '$lib/workspace/mutations.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import { useRemoteState } from '$features/drawer/remote/remote.svelte.js';
  import { startCarry } from './carry.js';
  import DependencyEdge from './edges/DependencyEdge.svelte';
  import { CanvasGraph } from './graph.svelte.js';
  import { edgeMenu, nodeMenu, paneMenu } from './menus.js';
  import GroupNode from './nodes/GroupNode.svelte';
  import IssueNode from './nodes/IssueNode.svelte';
  import { startCameraPan } from './pan.js';
  import { provideGraphSource } from './source.js';
  import {
    createCarryHandlers,
    createDoubleClickHandler,
    handleDragStop,
    handleRosterDrop,
    selectFromEvent,
  } from './Canvas.svelte.js';

  /**
   * The DAG. Everything it knows about the board it reads from the workspace;
   * everything it changes it changes through a mutation. What lives here is the
   * part that is genuinely about a canvas: wiring SvelteFlow's events to the
   * decision layer in `Canvas.svelte.ts`, and keeping the modifier state the
   * capture-phase handlers and decisions both read.
   */
  interface Props {
    /** Exposed so a keyboard shortcut in the shell can trigger the layout. */
    arrange?: () => void;
  }

  let { arrange = $bindable(() => {}) }: Props = $props();

  const workspace = useWorkspace();
  const shell = useShell();
  // SvelteFlow draws its own controls and minimap, and has to be told the
  // theme the reader chose rather than guess it from the system.
  const preferences = usePreferences();
  const remote = useRemoteState();
  const flow = useSvelteFlow();
  const graph = new CanvasGraph(provideGraphSource(workspace));
  const screenToFlow = (p: { x: number; y: number }) =>
    flow.screenToFlowPosition(p);

  arrange = () => graph.arrange();

  const nodeTypes = { issue: IssueNode, group: GroupNode };
  const edgeTypes = { dependency: DependencyEdge };

  /** True while Alt is held: a drag carries the issue instead of moving it. */
  let splicing = $state(false);
  /** True while Ctrl is held: the canvas is a camera, not a set of nodes. */
  let panning = $state(false);
  /** True between picking a node up with Alt and putting it down. */
  let carrying = $state(false);

  // -- Double-click ---------------------------------------------------------

  const doubleClick = createDoubleClickHandler();

  function openIssuePopup(id: string): void {
    const viewId = workspace.doc.id;
    const base = window.location.href.replace(/#.*$/, '');
    const url = `${base}#/issue/${encodeURIComponent(id)}?view=${encodeURIComponent(viewId)}`;
    window.open(url, `issue-${id}`, 'width=780,height=900,resizable,scrollbars');
  }

  function onNodeClick(id: string, event: MouseEvent): void {
    selectFromEvent(workspace.selection, id, event);
    doubleClick.handle(id, () => openIssuePopup(id));
  }

  // -- Carry ----------------------------------------------------------------

  const carryUI = {
    setCarrying: (v: boolean) => { carrying = v; },
    setPeriodDropTarget: (v: string | null) => { shell.periodDropTarget = v; },
  };
  const carryHandlers = $derived(
    createCarryHandlers(workspace, shell, carryUI, graph, screenToFlow),
  );

  // -- Graph sync -----------------------------------------------------------

  const signature = $derived(graph.signature());
  $effect(() => {
    signature;
    untrack(() => graph.sync());
  });

  $effect(() => {
    workspace.selection.ids;
    untrack(() => graph.syncSelection());
  });

  // Anything that selects a node elsewhere (the table, a neighbour link) bumps
  // the focus counter, and the canvas travels to it. The travelling itself is
  // untracked: `fitView` reads SvelteFlow's node store, and an effect that both
  // reads and writes those nodes never settles.
  $effect(() => {
    workspace.selection.focusRequest;
    untrack(() => {
      const id = workspace.selection.primary;
      if (!id) return;
      void flow.fitView({ nodes: [{ id }], duration: 320, maxZoom: 1.3, padding: 0.6 });
    });
  });
</script>

<!--
  Both modifiers are read off every key event rather than latched on their own
  keydown, so releasing one while the other is held leaves the right state. A
  blur resets them: a window that loses focus mid-chord never sees the keyup.
-->
<svelte:window
  onkeydown={(event) => {
    splicing = event.altKey;
    panning = event.ctrlKey || event.metaKey;
  }}
  onkeyup={(event) => {
    splicing = event.altKey;
    panning = event.ctrlKey || event.metaKey;
  }}
  onblur={() => {
    splicing = false;
    panning = false;
  }}
/>

<div
  class="canvas"
  class:splicing
  class:panning
  class:carrying
  role="application"
  aria-label="Dependency graph"
  onpointerdowncapture={(event) => {
    if (startCarry(event, carryHandlers)) return;
    startCameraPan(event, flow, event.currentTarget);
    // Right-click on a node: SvelteFlow's internal node drag handler calls
    // preventDefault() on pointerdown, which suppresses the browser's
    // contextmenu event and stops onnodecontextmenu from ever firing.
    // Stopping propagation here keeps the pointerdown from reaching that
    // handler, so contextmenu dispatches normally.
    if (event.button === 2) event.stopPropagation();
  }}
  ondragover={(event) => event.preventDefault()}
  ondrop={(event) => handleRosterDrop(workspace, graph.nodes, screenToFlow, event)}
>
  <SvelteFlow
    bind:nodes={graph.nodes}
    bind:edges={graph.edges}
    {nodeTypes}
    {edgeTypes}
    fitView
    colorMode={preferences?.resolvedTheme ?? 'system'}
    onlyRenderVisibleElements
    minZoom={0.1}
    maxZoom={2}
    nodeDragThreshold={2}
    nodesDraggable={!panning}
    selectionKey="Shift"
    multiSelectionKey="Shift"
    deleteKey={null}
    onnodeclick={({ node, event }) => onNodeClick(node.id, event as MouseEvent)}
    onnodedragstop={(params) =>
      handleDragStop({ ...params, graph, workspace, shell, screenToFlow })}
    onnodecontextmenu={({ node, event }) => {
      if (!workspace.selection.has(node.id)) workspace.selection.set([node.id]);
      shell.openMenu(event, nodeMenu({ workspace, shell, remote }, node.id));
    }}
    onedgeclick={({ edge, event }) => {
      event.stopPropagation();
      graph.edges = graph.edges.map((entry) => ({ ...entry, selected: entry.id === edge.id }));
      graph.refreshHighlights();
    }}
    onedgecontextmenu={({ edge, event }) => {
      const data = edge.data as { from: string; to: string; aggregated: boolean };
      shell.openMenu(event, edgeMenu({ workspace, shell }, data));
    }}
    onpaneclick={() => {
      workspace.selection.clear();
      graph.edges = graph.edges.map((entry) =>
        entry.selected ? { ...entry, selected: false } : entry,
      );
      graph.refreshHighlights();
    }}
    onpanecontextmenu={({ event }) =>
      shell.openMenu(
        event,
        paneMenu({
          workspace,
          shell,
          at: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
          onarrange: () => graph.arrange(),
        }),
      )}
    onconnect={({ source, target }) => addDependency(workspace, target, source)}
    onselectionchange={({ nodes }) => workspace.selection.set(nodes.map((node) => node.id))}
  >
    <Background gap={22} patternColor="var(--border)" />
    <Controls position="bottom-left" />
    <MiniMap
      position="bottom-right"
      pannable
      zoomable
      nodeColor={(node) =>
        `var(--tone-${statusTone(workspace.config, (node.data as { node: { status?: string } }).node.status ?? '')})`}
    />
  </SvelteFlow>

  <div class="toolbar">
    <Button size="sm" onclick={() => graph.arrange()} title="Re-arrange the graph (Ctrl+L)">
      Arrange
    </Button>
    <Button size="sm" onclick={() => flow.fitView({ duration: 240 })}>Fit</Button>
  </div>

  {#if !workspace.doc.members.length}
    <div class="empty">
      <p>This view is empty.</p>
      <p class="hint">Select issues in the table below to add them.</p>
    </div>
  {/if}
</div>

<style>
  .canvas {
    position: relative;
    flex: 1;
    min-height: 0;
    background: var(--surface-0);
  }

  .canvas :global(.svelte-flow) {
    background: var(--surface-0);
  }

  .canvas :global(.svelte-flow__handle) {
    width: 8px;
    height: 8px;
    border: 1px solid var(--surface-1);
    background: var(--ink-faint);
  }

  .canvas :global(.svelte-flow__node) {
    border: none;
    padding: 0;
    background: none;
    font-size: inherit;
  }

  /* Resize handles, shown on the selected node. Big enough to grab at the
     zoom levels a whole programme is read at. */
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

  /* While Alt is held, edges are a drop target, so make them obvious. */
  .splicing :global(.svelte-flow__edge-path) {
    stroke-width: 3px;
  }

  /* Alt over a node: it can be picked up and carried to the drawer. */
  .splicing :global(.svelte-flow__node) {
    cursor: grab;
  }

  /* Carrying: the pointer is holding work, and the graph is not moving. */
  .carrying,
  .carrying :global(.svelte-flow__node) {
    cursor: grabbing;
  }

  /* While Ctrl is held every surface is the camera, so it all reads as pannable. */
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
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    color: var(--ink-muted);
    pointer-events: none;
  }

  .empty .hint {
    font-size: var(--text-sm);
    color: var(--ink-faint);
  }
</style>
