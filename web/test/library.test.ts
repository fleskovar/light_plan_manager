import { describe, expect, it } from 'vitest';
import type { LibraryDocDto, LibraryDocPatch, LibraryEntryDto, LibraryMoveResultDto } from '$shared';
import { LibraryBrowser, matchesSearch, type LibraryApi } from '$features/library/library.svelte.js';
import { ancestorsOf, buildLibraryTree, dropTarget, visibleRows, type TreeRow } from '$features/library/tree.js';
import { libraryHash, parseRoute } from '$lib/app/router.svelte.js';
import { renderMarkdown } from '$lib/ui/markdown.js';

/**
 * The Library page against a fake server. The fake keeps the documents and
 * the folders in memory, gives each write a new revision, answers 409 for a
 * stale revision, and moves a folder with everything inside it, as the
 * library routes do.
 */
class HttpFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);
const parent = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

function fakeServer(seed: Partial<LibraryDocDto>[] = [], seedFolders: string[] = []) {
  let counter = 0;
  const docs = new Map<string, LibraryDocDto>();
  const folders = new Set<string>();
  const addFolders = (path: string): void => {
    for (let at = path; at; at = parent(at)) folders.add(at);
  };
  const make = (input: Partial<LibraryDocDto> & { id: string }): LibraryDocDto => ({
    title: input.id,
    description: '',
    path: `.lpm/library/${input.id}.md`,
    updated: '2026-10-25T10:00:00.000Z',
    body: '',
    referencedBy: [],
    ...input,
    revision: `r${++counter}`,
  });
  const put = (doc: LibraryDocDto): void => {
    docs.set(doc.id, doc);
    addFolders(parent(doc.id));
  };
  for (const doc of seed) put(make(doc as LibraryDocDto));
  for (const folder of seedFolders) addFolders(folder);
  const updates: { id: string; patch: LibraryDocPatch }[] = [];
  const entry = ({ body: _body, revision: _revision, referencedBy: _refs, ...rest }: LibraryDocDto): LibraryEntryDto => rest;

  const api: LibraryApi = {
    list: async () => ({
      documents: [...docs.values()].map(entry).sort((a, b) => a.id.localeCompare(b.id)),
      folders: [...folders].sort(),
    }),
    get: async (id) => {
      const doc = docs.get(id);
      if (!doc) throw new HttpFailure(`The library has no document "${id}"`, 404);
      return doc;
    },
    create: async (input) => {
      if (docs.has(input.id)) throw new HttpFailure('exists', 400);
      const doc = make({ ...input, title: input.title ?? input.id });
      put(doc);
      return doc;
    },
    update: async (id, patch) => {
      updates.push({ id, patch });
      const doc = docs.get(id)!;
      if (patch.revision !== doc.revision) throw new HttpFailure('The library document changed on disk', 409);
      const { revision: _revision, ...fields } = patch;
      const next = make({ ...doc, ...fields });
      docs.set(id, next);
      return next;
    },
    remove: async (id) => {
      const doc = docs.get(id)!;
      docs.delete(id);
      return { deleted: id, referencedBy: doc.referencedBy };
    },
    move: async (id, to): Promise<LibraryMoveResultDto> => {
      if (docs.has(id)) {
        const doc = docs.get(id)!;
        docs.delete(id);
        put({ ...doc, id: to, path: `.lpm/library/${to}.md` });
        return { kind: 'document', moved: [{ from: id, to }], rewritten: doc.referencedBy, stale: [] };
      }
      const moved: { from: string; to: string }[] = [];
      for (const doc of [...docs.values()].filter((candidate) => within(candidate.id, id))) {
        const next = to + doc.id.slice(id.length);
        docs.delete(doc.id);
        put({ ...doc, id: next });
        moved.push({ from: doc.id, to: next });
      }
      for (const folder of [...folders].filter((candidate) => within(candidate, id))) {
        folders.delete(folder);
        addFolders(to + folder.slice(id.length));
      }
      return { kind: 'folder', moved, rewritten: [], stale: [] };
    },
    createFolder: async (path) => {
      addFolders(path);
      return { folder: path };
    },
    removeFolder: async (path, recursive) => {
      const removed = [...docs.keys()].filter((id) => within(id, path));
      if (removed.length && !recursive) throw new HttpFailure(`The folder "${path}" holds documents`, 400);
      for (const id of removed) docs.delete(id);
      for (const folder of [...folders].filter((candidate) => within(candidate, path))) folders.delete(folder);
      return { folder: path, removed, referencedBy: [] };
    },
  };
  /** Change a document behind the page's back, as a second window or `lpm` does. */
  const touch = (id: string, body: string): void => void docs.set(id, make({ ...docs.get(id)!, body }));
  return { api, docs, folders, updates, touch };
}

const seed = [
  { id: 'prd/payments', title: 'Payments PRD', description: 'What payments must do', body: '## Goals\n', referencedBy: ['LP-4'] },
  { id: 'prompts/code-review', title: 'Code review prompt', body: 'Check the tests.\n' },
];

/** The rows as short texts: `prd/` for a folder, `prd/payments` for a document. */
const labels = (rows: TreeRow[]): string[] => rows.map((row) => (row.kind === 'folder' ? `${row.path}/` : row.entry.id));

describe('the tree of the library', () => {
  const entry = (id: string): LibraryEntryDto => ({ id, title: id, description: '', path: '', updated: '' });
  const root = buildLibraryTree(['archive', 'prompts', 'prompts/deep'], [entry('notes'), entry('prompts/review'), entry('prompts/deep/strict')]);

  it('nests the folders and the documents, folders first, and counts the documents below each folder', () => {
    expect(root.folders.map((folder) => [folder.path, folder.count])).toEqual([
      ['archive', 0],
      ['prompts', 2],
    ]);
    expect(root.documents.map((doc) => doc.name)).toEqual(['notes']);
    expect(root.folders[1]!.folders[0]!.documents[0]!.depth).toBe(2);
  });

  it('shows the inside of the open folders only, and every folder that holds a match during a search', () => {
    expect(labels(visibleRows(root, new Set(), null))).toEqual(['archive/', 'prompts/', 'notes']);
    expect(labels(visibleRows(root, new Set(['prompts']), null))).toEqual([
      'archive/',
      'prompts/',
      'prompts/deep/',
      'prompts/review',
      'notes',
    ]);
    expect(labels(visibleRows(root, new Set(), (doc) => doc.id.includes('strict')))).toEqual([
      'prompts/',
      'prompts/deep/',
      'prompts/deep/strict',
    ]);
  });

  it('computes the path of a drop, and refuses a drop that changes nothing or puts a folder into itself', () => {
    expect(dropTarget({ kind: 'document', path: 'notes' }, 'archive')).toBe('archive/notes');
    expect(dropTarget({ kind: 'document', path: 'prompts/review' }, '')).toBe('review');
    expect(dropTarget({ kind: 'folder', path: 'prompts' }, 'archive')).toBe('archive/prompts');
    expect(dropTarget({ kind: 'document', path: 'prompts/review' }, 'prompts')).toBeNull();
    expect(dropTarget({ kind: 'folder', path: 'prompts' }, 'prompts/deep')).toBeNull();
    expect(ancestorsOf('a/b/c')).toEqual(['a', 'a/b']);
  });
});

describe('the Library page', () => {
  it('lists the documents and the folders, and opens the document it was asked for inside its open folder', async () => {
    const { api } = fakeServer(seed, ['archive']);
    const opened: (string | null)[] = [];
    const browser = new LibraryBrowser(api, { onselect: (id) => opened.push(id) });
    await browser.load('library:PRD/payments');

    expect(browser.folders).toEqual(['archive', 'prd', 'prompts']);
    expect(browser.selected).toBe('prd/payments');
    expect(browser.currentFolder).toBe('prd');
    expect(labels(browser.rows)).toEqual(['archive/', 'prd/', 'prd/payments', 'prompts/']);
    expect(opened).toEqual(['prd/payments']);
    expect(browser.doc?.body).toBe('## Goals\n');
  });

  it('says so when the document it was asked for does not exist', async () => {
    const { api } = fakeServer(seed);
    const browser = new LibraryBrowser(api);
    await browser.load('summaries/q3');
    expect(browser.error).toBe('The library has no document "summaries/q3".');
  });

  it('saves only the fields that changed, with the revision it read', async () => {
    const { api, updates, docs } = fakeServer(seed);
    const browser = new LibraryBrowser(api);
    await browser.load('prd/payments');

    browser.startEdit();
    browser.draft.text = '## Goals\n\nTake cards.\n';
    expect(browser.dirty).toBe(true);
    expect(await browser.save()).toBe(true);

    expect(updates).toEqual([{ id: 'prd/payments', patch: { revision: 'r1', body: '## Goals\n\nTake cards.\n' } }]);
    expect(docs.get('prd/payments')!.body).toBe('## Goals\n\nTake cards.\n');
    expect(browser.draft.editing).toBe(false);
    expect(browser.notice).toBe('Saved library:prd/payments.');
  });

  it('keeps the draft and offers a reload when the file changed after the read', async () => {
    const { api, touch } = fakeServer(seed);
    const browser = new LibraryBrowser(api);
    await browser.load('prd/payments');
    browser.startEdit();
    browser.draft.text = 'Mine';
    touch('prd/payments', 'Theirs');

    expect(await browser.save()).toBe(false);
    expect(browser.conflict).toBe(true);
    expect(browser.draft.text).toBe('Mine');

    await browser.reload();
    expect(browser.conflict).toBe(false);
    expect(browser.doc?.body).toBe('Theirs');
  });

  it('asks before it opens another document over unsaved changes', async () => {
    const { api } = fakeServer(seed);
    const browser = new LibraryBrowser(api);
    await browser.load('prd/payments');
    browser.startEdit();
    browser.description = 'Changed';

    await browser.select('prompts/code-review');
    expect(browser.pendingSelect).toBe('prompts/code-review');
    await browser.resolvePendingSelect(false);
    expect(browser.selected).toBe('prd/payments');

    await browser.select('prompts/code-review');
    await browser.resolvePendingSelect(true);
    expect(browser.selected).toBe('prompts/code-review');
  });

  it('adds a document in the current folder and opens the editor on it', async () => {
    const { api } = fakeServer(seed);
    const browser = new LibraryBrowser(api);
    await browser.load();

    browser.selectFolder('prompts');
    browser.openCreate();
    expect(browser.creating?.id).toBe('prompts/');
    browser.creating!.id = 'prompts/code-review';
    expect(browser.newIdProblem).toBe('The library already has a document "prompts/code-review".');
    browser.creating!.id = 'Prompts/Strict.md';
    expect(browser.newIdProblem).toBeNull();

    expect(await browser.create()).toBe(true);
    expect(browser.selected).toBe('prompts/strict');
    expect(browser.draft.editing).toBe(true);
  });

  it('creates a folder inside the current folder, and checks its name', async () => {
    const { api, folders } = fakeServer(seed);
    const browser = new LibraryBrowser(api);
    await browser.load();

    browser.selectFolder('prompts');
    browser.openCreateFolder();
    browser.creatingFolder!.name = 'Bad Name';
    expect(browser.newFolderProblem).toContain('lowercase letters');
    browser.creatingFolder!.name = 'review';
    expect(await browser.createFolder()).toBe(true);

    expect(folders.has('prompts/review')).toBe(true);
    expect(browser.currentFolder).toBe('prompts/review');
    expect(browser.expanded.has('prompts')).toBe(true);
    expect(browser.notice).toBe('Created the folder prompts/review/.');
  });

  it('moves the open document with the form, and keeps it open under its new id', async () => {
    const { api } = fakeServer(seed);
    const browser = new LibraryBrowser(api);
    await browser.load('prd/payments');

    browser.openMove({ kind: 'document', path: 'prd/payments' });
    expect(browser.moveProblem).toBe('This is the path it has now.');
    browser.moving!.to = 'prompts/code-review';
    expect(browser.moveProblem).toBe('The library already has a document "prompts/code-review".');
    browser.moving!.to = 'spec/payments';
    expect(await browser.move()).toBe(true);

    expect(browser.moving).toBeNull();
    expect(browser.selected).toBe('spec/payments');
    expect(browser.notice).toBe('Moved library:prd/payments to library:spec/payments. Rewrote the references of LP-4.');
  });

  it('moves a folder that a row was dropped onto, and follows the open document into it', async () => {
    const { api } = fakeServer(seed, ['archive']);
    const browser = new LibraryBrowser(api);
    await browser.load('prompts/code-review');

    expect(await browser.drop({ kind: 'folder', path: 'prompts' }, 'archive')).toBe(true);

    expect(browser.folders).toEqual(['archive', 'archive/prompts', 'prd']);
    expect(browser.selected).toBe('archive/prompts/code-review');
    expect(browser.currentFolder).toBe('archive/prompts');
    expect(await browser.drop({ kind: 'folder', path: 'archive' }, 'archive/prompts')).toBe(false);
  });

  it('refuses a drop onto a folder that already holds an item of that name', async () => {
    const { api } = fakeServer([...seed, { id: 'archive/payments' }]);
    const browser = new LibraryBrowser(api);
    await browser.load();
    expect(await browser.drop({ kind: 'document', path: 'prd/payments' }, 'archive')).toBe(false);
    expect(browser.error).toBe('The folder archive/ already holds "payments".');
  });

  it('refuses to move the open document while it has unsaved changes', async () => {
    const { api } = fakeServer(seed, ['archive']);
    const browser = new LibraryBrowser(api);
    await browser.load('prd/payments');
    browser.startEdit();
    browser.draft.text = 'Changed';
    expect(await browser.drop({ kind: 'document', path: 'prd/payments' }, 'archive')).toBe(false);
    expect(browser.error).toContain('unsaved changes');
  });

  it('deletes an empty folder at once, and asks before it deletes a folder with documents', async () => {
    const { api, docs } = fakeServer(seed, ['archive']);
    const browser = new LibraryBrowser(api);
    await browser.load('prd/payments');

    expect(await browser.requestRemoveFolder('archive')).toBe(true);
    expect(browser.folders).not.toContain('archive');

    expect(await browser.requestRemoveFolder('prd')).toBe(false);
    expect(browser.folderToDelete).toEqual({ path: 'prd', count: 1 });
    expect(await browser.resolveRemoveFolder(true)).toBe(true);
    expect(docs.has('prd/payments')).toBe(false);
    expect(browser.selected).toBeNull();
    expect(browser.notice).toBe('Deleted the folder prd/ and 1 document.');
  });

  it('deletes the open document and names the issues that still reference it', async () => {
    const { api } = fakeServer(seed);
    const browser = new LibraryBrowser(api);
    await browser.load('prd/payments');
    expect(await browser.remove()).toBe(true);
    expect(browser.selected).toBeNull();
    expect(browser.folders).toContain('prd');
    expect(browser.notice).toBe('Deleted library:prd/payments. LP-4 still reference it.');
  });
});

describe('search in the library', () => {
  const entry: LibraryEntryDto = { id: 'prd/payments', title: 'Payments PRD', description: 'What payments must do', path: '', updated: '' };

  it('needs every word, in the id, the title or the description', () => {
    expect(matchesSearch(entry, '')).toBe(true);
    expect(matchesSearch(entry, 'prd must')).toBe(true);
    expect(matchesSearch(entry, 'prd refunds')).toBe(false);
  });
});

describe('the address of the Library page', () => {
  it('names the open document and the view, and reads back the same values', () => {
    expect(libraryHash(null, null)).toBe('#/library');
    const hash = libraryHash('prd/payments', 'roadmap');
    expect(hash).toBe('#/library?doc=prd%2Fpayments&view=roadmap');
    expect(parseRoute(hash)).toEqual({ name: 'library', docId: 'prd/payments', viewId: 'roadmap' });
    expect(parseRoute('#/library')).toEqual({ name: 'library', docId: null, viewId: null });
  });
});

describe('library links in markdown', () => {
  it('renders [label](library:<id>) as a link when the window opens library documents', () => {
    const html = renderMarkdown('See [the **PRD**](library:PRD/payments).', { libraryLink: true });
    expect(html).toContain(
      '<a class="library-link" href="#" data-library="prd/payments" title="Library document prd/payments">the <strong>PRD</strong></a>',
    );
  });

  it('keeps the text without the option, and for an id that breaks the rule', () => {
    expect(renderMarkdown('See [the PRD](library:prd/payments).')).not.toContain('<a');
    expect(renderMarkdown('See [x](library:../secrets).', { libraryLink: true })).not.toContain('<a');
  });
});
