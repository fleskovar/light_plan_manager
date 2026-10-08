import { describe, expect, it } from 'vitest';
import type { StaticBoard } from '$shared';
import { ALL_ISSUES, ViewerBoard, allIssues, foldParents } from '../src/viewer/board.svelte.js';
import { fetchStaticBoard, resolveLocation } from '../src/viewer/source.js';
import { board as makeNodes, config, issue, period, resource } from './fixtures.js';

/**
 * The read-only viewer. Two things are worth testing and nothing else is: how a
 * URL becomes a board to fetch, and what the store does with the board once it
 * has one. The canvas it draws is the editor's, already covered by graph.test.
 */
const PAGE = 'https://acme.github.io/plan/';

function staticBoard(overrides: Partial<StaticBoard> = {}): StaticBoard {
  return {
    version: 1,
    generated: '2026-08-02T00:00:00.000Z',
    generator: 'light-plan test',
    board: {
      config,
      issues: [
        issue('P', 'program', null),
        issue('E', 'epic', 'P'),
        issue('F1', 'feature', 'E'),
        issue('S1', 'user_story', 'F1', { dependsOn: [] }),
        issue('S2', 'user_story', 'F1', { dependsOn: ['S1'] }),
      ],
      periods: [period('T1', '2026-07-01', '2026-12-31')],
      resources: [resource('R1', 'person')],
      squads: [],
      templates: [],
      problems: [],
      readAt: '2026-08-02T00:00:00.000Z',
    },
    views: [],
    ...overrides,
  };
}

describe('resolveLocation', () => {
  it('reads board.json beside the page when told nothing', () => {
    expect(resolveLocation('', PAGE)).toEqual({
      url: 'https://acme.github.io/plan/board.json',
      repo: null,
      homepage: null,
    });
  });

  it('builds a raw URL from ?repo', () => {
    const location = resolveLocation('?repo=acme/plan', PAGE);
    expect(location.url).toBe('https://raw.githubusercontent.com/acme/plan/HEAD/.lpm/board.json');
    expect(location.repo).toBe('acme/plan');
    expect(location.homepage).toBe('https://github.com/acme/plan');
  });

  it('takes a ref inline or as its own parameter', () => {
    expect(resolveLocation('?repo=acme/plan@v2.1', PAGE).url).toContain('/acme/plan/v2.1/');
    expect(resolveLocation('?repo=acme/plan&ref=release/2026', PAGE).url).toContain(
      '/acme/plan/release/2026/',
    );
    // The explicit parameter wins over the inline one.
    expect(resolveLocation('?repo=acme/plan@v1&ref=v2', PAGE).url).toContain('/acme/plan/v2/');
  });

  it('honours a custom path in the repository', () => {
    expect(resolveLocation('?repo=acme/plan&path=docs/board.json', PAGE).url).toBe(
      'https://raw.githubusercontent.com/acme/plan/HEAD/docs/board.json',
    );
  });

  it('follows an explicit ?src', () => {
    expect(resolveLocation('?src=https://example.com/b.json', PAGE).url).toBe(
      'https://example.com/b.json',
    );
    // Relative to the page, so a site can publish several boards.
    expect(resolveLocation('?src=other/b.json', PAGE).url).toBe(
      'https://acme.github.io/plan/other/b.json',
    );
  });

  it('refuses a URL it has no business fetching', () => {
    // The page fetches whatever it is pointed at; this is where that stops.
    expect(() => resolveLocation('?src=javascript:alert(1)', PAGE)).toThrow(/not a URL/);
    expect(() => resolveLocation('?src=data:text/json,{}', PAGE)).toThrow(/not a URL/);
  });

  it('refuses a repo, ref or path that is not one', () => {
    expect(() => resolveLocation('?repo=not-a-repo', PAGE)).toThrow(/owner\/name/);
    expect(() => resolveLocation('?repo=a/b/c', PAGE)).toThrow(/owner\/name/);
    expect(() => resolveLocation('?repo=acme/plan&ref=a b', PAGE)).toThrow(/branch, tag or commit/);
    expect(() => resolveLocation('?repo=acme/plan&path=../../etc', PAGE)).toThrow(/not a path/);
  });
});

describe('fetchStaticBoard', () => {
  const location = { url: 'https://example.com/board.json', repo: null, homepage: null };

  const respond = (init: ResponseInit, body: unknown = {}): typeof fetch =>
    (async () => new Response(JSON.stringify(body), init)) as unknown as typeof fetch;

  it('never sends the reader’s credentials', async () => {
    let seen: RequestInit | undefined;
    const spy = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify(staticBoard()));
    }) as unknown as typeof fetch;

    await fetchStaticBoard(location, spy);
    expect(seen?.credentials).toBe('omit');
  });

  it('explains a 404 in terms of what to do about it', async () => {
    await expect(fetchStaticBoard(location, respond({ status: 404 }))).rejects.toThrow(
      /lpm export/,
    );
    await expect(
      fetchStaticBoard({ ...location, repo: 'acme/plan' }, respond({ status: 404 })),
    ).rejects.toThrow(/acme\/plan has no exported board/);
  });

  it('reports any other failure with its status', async () => {
    await expect(
      fetchStaticBoard(location, respond({ status: 500, statusText: 'Server Error' })),
    ).rejects.toThrow(/500/);
  });

  it('rejects a body that is not an export', async () => {
    await expect(fetchStaticBoard(location, respond({}, { nope: true }))).rejects.toThrow(
      /not a light-plan export/,
    );
  });

  it('returns the board when everything is well', async () => {
    const data = await fetchStaticBoard(location, respond({}, staticBoard()));
    expect(data.board.issues).toHaveLength(5);
  });
});

describe('allIssues', () => {
  it('is every issue, with no positions so the canvas lays it out', () => {
    const view = allIssues(staticBoard());
    expect(view.id).toBe(ALL_ISSUES);
    expect(view.members).toEqual(['P', 'E', 'F1', 'S1', 'S2']);
    expect(view.layout).toEqual({});
  });
});

describe('foldParents', () => {
  it('folds a node that has a child on screen, and nothing else', () => {
    const nodes = makeNodes(
      issue('P', 'program', null),
      issue('E', 'epic', 'P'),
      issue('S1', 'user_story', 'E'),
    );
    expect(foldParents(nodes, ['P', 'E', 'S1'])).toEqual({ P: true, E: true });
  });

  it('ignores a parent that is not on screen', () => {
    const nodes = makeNodes(issue('P', 'program', null), issue('E', 'epic', 'P'));
    expect(foldParents(nodes, ['E'])).toEqual({});
  });
});

describe('ViewerBoard', () => {
  it('opens the whole board when there are no saved views', () => {
    const store = new ViewerBoard();
    store.load(staticBoard());

    expect(store.ready).toBe(true);
    expect(store.viewId).toBe(ALL_ISSUES);
    expect(store.members).toEqual(['P', 'E', 'F1', 'S1', 'S2']);
    // Everything with children starts folded, so the board opens at its top.
    expect(store.isCollapsed('P')).toBe(true);
    expect(store.isCollapsed('F1')).toBe(true);
    expect(store.isCollapsed('S1')).toBe(false);
    expect(store.layout).toEqual({});
  });

  it('opens the first saved view when there is one', () => {
    const store = new ViewerBoard();
    store.load(
      staticBoard({
        views: [
          { id: 'roadmap', name: 'Roadmap', updated: '', members: ['S1', 'S2'], layout: {} },
        ],
      }),
    );
    expect(store.viewId).toBe('roadmap');
    expect(store.members).toEqual(['S1', 'S2']);
  });

  it('opens the view the URL names', () => {
    const store = new ViewerBoard();
    store.load(
      staticBoard({
        views: [
          { id: 'a', name: 'A', updated: '', members: ['S1'], layout: {} },
          { id: 'b', name: 'B', updated: '', members: ['S2'], layout: {} },
        ],
      }),
      'b',
    );
    expect(store.viewId).toBe('b');
  });

  it('offers the whole board alongside the saved views', () => {
    const store = new ViewerBoard();
    store.load(
      staticBoard({ views: [{ id: 'a', name: 'A', updated: '', members: [], layout: {} }] }),
    );
    expect(store.views.map((view) => view.id)).toEqual(['a', ALL_ISSUES]);
  });

  it('takes positions and folding from the view it opens', () => {
    const store = new ViewerBoard();
    store.load(
      staticBoard({
        views: [
          {
            id: 'a',
            name: 'A',
            updated: '',
            members: ['F1', 'S1', 'S2'],
            layout: { F1: { x: 5, y: 6, collapsed: true }, S1: { x: 7, y: 8 } },
          },
        ],
      }),
    );

    expect(store.isCollapsed('F1')).toBe(true);
    expect(store.isCollapsed('S1')).toBe(false);
    // `collapsed` does not travel in the positional map, or the canvas would
    // treat a fold as a saved position and skip the automatic layout.
    expect(store.layout).toEqual({ F1: { x: 5, y: 6 }, S1: { x: 7, y: 8 } });
  });

  it('drops a member the board no longer has', () => {
    const store = new ViewerBoard();
    store.load(
      staticBoard({
        views: [{ id: 'a', name: 'A', updated: '', members: ['S1', 'GONE'], layout: {} }],
      }),
    );
    expect(store.members).toEqual(['S1']);
  });

  it('holds positions and folding in memory, with nowhere to write them', () => {
    const store = new ViewerBoard();
    store.load(staticBoard());

    store.setLayout('S1', { x: 11, y: 22 });
    expect(store.layout.S1).toEqual({ x: 11, y: 22 });

    store.toggleCollapsed('F1');
    expect(store.isCollapsed('F1')).toBe(false);
    store.toggleCollapsed('F1');
    expect(store.isCollapsed('F1')).toBe(true);

    store.resetLayout();
    expect(store.layout).toEqual({});
  });

  it('switching views resets what the last one left behind', () => {
    const store = new ViewerBoard();
    store.load(
      staticBoard({
        views: [
          { id: 'a', name: 'A', updated: '', members: ['S1'], layout: {} },
          { id: 'b', name: 'B', updated: '', members: ['S2'], layout: {} },
        ],
      }),
    );

    store.setLayout('S1', { x: 1, y: 2 });
    store.selection.set(['S1']);
    store.open('b');

    expect(store.members).toEqual(['S2']);
    expect(store.layout).toEqual({});
    expect(store.selection.ids).toEqual([]);
  });

  it('falls back to the whole board when asked for a view that is gone', () => {
    const store = new ViewerBoard();
    store.load(staticBoard());
    store.open('deleted-last-week');
    expect(store.viewId).toBe(ALL_ISSUES);
  });

  it('reports a failure instead of pretending it has a board', () => {
    const store = new ViewerBoard();
    store.fail('No board at https://example.com/board.json');
    expect(store.ready).toBe(false);
    expect(store.loading).toBe(false);
    expect(store.error).toContain('No board');
  });

  it('builds an index from the loaded static board', () => {
    const store = new ViewerBoard();
    store.load(staticBoard());

    // The index must answer the same questions selectors would.
    expect(store.index.rootsOf('issue').map((n) => n.id)).toEqual(['P']);
    expect(store.index.childrenOf('F1').map((n) => n.id)).toEqual(['S1', 'S2']);
    expect(store.index.hasChildren('P')).toBe(true);
    expect(store.index.hasChildren('S1')).toBe(false);
    expect(store.index.ancestorsOf('S1').map((n) => n.id)).toEqual(['F1', 'E', 'P']);
    // Dependents: S2 depends on S1
    expect(store.index.dependentsOf('S1')).toEqual(['S2']);
    expect(store.index.subtreeIds('E').sort()).toEqual(['E', 'F1', 'S1', 'S2'].sort());
  });
});
