import { describe, expect, it } from 'vitest';
import type { BoardSnapshot, IssueDto } from '$shared';
import { emptyView } from '$shared';
import { buildIndex } from '$lib/board/index.js';
import { BINDINGS, GESTURES, findBinding } from '$lib/shortcuts/bindings.js';
import { Selection } from '$lib/workspace/selection.svelte.js';
import { Workspace } from '$lib/workspace/workspace.svelte.js';
import { chainPairs, isLinkKey, linkSelection } from '$features/canvas/link.js';
import { config, sampleBoard } from './fixtures.js';

/**
 * The key F adds dependencies on the canvas.
 *
 * The sample board: P > E > F1 (S1, S2) and F2 (S3, S4), with the chain
 * S1 -> S2 -> S3 -> S4 (S2 depends on S1, and so on).
 */
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
  workspace.view = { ...emptyView('test', 'Test'), members: Object.keys(nodes) };
  workspace.nodes = nodes;
  workspace.index = buildIndex(nodes);
  return workspace;
}

const dependsOn = (workspace: Workspace, id: string): string[] => {
  const node = workspace.node(id);
  return node && 'dependsOn' in node ? [...node.dependsOn] : [];
};

describe('chainPairs', () => {
  it('makes the second id depend on the first', () => {
    expect(chainPairs(['A', 'B'])).toEqual([{ blocked: 'B', blocker: 'A' }]);
  });

  it('chains three ids in the order of the selection', () => {
    expect(chainPairs(['A', 'B', 'C'])).toEqual([
      { blocked: 'B', blocker: 'A' },
      { blocked: 'C', blocker: 'B' },
    ]);
  });

  it('gives nothing for fewer than two ids', () => {
    expect(chainPairs([])).toEqual([]);
    expect(chainPairs(['A'])).toEqual([]);
  });
});

describe('linkSelection', () => {
  it('makes the item selected second depend on the item selected first', () => {
    const workspace = makeWorkspace();
    workspace.selection.set(['S1']);
    workspace.selection.toggle('S4');
    expect(linkSelection(workspace)).toBe(1);
    expect(dependsOn(workspace, 'S4')).toEqual(['S3', 'S1']);
    expect(dependsOn(workspace, 'S1')).toEqual([]);
  });

  it('refuses a dependency that would close a cycle', () => {
    const workspace = makeWorkspace();
    // S4 already waits on S1 through S2 and S3.
    workspace.selection.set(['S4']);
    workspace.selection.toggle('S1');
    expect(linkSelection(workspace)).toBe(0);
    expect(dependsOn(workspace, 'S1')).toEqual([]);
  });

  it('counts no dependency that the board already has', () => {
    const workspace = makeWorkspace();
    workspace.selection.set(['S1']);
    workspace.selection.toggle('S2');
    expect(linkSelection(workspace)).toBe(0);
    expect(dependsOn(workspace, 'S2')).toEqual(['S1']);
  });

  it('adds nothing with one item selected', () => {
    const workspace = makeWorkspace();
    workspace.selection.set(['S1']);
    expect(linkSelection(workspace)).toBe(0);
  });
});

describe('isLinkKey', () => {
  const key = (init: Partial<Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>>) => ({
    key: 'f',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...init,
  });

  it('accepts F, also with Shift held', () => {
    expect(isLinkKey(key({}))).toBe(true);
    expect(isLinkKey(key({ key: 'F' }))).toBe(true);
  });

  it('leaves Ctrl+F, Cmd+F and Alt+F to the browser', () => {
    expect(isLinkKey(key({ ctrlKey: true }))).toBe(false);
    expect(isLinkKey(key({ metaKey: true }))).toBe(false);
    expect(isLinkKey(key({ altKey: true }))).toBe(false);
  });
});

describe('Selection.set', () => {
  it('keeps the order of the clicks when the canvas reports the selection in its own order', () => {
    const selection = new Selection();
    selection.set(['S4']);
    selection.toggle('S1');
    // SvelteFlow reports its selected nodes in the order of its node array.
    selection.set(['S1', 'S4']);
    expect(selection.ids).toEqual(['S4', 'S1']);
  });

  it('puts new ids after the ids that stay, and drops the ids that go', () => {
    const selection = new Selection();
    selection.set(['A', 'B']);
    selection.set(['C', 'B']);
    expect(selection.ids).toEqual(['B', 'C']);
  });
});

describe('shortcut list', () => {
  it('opens the list of shortcuts with the key ?', () => {
    const event = { key: '?', ctrlKey: false, metaKey: false, shiftKey: true } as KeyboardEvent;
    expect(findBinding(event)?.id).toBe('shortcuts');
  });

  it('lists the F gestures, and binds no key press to F', () => {
    expect(GESTURES.map((gesture) => gesture.keys)).toEqual(
      expect.arrayContaining(['F', 'F+drag', 'Alt+drag', 'Shift+click']),
    );
    expect(BINDINGS.some((binding) => binding.key === 'f')).toBe(false);
  });
});
