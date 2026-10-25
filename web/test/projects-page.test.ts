import { describe, expect, it } from 'vitest';
import type { ProjectEntryDto, ViewSummary } from '$shared';
import { emptyView, summarize } from '$shared';
import type { ProjectsApi } from '$features/projects/projects.svelte.js';
import { ProjectsPage, viewUrl } from '$features/projects/projects.svelte.js';
import { PROJECTS_PATH, goToProjects } from '$lib/app/projects-link.js';
import { fileMenu, type ViewContext } from '$features/commandbar/menus.js';

/**
 * The "All projects" page (LPM-53): every project of the index, local and
 * central, with Open and Reveal. File > "All projects…" opens it, and the hub
 * of `lpm ui` shows it as its landing page.
 */

function entry(name: string, overrides: Partial<ProjectEntryDto> = {}): ProjectEntryDto {
  return {
    name,
    root: `/work/${name}`,
    lpmDir: `/work/${name}/.lpm`,
    store: 'local',
    keyPrefix: name.slice(0, 2).toUpperCase(),
    lastUsed: '2026-10-24T10:00:00.000Z',
    state: 'ok',
    ...overrides,
  };
}

function view(id: string, name: string, description = ''): ViewSummary {
  return summarize(emptyView(id, name, '2026-10-24T10:00:00.000Z', description));
}

interface FakeOptions {
  openFails?: boolean;
  revealFails?: boolean;
  /** The views of each board folder. A folder that is absent fails the request. */
  views?: Record<string, ViewSummary[]>;
}

function fakeApi(projects: ProjectEntryDto[], options: FakeOptions = {}) {
  const calls: string[] = [];
  const api: ProjectsApi = {
    list: async () => projects,
    open: async (lpmDir) => {
      calls.push(`open ${lpmDir}`);
      if (options.openFails) throw new Error('Every port is taken');
      return { url: 'http://127.0.0.1:4573' };
    },
    views: async (lpmDir) => {
      calls.push(`views ${lpmDir}`);
      const list = options.views?.[lpmDir];
      if (!list) throw new Error('View "x" is not valid JSON');
      return list;
    },
    reveal: async (lpmDir) => {
      calls.push(`reveal ${lpmDir}`);
      if (options.revealFails) throw new Error('Could not show the file in the file manager');
    },
    // The move, backup and restore routes have their own tests in store-maintenance.test.ts.
    backups: async () => ({ store: '/boards', backupsDir: '/boards/.lpm_backups', backups: [] }),
    jobs: async () => [],
    move: async () => {
      throw new Error('not used here');
    },
    backup: async () => {
      throw new Error('not used here');
    },
    restore: async () => {
      throw new Error('not used here');
    },
  };
  return { api, calls };
}

describe('ProjectsPage', () => {
  it('lists the projects in the order of the API, with store, folder and last use', async () => {
    const { api } = fakeApi([
      entry('blog', { store: 'central', lpmDir: '/boards/.lpm_central/blog' }),
      entry('shop'),
    ]);
    const page = new ProjectsPage(api, () => {});

    await page.load();

    expect(page.loading).toBe(false);
    expect(page.rows.map((row) => [row.name, row.store, row.folder, row.lastUsedText])).toEqual([
      ['blog', 'central', '/work/blog', '2026-10-24'],
      ['shop', 'local', '/work/shop', '2026-10-24'],
    ]);
  });

  it('shows "never" for a project that no command recorded, and the board folder when the project is unknown', async () => {
    const { api } = fakeApi([entry('loose', { root: null, lpmDir: '/boards/.lpm_central/loose', lastUsed: null })]);
    const page = new ProjectsPage(api, () => {});
    await page.load();
    expect(page.rows[0]).toMatchObject({ folder: '/boards/.lpm_central/loose', lastUsedText: 'never' });
  });

  it('opens a project by its board folder and goes to the returned URL', async () => {
    const { api, calls } = fakeApi([entry('shop')]);
    const visited: string[] = [];
    const page = new ProjectsPage(api, (url) => visited.push(url));
    await page.load();

    await page.open('/work/shop/.lpm');

    expect(calls).toEqual(['open /work/shop/.lpm']);
    expect(visited).toEqual(['http://127.0.0.1:4573']);
  });

  it('keeps an error text when open or reveal fails', async () => {
    const { api } = fakeApi([entry('shop')], { openFails: true, revealFails: true });
    const visited: string[] = [];
    const page = new ProjectsPage(api, (url) => visited.push(url));
    await page.load();

    await page.open('/work/shop/.lpm');
    expect(page.error).toContain('Every port is taken');
    expect(visited).toEqual([]);

    await page.reveal('/work/shop/.lpm');
    expect(page.error).toContain('Could not show the file');
  });

  it('labels the states, and lets a missing project be neither opened nor revealed', async () => {
    const { api, calls } = fakeApi([
      entry('gone', { state: 'missing' }),
      entry('loose', { store: 'central', state: 'project missing' }),
      entry('shop'),
    ]);
    const page = new ProjectsPage(api, () => {});
    await page.load();

    expect(page.rows.map((row) => [row.name, row.label, row.canOpen, row.canReveal])).toEqual([
      ['gone', 'missing', false, false],
      ['loose', 'project missing', true, false],
      ['shop', null, true, true],
    ]);
    await page.open('/work/gone/.lpm');
    await page.reveal('/work/gone/.lpm');
    expect(calls).toEqual([]);
  });

  it('gives a text for an empty list', async () => {
    const { api } = fakeApi([]);
    const page = new ProjectsPage(api, () => {});
    expect(page.emptyText).toBeNull();
    await page.load();
    expect(page.emptyText).toContain('lpm');
  });
});

/**
 * The section of views of a project row. The first expand reads the view list
 * of the board, a second expand shows the list that the page kept, and a click
 * on a view goes to the board server at that view.
 */
describe('the views of a project', () => {
  const shop = '/work/shop/.lpm';
  const views = {
    [shop]: [view('roadmap', 'Roadmap', 'Epics of 2026, by quarter'), view('triage', 'Triage')],
  };

  it('reads the views of a board on the first expand only', async () => {
    const { api, calls } = fakeApi([entry('shop')], { views });
    const page = new ProjectsPage(api, () => {});
    await page.load();
    expect(page.rows[0]).toMatchObject({ expanded: false, views: { list: null } });

    await page.toggleViews(shop);
    expect(page.rows[0]!.expanded).toBe(true);
    expect(page.rows[0]!.views.list?.map((entry) => [entry.name, entry.description])).toEqual([
      ['Roadmap', 'Epics of 2026, by quarter'],
      ['Triage', ''],
    ]);

    await page.toggleViews(shop);
    expect(page.rows[0]!.expanded).toBe(false);
    await page.toggleViews(shop);
    expect(calls).toEqual([`views ${shop}`]);
  });

  it('keeps the failure of the list in the section, and reads the list again on request', async () => {
    const options: FakeOptions = { views: {} };
    const { api } = fakeApi([entry('shop')], options);
    const page = new ProjectsPage(api, () => {});
    await page.load();

    await page.toggleViews(shop);
    expect(page.rows[0]!.views).toMatchObject({ loading: false, list: null, error: 'View "x" is not valid JSON' });

    options.views = views;
    await page.reloadViews(shop);
    expect(page.rows[0]!.views.error).toBeNull();
    expect(page.rows[0]!.views.list).toHaveLength(2);
  });

  it('does not expand a board that is not at its recorded place', async () => {
    const { api, calls } = fakeApi([entry('gone', { state: 'missing' })], { views });
    const page = new ProjectsPage(api, () => {});
    await page.load();
    await page.toggleViews('/work/gone/.lpm');
    expect(page.rows[0]).toMatchObject({ canListViews: false, expanded: false });
    expect(calls).toEqual([]);
  });

  it('opens the board on the view that was clicked', async () => {
    const { api } = fakeApi([entry('shop')], { views });
    const visited: string[] = [];
    const page = new ProjectsPage(api, (url) => visited.push(url));
    await page.load();
    await page.openView(shop, 'roadmap');
    expect(visited).toEqual(['http://127.0.0.1:4573/#/view/roadmap']);
  });

  it('builds the address of a view from a server address with or without a slash', () => {
    expect(viewUrl('http://127.0.0.1:4573/', 'q3 plan')).toBe('http://127.0.0.1:4573/#/view/q3%20plan');
    expect(viewUrl('http://127.0.0.1:4573', 'roadmap')).toBe('http://127.0.0.1:4573/#/view/roadmap');
  });
});

describe('the File menu', () => {
  it('holds the entry "All projects…"', () => {
    const context = {
      tabs: { active: null, views: [], open: [], name: () => '' },
      shell: {},
      workspace: { ready: true, failed: false },
    } as unknown as ViewContext;
    const labels = fileMenu(context).map((item) => ('label' in item ? item.label : null));
    expect(labels).toContain('All projects…');
  });

  it('goes to /projects on the same server', () => {
    const visited: string[] = [];
    goToProjects((url) => visited.push(url));
    expect(PROJECTS_PATH).toBe('/projects');
    expect(visited).toEqual(['/projects']);
  });
});
