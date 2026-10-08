import { describe, expect, it } from 'vitest';
import type { BoardSnapshot, TemplateDto } from '$shared';
import { emptyView } from '$shared';
import { buildIndex } from '$lib/board/index.js';
import { applyChange, replay } from '$lib/board/working.js';
import { neighbours } from '$lib/board/links.js';
import { childTypes } from '$lib/board/links.js';
import { addDependency, createNode, editNode } from '$lib/workspace/mutations.js';
import { Workspace } from '$lib/workspace/workspace.svelte.js';
import { paneMenu, bulkEntries } from '$features/canvas/menus.js';
import { Shell } from '$lib/app/shell.svelte.js';
import { blankRow, fromRows, toRows } from '$features/panel/sections/params.js';
import { board, config, issue, template } from './fixtures.js';

/**
 * The registry as the editor sees it: the same canvas, the same queue, the same
 * push — pointed at a different collection.
 */

/**
 * TF1 folder > TF2 folder > T1 feature (a root) > T2, T3 stories, T3 after T2.
 * Folder ids start with `TF` so the fixture can work out what is a root.
 */
function registry() {
  return board(
    template('TF1', 'folder', null, { title: 'Delivery' }),
    template('TF2', 'folder', 'TF1', { title: 'Epic slot' }),
    template('T1', 'feature', 'TF2', {
      title: '{{name}} API',
      description: 'A feature and its stories',
      params: { name: { type: 'string', required: true } },
    }),
    template('T2', 'user_story', 'T1', { title: 'Design {{name}}' }),
    template('T3', 'user_story', 'T1', { title: 'Build {{name}}', dependsOn: ['T2'] }),
  );
}

function makeWorkspace(mode: 'board' | 'templates' = 'templates'): Workspace {
  const workspace = new Workspace();
  const nodes = registry();
  workspace.snapshot = {
    config,
    issues: [],
    periods: [],
    resources: [],
    squads: [],
    templates: Object.values(nodes) as TemplateDto[],
    problems: [],
    readAt: new Date().toISOString(),
  } satisfies BoardSnapshot;
  workspace.view = { ...emptyView('test', 'Test'), mode, members: Object.keys(nodes) };
  workspace.nodes = nodes;
  workspace.index = buildIndex(nodes);
  return workspace;
}

describe('a registry view', () => {
  it('creates templates rather than issues, whatever the type says', () => {
    const workspace = makeWorkspace();
    // `feature` is an *issue* type; only the mode says which collection this
    // lands in, which is the whole reason `Workspace.nodeKind` exists.
    const id = createNode(workspace, { type: 'feature', parentId: 'TF2' });
    expect(workspace.node(id)?.kind).toBe('template');
    expect(workspace.pending[0]).toMatchObject({ kind: 'create', nodeKind: 'template' });
  });

  it('still creates issues in a board view', () => {
    const workspace = makeWorkspace('board');
    const id = createNode(workspace, { type: 'feature', parentId: null });
    expect(workspace.node(id)?.kind).toBe('issue');
  });

  it('puts a new template on the canvas, like a new issue', () => {
    const workspace = makeWorkspace();
    const id = createNode(workspace, { type: 'user_story', parentId: 'T1' });
    expect(workspace.isMember(id)).toBe(true);
  });

  it('offers the registry hierarchy at the top level, folder included', () => {
    const workspace = makeWorkspace();
    const menu = paneMenu({ workspace, shell: new Shell() });
    const entry = menu.find((item) => 'label' in item && item.label === 'New');
    const labels = (entry as { items: { label: string }[] }).items.map((item) => item.label);
    expect(labels).toContain('Program');
    expect(labels).toContain('Folder');
  });

  it('offers nothing about status, assignee or period', () => {
    const workspace = makeWorkspace();
    expect(bulkEntries({ workspace, shell: new Shell() }, ['T1'])).toEqual([]);
  });

  it('works off the queue rather than the calendar', () => {
    // A template has no dates and never will, whatever the board's config says.
    expect(makeWorkspace().planning).toBe('queue');
  });

  it('names the collection new documents go in', () => {
    expect(makeWorkspace().nodeKind).toBe('template');
    expect(makeWorkspace('board').nodeKind).toBe('issue');
  });
});

describe('template edges', () => {
  it('links two templates', () => {
    const workspace = makeWorkspace();
    expect(addDependency(workspace, 'T2', 'T1')).toBe(true);
    expect((workspace.node('T2') as TemplateDto).dependsOn).toEqual(['T1']);
  });

  it('refuses an edge between a template and an issue', () => {
    const workspace = makeWorkspace();
    // An issue waiting on a piece of paper, or the other way round: neither is
    // a thing anybody means, and the board would refuse both on push.
    workspace.nodes.LP1 = issue('LP1', 'feature', null);
    expect(addDependency(workspace, 'T2', 'LP1')).toBe(false);
    expect(addDependency(workspace, 'LP1', 'T2')).toBe(false);
  });

  it('refuses an edge that closes a loop', () => {
    const workspace = makeWorkspace();
    // T3 already depends on T2, so T2 depending on T3 would close it.
    expect(addDependency(workspace, 'T2', 'T3')).toBe(false);
  });

  it('answers what waits on a template', () => {
    const workspace = makeWorkspace();
    // The registry is a shape rather than a plan, so nothing is reflected onto
    // the containers above a template. @see src/shared/dependency-rollup.ts
    const rolled = { rolledUpUpstream: [], rolledUpDownstream: [] };
    expect(neighbours(workspace.nodes, 'T2')).toEqual({
      upstream: [],
      downstream: ['T3'],
      ...rolled,
    });
    expect(neighbours(workspace.nodes, 'T3')).toEqual({
      upstream: ['T2'],
      downstream: [],
      ...rolled,
    });
  });

  it('offers the levels below a template as new children', () => {
    expect(childTypes(config, 'template', 2)).toContain('user_story');
    expect(childTypes(config, 'template', 2)).toContain('folder');
  });
});

describe('the working copy', () => {
  it('derives root from the parent when a template is reparented', () => {
    const nodes = registry();
    const index = buildIndex(nodes);
    expect((nodes.T2 as TemplateDto).root).toBe(false);

    // Dragged out of the feature and up beside it, under the folder.
    applyChange(nodes, { kind: 'update', id: 'T2', nodeKind: 'template', patch: { parentId: 'TF2' } }, config, index);
    expect((nodes.T2 as TemplateDto).root).toBe(true);

    applyChange(nodes, { kind: 'update', id: 'T2', nodeKind: 'template', patch: { parentId: 'T1' } }, config, index);
    expect((nodes.T2 as TemplateDto).root).toBe(false);
  });

  it('applies a description and parameters through the queue', () => {
    const workspace = makeWorkspace();
    editNode(workspace, 'T1', {
      description: 'Now with tests',
      params: { name: { type: 'string', required: true }, owner: { type: 'string' } },
    });
    const node = workspace.node('T1') as TemplateDto;
    expect(node.description).toBe('Now with tests');
    expect(Object.keys(node.params)).toEqual(['name', 'owner']);
  });

  it('drops the edges pointing at a deleted template', () => {
    const nodes = registry();
    const index = buildIndex(nodes);
    applyChange(nodes, { kind: 'delete', id: 'T2', nodeKind: 'template' }, config, index);
    expect((nodes.T3 as TemplateDto).dependsOn).toEqual([]);
  });

  it('replays a saved queue of template changes', () => {
    const nodes = replay(
      Object.values(registry()),
      [
        {
          kind: 'create',
          id: 'new:1',
          nodeKind: 'template',
          patch: { type: 'user_story', title: 'Ship {{name}}', parentId: 'T1' },
        },
      ],
      config,
    );
    expect(nodes['new:1']).toMatchObject({ kind: 'template', title: 'Ship {{name}}', root: false });
  });
});

describe('the parameter editor', () => {
  it('round-trips a declaration through rows and back', () => {
    const params = {
      name: { type: 'string' as const, required: true, description: 'What it is for' },
      tier: { type: 'enum' as const, values: ['a', 'b'], default: 'a' },
    };
    expect(fromRows(toRows(params)).params).toEqual(params);
  });

  it('leaves a half-typed row out instead of failing', () => {
    const rows = [blankRow()];
    expect(fromRows(rows)).toEqual({ params: {}, errors: [] });
  });

  it('refuses a name that is not lower_snake_case', () => {
    const rows = [{ ...blankRow(), name: 'Not A Name' }];
    const result = fromRows(rows);
    expect(result.params).toEqual({});
    expect(result.errors[0]).toMatch(/lower_snake_case/);
  });

  it('refuses an enum with no values, and a name declared twice', () => {
    expect(fromRows([{ ...blankRow(), name: 'tier', type: 'enum' }]).errors[0]).toMatch(
      /needs at least one value/,
    );
    expect(
      fromRows([
        { ...blankRow(), name: 'a' },
        { ...blankRow(), name: 'a' },
      ]).errors[0],
    ).toMatch(/declared twice/);
  });

  it('reads a default as the type it was declared with', () => {
    const { params } = fromRows([
      { ...blankRow(), name: 'size', type: 'int', defaultText: '5' },
      { ...blankRow(), name: 'on', type: 'bool', defaultText: 'true' },
      { ...blankRow(), name: 'tags', type: 'array', defaultText: 'a, b' },
    ]);
    expect(params.size?.default).toBe(5);
    expect(params.on?.default).toBe(true);
    expect(params.tags?.default).toEqual(['a', 'b']);
  });
});
