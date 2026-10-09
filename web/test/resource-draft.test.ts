import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardSnapshot, ConfigDto, ResourceDto } from '$shared';
import { emptyView } from '$shared';
import { api } from '$lib/api/client.js';
import { buildIndex } from '$lib/board/index.js';
import { Workspace } from '$lib/workspace/workspace.svelte.js';
import {
  canCreate,
  createFromDraft,
  draftNode,
  editDraft,
  newResourceDraft,
  toggleDraftCoverer,
} from '$features/drawer/team/resource-draft.js';
import { board, config as baseConfig, resource } from './fixtures.js';

/**
 * Adding a resource used to queue the create the moment Add was pressed and
 * open the editor on it. The push that follows every edit then gave it a real
 * id, the editor was left holding a temporary one, and the form emptied itself
 * a second and a half after it opened. These cases pin both halves of the fix:
 * the form edits a draft that queues nothing until Create, and a dialog open on
 * an unpushed document follows it to the id the push allocated.
 */
const config: ConfigDto = {
  ...baseConfig,
  types: {
    ...baseConfig.types,
    person: {
      ...baseConfig.types.person!,
      attributes: [
        { name: 'skill', type: 'string' },
        { name: 'seniority', type: 'enum', values: ['jr', 'sr'], default: 'jr' },
      ],
    },
  },
};

const roster = () =>
  board(
    resource('ANA', 'person', { title: 'Ana', covers: [] }),
    resource('POOL', 'role', { title: 'Backend' }),
  );

function makeWorkspace(): Workspace {
  const workspace = new Workspace();
  const nodes = roster();
  workspace.snapshot = {
    config,
    issues: [],
    periods: [],
    resources: Object.values(nodes) as ResourceDto[],
    squads: [],
    templates: [],
    problems: [],
    readAt: new Date().toISOString(),
  } satisfies BoardSnapshot;
  workspace.view = emptyView('test', 'Test');
  workspace.nodes = nodes;
  workspace.index = buildIndex(nodes);
  return workspace;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a resource draft', () => {
  it('previews as the resource it will become, with the type defaults filled in', () => {
    const preview = draftNode(newResourceDraft('person'), roster(), config);
    expect(preview).toMatchObject({
      kind: 'resource',
      type: 'person',
      title: '',
      capacity: 1,
      generic: false,
      attributes: { skill: null, seniority: 'jr' },
    });
  });

  it('cannot be created until it has a name', () => {
    const draft = newResourceDraft('person');
    expect(canCreate(draft)).toBe(false);
    expect(canCreate(editDraft(draft, { title: '   ' }, roster(), config))).toBe(false);
    expect(canCreate(editDraft(draft, { title: 'Bo' }, roster(), config))).toBe(true);
  });

  it('keeps only what still fits when its type changes', () => {
    let draft = newResourceDraft('person');
    draft = editDraft(draft, { covers: ['POOL'], attributes: { skill: 'go' } }, roster(), config);
    draft = editDraft(draft, { type: 'role' }, roster(), config);

    // A pool covers nothing and declares no `skill`; it is covered instead.
    expect(draft).toMatchObject({ type: 'role', covers: [], attributes: {} });
    expect(draftNode(draft, roster(), config).generic).toBe(true);

    draft = toggleDraftCoverer(draft, 'ANA', true);
    expect(editDraft(draft, { type: 'person' }, roster(), config).coveredBy).toEqual([]);
  });
});

describe('createFromDraft', () => {
  it('queues nothing until it is called, then one create carrying the whole form', () => {
    const workspace = makeWorkspace();
    let draft = newResourceDraft('person');
    draft = editDraft(draft, { title: '  Bo  ', capacity: 4, covers: ['POOL'] }, workspace.nodes, config);
    draft = editDraft(draft, { attributes: { skill: 'svelte' } }, workspace.nodes, config);
    expect(workspace.pending).toEqual([]);

    const id = createFromDraft(workspace, draft);

    expect(workspace.pending).toEqual([
      {
        kind: 'create',
        id,
        nodeKind: 'resource',
        patch: {
          type: 'person',
          title: 'Bo',
          parentId: null,
          capacity: 4,
          covers: ['POOL'],
          attributes: { skill: 'svelte' },
        },
      },
    ]);
    expect(workspace.node(id)).toMatchObject({ title: 'Bo', capacity: 4, covers: ['POOL'] });
  });

  it('writes a new pool onto the documents of the people who cover it', () => {
    const workspace = makeWorkspace();
    let draft = editDraft(newResourceDraft('role'), { title: 'Frontend' }, workspace.nodes, config);
    draft = toggleDraftCoverer(draft, 'ANA', true);

    const id = createFromDraft(workspace, draft);

    expect((workspace.node('ANA') as ResourceDto).covers).toEqual([id]);
    expect(workspace.pending.map((change) => [change.kind, change.id])).toEqual([
      ['create', id],
      ['update', 'ANA'],
    ]);
  });
});

describe('Workspace.resolve', () => {
  it('follows an unpushed document to the id its push allocated', async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const id = createFromDraft(
      workspace,
      editDraft(newResourceDraft('person'), { title: 'Bo' }, workspace.nodes, config),
    );
    expect(workspace.resolve(id)).toBe(id);

    const pushed = resource('TM-9', 'person', { title: 'Bo' });
    vi.spyOn(api, 'saveView').mockImplementation(async (view) => view);
    vi.spyOn(api, 'push').mockImplementation(async (view) => ({
      idMap: { [id]: 'TM-9' },
      failures: [],
      board: { ...workspace.snapshot!, resources: [...workspace.snapshot!.resources, pushed] },
      view: { ...view, changes: [] },
    }));

    await workspace.push(true);

    expect(workspace.node(id)).toBeUndefined();
    expect(workspace.resolve(id)).toBe('TM-9');
    expect(workspace.node(workspace.resolve(id))?.title).toBe('Bo');
  });

  it('never hands a pushed temporary id to a later document', async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const first = createFromDraft(
      workspace,
      editDraft(newResourceDraft('person'), { title: 'Bo' }, workspace.nodes, config),
    );
    vi.spyOn(api, 'saveView').mockImplementation(async (view) => view);
    vi.spyOn(api, 'push').mockImplementation(async (view) => ({
      idMap: { [first]: 'TM-9' },
      failures: [],
      board: {
        ...workspace.snapshot!,
        resources: [...workspace.snapshot!.resources, resource('TM-9', 'person')],
      },
      view: { ...view, changes: [] },
    }));
    await workspace.push(true);

    const second = createFromDraft(
      workspace,
      editDraft(newResourceDraft('person'), { title: 'Cy' }, workspace.nodes, config),
    );
    expect(second).not.toBe(first);
    expect(workspace.resolve(first)).toBe('TM-9');
  });
});
