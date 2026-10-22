import { describe, expect, it } from 'vitest';
import type { BoardSnapshot, IssueDto, NodeLayout, TypeDisplay } from '$shared';
import { emptyView } from '$shared';
import { Shell } from '$lib/app/shell.svelte.js';
import { buildIndex } from '$lib/board/index.js';
import { findBinding } from '$lib/shortcuts/bindings.js';
import type { MenuEntry, MenuItem } from '$lib/ui/menu/types.js';
import { isHeading, isSeparator } from '$lib/ui/menu/types.js';
import { CanvasMode } from '$lib/workspace/canvas-mode.svelte.js';
import { Selection } from '$lib/workspace/selection.svelte.js';
import { Workspace } from '$lib/workspace/workspace.svelte.js';
import { commitDraft, finishRename, nextDraft, type Draft } from '$features/canvas/Canvas.svelte.js';
import { cleanTitle } from '$features/canvas/editing.js';
import { CanvasGraph } from '$features/canvas/graph.svelte.js';
import {
  FRAME_ORIGIN,
  keepInsideFrames,
  placeNewNodes,
  shiftTopLevel,
} from '$features/canvas/layout.js';
import { nodeMenu, paneMenu, type EditActions } from '$features/canvas/menus.js';
import { GROUP_HEADER, GROUP_PADDING, buildGraph, type CanvasNode } from '$features/canvas/model.js';
import {
  breadcrumb,
  canEnter,
  chosenType,
  creatableTypes,
  isInside,
  scopeShowing,
} from '$features/canvas/scope.js';
import type { GraphSource } from '$features/canvas/source.js';
import { config, issue, sampleBoard, template } from './fixtures.js';

/**
 * Edit mode of the canvas.
 *
 * Read mode draws the whole view. Edit mode can make one document the active
 * item: the canvas then draws only the members inside it, its children sit at
 * the top level without a frame, and a new item becomes its child. These
 * cases check each part of that without a DOM: which nodes are drawn, how
 * positions stay valid in both modes, how the active item moves, and what the
 * menus and keys of edit mode do.
 *
 * The sample board: P (program) > E (epic) > F1, F2 (features) > S1..S4 (stories).
 */
const everything = ['P', 'E', 'F1', 'F2', 'S1', 'S2', 'S3', 'S4'];

function graphIn(scope: string | null, members = everything) {
  return buildGraph({
    nodes: sampleBoard(),
    config,
    members,
    isCollapsed: () => false,
    scope,
  });
}

describe('visibleTree with an active item', () => {
  it('draws the whole view without an active item', () => {
    const ids = graphIn(null).nodes.map((node) => node.id).sort();
    expect(ids).toEqual([...everything].sort());
  });

  it('draws only what is inside the active item, and puts its children at the top level', () => {
    const graph = graphIn('E');
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    expect([...byId.keys()].sort()).toEqual(['F1', 'F2', 'S1', 'S2', 'S3', 'S4']);
    // The children of the active item have no frame around them.
    expect(byId.get('F1')?.parentId).toBeUndefined();
    expect(byId.get('F2')?.parentId).toBeUndefined();
    // Deeper levels keep their frames.
    expect(byId.get('S1')?.parentId).toBe('F1');
  });

  it('keeps the dependencies between items inside the active item', () => {
    const edges = graphIn('E').edges.map((edge) => edge.id).sort();
    expect(edges).toEqual(['S1->S2', 'S2->S3', 'S3->S4']);
  });

  it('drops the dependencies that leave the active item', () => {
    // Inside F2, S3 depends on S2 in F1, which is not drawn.
    const graph = graphIn('F2');
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['S3', 'S4']);
    expect(graph.edges.map((edge) => edge.id)).toEqual(['S3->S4']);
  });

  it('draws nothing inside an item that holds no members', () => {
    expect(graphIn('S1').nodes).toEqual([]);
  });

  it('does not repeat the active item, or the levels above it, as a badge', () => {
    const display: Record<string, TypeDisplay> = { program: 'badge', epic: 'badge' };
    const inside = buildGraph({
      nodes: sampleBoard(),
      config,
      members: everything,
      isCollapsed: () => false,
      display,
      scope: 'E',
    });
    const f1 = inside.nodes.find((node) => node.id === 'F1')!;
    expect(f1.data.lineage).toEqual([]);

    // Read mode draws the same badged levels on F1.
    const whole = buildGraph({
      nodes: sampleBoard(),
      config,
      members: everything,
      isCollapsed: () => false,
      display,
    });
    expect(whole.nodes.find((node) => node.id === 'F1')!.data.lineage.map((badge) => badge.id)).toEqual([
      'P',
      'E',
    ]);
  });
});

describe('scope helpers', () => {
  const nodes = sampleBoard();

  it('tells whether a document is inside an item', () => {
    expect(isInside(nodes, 'S1', 'E')).toBe(true);
    expect(isInside(nodes, 'S1', 'F2')).toBe(false);
    expect(isInside(nodes, 'E', 'E')).toBe(false);
    expect(isInside(nodes, 'P', null)).toBe(true);
  });

  it('offers the child types of the active item, or the top-level types without one', () => {
    expect(creatableTypes(config, 'issue', null)).toEqual(['program']);
    expect(creatableTypes(config, 'issue', nodes.F1!)).toEqual(['user_story', 'bug']);
    expect(creatableTypes(config, 'issue', nodes.S1!)).toEqual(['sub_task']);
  });

  it('offers a folder in the registry only under a folder', () => {
    const folder = template('TF1', 'folder', null, { depth: 0 });
    const epic = template('T1', 'epic', null, { depth: 0 });
    expect(creatableTypes(config, 'template', folder)).toContain('folder');
    expect(creatableTypes(config, 'template', epic)).not.toContain('folder');
  });

  it('enters an item only when the hierarchy allows children under it', () => {
    const leaf = issue('T1', 'sub_task', 'S1');
    expect(canEnter(config, nodes.E)).toBe(true);
    expect(canEnter(config, nodes.S1)).toBe(true);
    expect(canEnter(config, leaf)).toBe(false);
    expect(canEnter(config, undefined)).toBe(false);
  });

  it('keeps the chosen type while the hierarchy allows it', () => {
    expect(chosenType(['user_story', 'bug'], 3, { 3: 'bug' })).toBe('bug');
    expect(chosenType(['user_story', 'bug'], 3, {})).toBe('user_story');
    expect(chosenType(['sub_task'], 4, { 4: 'bug' })).toBe('sub_task');
    expect(chosenType([], 5, {})).toBeNull();
  });

  it('builds the breadcrumb from the view down to the active item', () => {
    expect(breadcrumb(nodes, config, null, 'Plan').map((crumb) => crumb.id)).toEqual([null]);
    const crumbs = breadcrumb(nodes, config, 'F1', 'Plan');
    expect(crumbs.map((crumb) => crumb.id)).toEqual([null, 'P', 'E', 'F1']);
    expect(crumbs[0]!.label).toBe('Plan');
    expect(crumbs[3]!.typeLabel).toBe('Feature');
  });

  it('moves to the parent of a document that is outside the active item', () => {
    expect(scopeShowing(nodes, 'S1', 'E')).toBe('E');
    expect(scopeShowing(nodes, 'S3', 'F1')).toBe('F2');
    expect(scopeShowing(nodes, 'P', 'F1')).toBeNull();
  });
});

describe('CanvasMode', () => {
  const nodes = sampleBoard();

  it('scopes the canvas only in edit mode', () => {
    const mode = new CanvasMode();
    mode.enter('F1', nodes);
    expect(mode.scope).toBeNull();
    mode.setMode('edit');
    expect(mode.scope).toBe('F1');
    mode.toggle();
    expect(mode.mode).toBe('read');
    // Read mode keeps the active item for the next switch to edit mode.
    expect(mode.activeId).toBe('F1');
  });

  it('reports the item that the canvas came out of when it goes up', () => {
    const mode = new CanvasMode();
    mode.setMode('edit');
    mode.enter('F1', nodes);
    expect(mode.goTo('P', nodes)).toBe('E');
    expect(mode.activeId).toBe('P');
    expect(mode.goTo(null, nodes)).toBe('P');
    expect(mode.activeId).toBeNull();
  });

  it('reports nothing when it goes down or sideways', () => {
    const mode = new CanvasMode();
    mode.enter('E', nodes);
    expect(mode.goTo('F1', nodes)).toBeNull();
    expect(mode.goTo('F2', nodes)).toBeNull();
  });

  it('goes up one level', () => {
    const mode = new CanvasMode();
    mode.enter('F1', nodes);
    expect(mode.goUp(nodes)).toBe('F1');
    expect(mode.activeId).toBe('E');
  });

  it('falls back to the nearest ancestor that exists when the active item leaves the board', () => {
    const mode = new CanvasMode();
    mode.enter('F1', nodes);
    mode.retain((id) => id !== 'F1');
    expect(mode.activeId).toBe('E');
    mode.retain((id) => id !== 'E' && id !== 'P');
    expect(mode.activeId).toBeNull();
  });

  it('follows the ids that a push allocates', () => {
    const mode = new CanvasMode();
    mode.enter('new:1', { ...nodes, 'new:1': issue('new:1', 'feature', 'E') });
    mode.renaming = 'new:1';
    mode.remap({ 'new:1': 'LP-9' });
    expect(mode.activeId).toBe('LP-9');
    expect(mode.renaming).toBe('LP-9');
  });

  it('closes the title field when it returns to read mode', () => {
    const mode = new CanvasMode();
    mode.setMode('edit');
    mode.renaming = 'S1';
    mode.setMode('read');
    expect(mode.renaming).toBeNull();
  });
});

describe('positions in both modes', () => {
  const node = (id: string, x: number, y: number, parentId?: string): CanvasNode =>
    ({
      id,
      type: 'issue',
      position: { x, y },
      parentId,
      width: 100,
      height: 50,
      minWidth: 100,
      minHeight: 50,
      level: parentId ? 1 : 0,
      data: {},
    }) as unknown as CanvasNode;

  it('moves the children of a frame inside it when one of them starts at a negative position', () => {
    const fixed = keepInsideFrames([
      node('F', 0, 0),
      node('A', -40, 100, 'F'),
      node('B', 60, -10, 'F'),
    ]);
    const at = new Map(fixed.map((entry) => [entry.id, entry.position]));
    expect(at.get('F')).toEqual({ x: 0, y: 0 });
    expect(at.get('A')).toEqual({ x: GROUP_PADDING, y: 100 + GROUP_HEADER + 10 });
    expect(at.get('B')).toEqual({ x: 60 + GROUP_PADDING + 40, y: GROUP_HEADER });
  });

  it('leaves a frame alone when no child is at a negative position', () => {
    const nodes = [node('F', 0, 0), node('A', 5, 3, 'F')];
    expect(keepInsideFrames(nodes)).toBe(nodes);
  });

  it('moves only top-level nodes when a scoped layout starts inside the frame', () => {
    const moved = shiftTopLevel([node('A', 0, 0), node('B', 10, 10, 'A')], FRAME_ORIGIN);
    expect(moved[0]!.position).toEqual(FRAME_ORIGIN);
    expect(moved[1]!.position).toEqual({ x: 10, y: 10 });
  });

  it('places the first new nodes of an empty scope inside the frame', () => {
    const placed = placeNewNodes([node('A', 0, 0)], [], () => false, FRAME_ORIGIN);
    expect(placed[0]!.position).toEqual(FRAME_ORIGIN);
  });
});

describe('CanvasGraph with an active item', () => {
  function source(layout: Record<string, NodeLayout> = {}): GraphSource {
    return {
      ready: true,
      nodes: sampleBoard(),
      config,
      members: everything,
      layout,
      display: {},
      selection: new Selection(),
      isCollapsed: () => false,
      toggleCollapsed: () => {},
      setLayout: (id, next) => {
        layout[id] = { ...(layout[id] ?? { x: 0, y: 0 }), ...next };
      },
    };
  }

  it('changes its signature when the active item changes', () => {
    let scope: string | null = null;
    const graph = new CanvasGraph(source(), { scope: () => scope });
    const before = graph.signature();
    scope = 'E';
    expect(graph.signature()).not.toBe(before);
  });

  it('draws a saved child position at the top level unchanged, so both modes share one position', () => {
    const layout: Record<string, NodeLayout> = {
      P: { x: 0, y: 0 },
      E: { x: 24, y: 64 },
      F1: { x: 300, y: 200 },
      F2: { x: 700, y: 200 },
      S1: { x: 24, y: 64 },
      S2: { x: 400, y: 64 },
      S3: { x: 24, y: 64 },
      S4: { x: 400, y: 64 },
    };
    const graph = new CanvasGraph(source(layout), { scope: () => 'E' });
    graph.sync();
    const f1 = graph.nodes.find((entry) => entry.id === 'F1')!;
    expect(f1.parentId).toBeUndefined();
    expect(f1.position).toEqual({ x: 300, y: 200 });
  });

  it('arranges the inside of the active item from the inside of its frame', () => {
    const layout: Record<string, NodeLayout> = {};
    const graph = new CanvasGraph(source(layout), { scope: () => 'E' });
    graph.arrange();
    const top = ['F1', 'F2'].map((id) => layout[id]!);
    expect(Math.min(...top.map((entry) => entry.x))).toBe(FRAME_ORIGIN.x);
    expect(Math.min(...top.map((entry) => entry.y))).toBe(FRAME_ORIGIN.y);
  });
});

function makeWorkspace(): Workspace {
  const nodes = sampleBoard();
  const workspace = new Workspace();
  workspace.snapshot = {
    config,
    issues: Object.values(nodes) as IssueDto[],
    periods: [],
    resources: [],
    squads: [],
    templates: [],
    problems: [],
    readAt: new Date().toISOString(),
  } satisfies BoardSnapshot;
  workspace.view = { ...emptyView('test', 'Test'), members: [...everything] };
  workspace.nodes = nodes;
  workspace.index = buildIndex(nodes);
  return workspace;
}

const labels = (entries: MenuEntry[]): string[] =>
  entries.filter((entry) => !isSeparator(entry) && !isHeading(entry)).map((entry) => (entry as MenuItem).label);

function editActions(activeId: string | null, calls: string[]): EditActions {
  return {
    activeId,
    enter: (id) => calls.push(`enter ${id}`),
    rename: (id) => calls.push(`rename ${id}`),
    openWindow: (id) => calls.push(`window ${id}`),
    draft: (type, at) => calls.push(`draft ${type} ${at?.x},${at?.y}`),
  };
}

describe('menus in edit mode', () => {
  it('offers the child types of the active item under New, and opens a card for the title', () => {
    const workspace = makeWorkspace();
    const calls: string[] = [];
    const menu = paneMenu({
      workspace,
      shell: new Shell(),
      at: { x: 5, y: 6 },
      edit: editActions('F1', calls),
    });
    const create = menu.find((entry) => (entry as MenuItem).label === 'New') as MenuItem;
    expect(create.items!.map((item) => (item as MenuItem).label)).toEqual(['User Story', 'Bug']);
    (create.items![1] as MenuItem).onSelect!();
    expect(calls).toEqual(['draft bug 5,6']);
    // Nothing reaches the board until the title is submitted.
    expect(workspace.pending).toEqual([]);
  });

  it('keeps the top-level types under New in read mode', () => {
    const menu = paneMenu({ workspace: makeWorkspace(), shell: new Shell() });
    const create = menu.find((entry) => (entry as MenuItem).label === 'New') as MenuItem;
    expect(create.items!.map((item) => (item as MenuItem).label)).toEqual(['Program']);
  });

  it('puts Work inside, Rename and Open in a window at the top of a node menu', () => {
    const workspace = makeWorkspace();
    const calls: string[] = [];
    const menu = nodeMenu({ workspace, shell: new Shell(), edit: editActions(null, calls) }, 'F1');
    expect(labels(menu).slice(0, 3)).toEqual(['Work inside', 'Rename', 'Open in a window']);
    (menu[0] as MenuItem).onSelect!();
    expect(calls).toEqual(['enter F1']);
  });

  it('adds nothing to a node menu in read mode', () => {
    const menu = nodeMenu({ workspace: makeWorkspace(), shell: new Shell() }, 'F1');
    expect(labels(menu)).not.toContain('Work inside');
    expect(labels(menu)).not.toContain('Rename');
  });
});

describe('new items in edit mode', () => {
  const draft: Draft = { serial: 1, parentId: 'F1', type: 'bug', position: { x: 40, y: 80 } };

  it('creates the child of the active item with the typed title, where the card was', () => {
    const workspace = makeWorkspace();
    const id = commitDraft(workspace, draft, 'Login fails');
    expect(id).not.toBeNull();
    const created = workspace.node(id!)!;
    expect(created.type).toBe('bug');
    expect(created.parentId).toBe('F1');
    expect(created.title).toBe('Login fails');
    expect(workspace.layout[id!]).toMatchObject({ x: 40, y: 80 });
    expect(workspace.isMember(id!)).toBe(true);
    expect(workspace.selection.ids).toEqual([id]);
  });

  it('creates nothing when the title is empty', () => {
    const workspace = makeWorkspace();
    expect(commitDraft(workspace, draft, cleanTitle('   '))).toBeNull();
    expect(workspace.pending).toEqual([]);
  });

  it('opens the next card one row lower, with the same parent and type', () => {
    const next = nextDraft(draft);
    expect(next.parentId).toBe('F1');
    expect(next.type).toBe('bug');
    expect(next.position.x).toBe(40);
    expect(next.position.y).toBeGreaterThan(80);
  });
});

describe('keys of edit mode', () => {
  const key = (name: string): KeyboardEvent =>
    ({ key: name, ctrlKey: false, metaKey: false, shiftKey: false }) as KeyboardEvent;
  const run = (workspace: Workspace, name: string, newItem?: () => void): void =>
    findBinding(key(name))!.run({ workspace, shell: new Shell(), arrange: () => {}, newItem });

  it('switches the mode with E', () => {
    const workspace = makeWorkspace();
    run(workspace, 'e');
    expect(workspace.canvasMode.editing).toBe(true);
    run(workspace, 'e');
    expect(workspace.canvasMode.editing).toBe(false);
  });

  it('clears the selection with Esc, and goes up a level when nothing is selected', () => {
    const workspace = makeWorkspace();
    workspace.canvasMode.setMode('edit');
    workspace.canvasMode.enter('F1', workspace.nodes);
    workspace.selection.set(['S1']);
    run(workspace, 'escape');
    expect(workspace.selection.ids).toEqual([]);
    expect(workspace.canvasMode.activeId).toBe('F1');
    run(workspace, 'escape');
    expect(workspace.canvasMode.activeId).toBe('E');
    expect(workspace.selection.ids).toEqual(['F1']);
  });

  it('opens a new item with N only in edit mode', () => {
    const workspace = makeWorkspace();
    let opened = 0;
    run(workspace, 'n', () => (opened += 1));
    expect(opened).toBe(0);
    workspace.canvasMode.setMode('edit');
    run(workspace, 'n', () => (opened += 1));
    expect(opened).toBe(1);
  });

  it('opens the title field of the selected item with F2 in edit mode', () => {
    const workspace = makeWorkspace();
    workspace.selection.set(['S2']);
    run(workspace, 'f2');
    expect(workspace.canvasMode.renaming).toBeNull();
    workspace.canvasMode.setMode('edit');
    run(workspace, 'f2');
    expect(workspace.canvasMode.renaming).toBe('S2');
  });
});

describe('Add new… opens the title field', () => {
  const addNew = (workspace: Workspace, parentId: string, type: string): void => {
    const menu = nodeMenu({ workspace, shell: new Shell() }, parentId);
    const add = menu.find((entry) => (entry as MenuItem).label === 'Add new…') as MenuItem;
    const item = add.items!.find((entry) => (entry as MenuItem).label === type) as MenuItem;
    item.onSelect!();
  };

  it('creates the child, selects it and opens its title field, in read mode too', () => {
    const workspace = makeWorkspace();
    addNew(workspace, 'F1', 'Bug');
    const id = workspace.selection.primary!;
    expect(workspace.node(id)?.parentId).toBe('F1');
    expect(workspace.canvasMode.editing).toBe(false);
    expect(workspace.canvasMode.renaming).toBe(id);
  });

  it('writes the typed title', () => {
    const workspace = makeWorkspace();
    addNew(workspace, 'F1', 'Bug');
    const id = workspace.selection.primary!;
    finishRename(workspace, id, 'Login fails');
    expect(workspace.node(id)?.title).toBe('Login fails');
    expect(workspace.canvasMode.renaming).toBeNull();
  });

  it('removes the new item, and leaves no change in the queue, when the title is cancelled', () => {
    const workspace = makeWorkspace();
    addNew(workspace, 'F1', 'Bug');
    const id = workspace.selection.primary!;
    finishRename(workspace, id, null);
    expect(workspace.node(id)).toBeUndefined();
    expect(workspace.isMember(id)).toBe(false);
    expect(workspace.pending).toEqual([]);
  });

  it('expands a collapsed parent, so the new item and its field are on the canvas', () => {
    const workspace = makeWorkspace();
    workspace.toggleCollapsed('F1');
    addNew(workspace, 'F1', 'Bug');
    expect(workspace.isCollapsed('F1')).toBe(false);
  });

  it('keeps an existing item when its rename is cancelled', () => {
    const workspace = makeWorkspace();
    workspace.canvasMode.startRename('S1');
    finishRename(workspace, 'S1', null);
    expect(workspace.node('S1')).toBeDefined();
    expect(workspace.pending).toEqual([]);
  });
});

describe('the title field and the automatic push', () => {
  it('counts the fields on screen, and closes each one once', () => {
    const mode = new CanvasMode();
    expect(mode.fieldOpen).toBe(false);
    const closeA = mode.openField();
    const closeB = mode.openField();
    closeA();
    closeA();
    expect(mode.fieldOpen).toBe(true);
    closeB();
    expect(mode.fieldOpen).toBe(false);
  });

  it('does not hold the push for a rename whose field is not on screen', () => {
    // `renaming` alone names a node that may not be drawn, for example one
    // outside the visible part of the canvas. Only a mounted field counts.
    const mode = new CanvasMode();
    mode.startRename('S1', true);
    expect(mode.fieldOpen).toBe(false);
  });
});
