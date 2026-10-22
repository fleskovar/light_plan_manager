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
  import DraftCard from './DraftCard.svelte';
  import { cleanTitle, provideCanvasEditing } from './editing.js';
  import DependencyEdge from './edges/DependencyEdge.svelte';
  import { CanvasGraph } from './graph.svelte.js';
  import { edgeMenu, nodeMenu, paneMenu, type EditActions } from './menus.js';
  import GroupNode from './nodes/GroupNode.svelte';
  import IssueNode from './nodes/IssueNode.svelte';
  import { startCameraPan } from './pan.js';
  import ScopeBar from './ScopeBar.svelte';
  import {
    breadcrumb,
    canEnter,
    childDepth,
    chosenType,
    creatableTypes,
    scopeShowing,
  } from './scope.js';
  import { provideGraphSource } from './source.js';
  import {
    centredOn,
    commitDraft,
    createCarryHandlers,
    createDoubleClickHandler,
    finishRename,
    handleDragStop,
    handleRosterDrop,
    isPaneTarget,
    nextDraft,
    selectFromEvent,
    type Draft,
  } from './Canvas.svelte.js';

  /**
   * The DAG. Everything it knows about the board it reads from the workspace;
   * everything it changes it changes through a mutation. What lives here is the
   * part that is genuinely about a canvas: wiring SvelteFlow's events to the
   * decision layer in `Canvas.svelte.ts`, and keeping the modifier state the
   * capture-phase handlers and decisions both read.
   *
   * The canvas has two modes, and `workspace.canvasMode` holds the mode. Read
   * mode draws the whole view. Edit mode can make one item the active item.
   * The canvas then draws only what is inside that item, without its frame,
   * and a new item becomes its child. In edit mode a double-click on the empty
   * canvas opens the card of a new item. A double-click on a node enters the
   * node when it can hold children, and opens its title field when it cannot.
   */
  interface Props {
    /** Exposed so a keyboard shortcut in the shell can trigger the layout. */
    arrange?: () => void;
    /** Exposed so the key N can open the card of a new item in edit mode. */
    newItem?: () => void;
  }

  let { arrange = $bindable(() => {}), newItem = $bindable(() => {}) }: Props = $props();

  const workspace = useWorkspace();
  const shell = useShell();
  // SvelteFlow draws its own controls and minimap, and has to be told the
  // theme the reader chose rather than guess it from the system.
  const preferences = usePreferences();
  const remote = useRemoteState();
  const flow = useSvelteFlow();
  // Read mode or edit mode, and the active item of edit mode. The graph draws
  // the inside of `mode.scope`, which is null in read mode.
  const mode = workspace.canvasMode;
  const graph = new CanvasGraph(provideGraphSource(workspace), { scope: () => mode.scope });
  const screenToFlow = (p: { x: number; y: number }) =>
    flow.screenToFlowPosition(p);

  arrange = () => graph.arrange();
  newItem = () => startDraft(null);

  let canvasElement: HTMLDivElement | undefined = $state();

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
    // Wide enough for the two columns of `IssueView.svelte`.
    window.open(url, `issue-${id}`, 'width=1200,height=860,resizable,scrollbars');
  }

  function onNodeClick(id: string, event: MouseEvent): void {
    selectFromEvent(workspace.selection, id, event);
    doubleClick.handle(id, () => (mode.editing ? editDoubleClick(id) : openIssuePopup(id)));
  }

  // -- Edit mode ------------------------------------------------------------

  /** The active item as a document, or null at the top of the view. */
  const activeNode = $derived(mode.scope ? (workspace.node(mode.scope) ?? null) : null);
  const crumbs = $derived(
    breadcrumb(workspace.nodes, workspace.config, mode.scope, workspace.doc.name),
  );
  /** The types that a new item inside the active item can take. */
  const newTypes = $derived(creatableTypes(workspace.config, workspace.nodeKind, activeNode));
  const newDepth = $derived(childDepth(activeNode));
  const newType = $derived(chosenType(newTypes, newDepth, mode.newTypes));
  const typeLabel = (type: string): string => workspace.config.types[type]?.label ?? type;

  /** The card of a new item that waits for its title, or null. */
  let draft = $state<Draft | null>(null);
  let draftSerial = 0;

  /** In edit mode a double-click enters a node that can hold children, and renames any other node. */
  function editDoubleClick(id: string): void {
    if (canEnter(workspace.config, workspace.node(id))) enter(id);
    else mode.startRename(id);
  }

  function enter(id: string): void {
    mode.enter(id, workspace.nodes);
    workspace.selection.clear();
  }

  /** Go to a step of the breadcrumb bar, and select the item that the canvas came out of. */
  function navigate(id: string | null): void {
    const from = mode.goTo(id, workspace.nodes);
    workspace.selection.set(from ? [from] : []);
  }

  /** The centre of the visible part of the canvas, in canvas coordinates. */
  function visibleCentre(): { x: number; y: number } {
    const box = canvasElement?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return screenToFlow({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
  }

  /**
   * Open the card of a new item. `at` is the centre of the card in canvas
   * coordinates, or null for the centre of the visible canvas. `type` is the
   * type chosen in the bar unless the caller gives one.
   */
  function startDraft(at: { x: number; y: number } | null, type: string | null = newType): void {
    if (!mode.editing || !type) return;
    draftSerial += 1;
    draft = {
      serial: draftSerial,
      parentId: mode.scope,
      type,
      position: centredOn(at ?? visibleCentre()),
    };
  }

  /** Create the item of the card. Enter with a title opens the next card below it. */
  function submitDraft(text: string, next: boolean): void {
    const current = draft;
    if (!current) return;
    const title = cleanTitle(text);
    commitDraft(workspace, current, title);
    if (next && title !== null) {
      draftSerial += 1;
      draft = { ...nextDraft(current), serial: draftSerial };
    } else {
      draft = null;
    }
  }

  function chooseType(type: string): void {
    mode.newTypes = { ...mode.newTypes, [newDepth]: type };
    if (draft) draft = { ...draft, type };
  }

  const editActions: EditActions = {
    get activeId() {
      return mode.scope;
    },
    enter,
    rename: (id) => mode.startRename(id),
    openWindow: openIssuePopup,
    draft: (type, at) => startDraft(at ?? null, type),
  };

  provideCanvasEditing({
    get enabled() {
      return mode.editing;
    },
    get renaming() {
      return mode.renaming;
    },
    canEnter: (id) => canEnter(workspace.config, workspace.node(id)),
    enter,
    finishRename: (id, title) => finishRename(workspace, id, title),
    openField: () => mode.openField(),
  });

  function onCanvasDoubleClick(event: MouseEvent): void {
    if (!mode.editing || !isPaneTarget(event.target)) return;
    startDraft(screenToFlow({ x: event.clientX, y: event.clientY }));
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
      // In edit mode the node can be outside the active item. The parent of
      // the node then becomes the active item, and the travel waits for the
      // canvas to draw the new content.
      if (mode.editing) {
        const scope = scopeShowing(workspace.nodes, id, mode.activeId);
        if (scope !== mode.activeId) {
          travelAfterScope = id;
          if (scope) mode.enter(scope, workspace.nodes);
          else mode.activate(null);
          return;
        }
      }
      // The travel waits one frame. A node created in this tick reaches
      // SvelteFlow only with the next render, and a fit to a node that
      // SvelteFlow does not know moves nothing. A node that stays off screen
      // is not drawn, and its title field never opens.
      requestAnimationFrame(() => {
        void flow.fitView({ nodes: [{ id }], duration: 320, maxZoom: 1.3, padding: 0.6 });
      });
    });
  });

  /**
   * After the active item changes, the canvas fits the new content. A
   * pending travel goes to its node. When the canvas went up a level or back
   * to read mode, the item that was active is now a frame on the canvas, and
   * the canvas goes to that frame. In any other case it fits everything. The
   * fit waits one frame, so SvelteFlow has the nodes of the sync.
   */
  let travelAfterScope: string | null = null;
  let previousScope: string | null | undefined;
  $effect(() => {
    const scope = mode.scope;
    untrack(() => {
      const before = previousScope;
      previousScope = scope;
      if (before === undefined || before === scope) return;
      draft = null;
      const target = travelAfterScope ?? before;
      travelAfterScope = null;
      requestAnimationFrame(() => {
        if (target && graph.nodes.some((node) => node.id === target)) {
          void flow.fitView({ nodes: [{ id: target }], duration: 320, maxZoom: 1.1, padding: 0.4 });
        } else {
          void flow.fitView({ duration: 320, maxZoom: 1.1, padding: 0.15 });
        }
      });
    });
  });

  // The card of a new item belongs to edit mode.
  $effect(() => {
    if (!mode.editing) untrack(() => (draft = null));
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
  class:editing={mode.editing}
  role="application"
  aria-label="Dependency graph"
  bind:this={canvasElement}
  ondblclick={onCanvasDoubleClick}
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
    zoomOnDoubleClick={!mode.editing}
    nodesDraggable={!panning}
    selectionKey="Shift"
    multiSelectionKey="Shift"
    deleteKey={null}
    onnodeclick={({ node, event }) => onNodeClick(node.id, event as MouseEvent)}
    onnodedragstop={(params) =>
      handleDragStop({ ...params, graph, workspace, shell, screenToFlow })}
    onnodecontextmenu={({ node, event }) => {
      if (!workspace.selection.has(node.id)) workspace.selection.set([node.id]);
      shell.openMenu(
        event,
        nodeMenu({ workspace, shell, remote, edit: mode.editing ? editActions : undefined }, node.id),
      );
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
          edit: mode.editing ? editActions : undefined,
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
    {#if draft}
      {#key draft.serial}
        <DraftCard
          position={draft.position}
          typeLabel={typeLabel(draft.type)}
          onsubmit={submitDraft}
          oncancel={() => (draft = null)}
        />
      {/key}
    {/if}
  </SvelteFlow>

  {#if mode.editing}
    <ScopeBar
      {crumbs}
      types={newTypes.map((type) => ({ value: type, label: typeLabel(type) }))}
      chosen={newType}
      onnavigate={navigate}
      onchoose={chooseType}
      onadd={() => startDraft(null)}
    />
  {/if}

  <div class="toolbar">
    <Button size="sm" onclick={() => graph.arrange()} title="Re-arrange the graph (Ctrl+L)">
      Arrange
    </Button>
    <Button size="sm" onclick={() => flow.fitView({ duration: 240 })}>Fit</Button>
  </div>

  {#if mode.editing}
    {#if !graph.nodes.length && !draft}
      <div class="empty">
        <p>{activeNode ? `${activeNode.id} holds no items in this view.` : 'This view is empty.'}</p>
        {#if newType}
          <p class="hint">Double-click the canvas or press N to add a {typeLabel(newType)}.</p>
        {/if}
      </div>
    {/if}
  {:else if !workspace.doc.members.length}
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

  /* Edit mode: an accent frame inside the canvas shows that a double-click creates. */
  .canvas.editing {
    box-shadow: inset 0 0 0 2px var(--accent-soft);
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
