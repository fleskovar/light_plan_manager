import { describe, expect, it } from 'vitest';
import type { LibraryDocDto, LibraryDocPatch, LibraryEntryDto } from '$shared';
import { LibraryBrowser, matchesSearch, type LibraryApi } from '$features/library/library.svelte.js';
import { renderMarkdown } from '$lib/ui/markdown.js';

/**
 * The Library dialog against a fake server. The fake keeps the documents in a
 * map, gives each write a new revision, and answers 409 for a stale revision,
 * as `PUT /api/library/:id` does.
 */
class HttpFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function fakeServer(seed: Partial<LibraryDocDto>[] = []) {
  let counter = 0;
  const docs = new Map<string, LibraryDocDto>();
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
  for (const doc of seed) docs.set(doc.id!, make(doc as LibraryDocDto));
  const updates: { id: string; patch: LibraryDocPatch }[] = [];
  const entry = ({ body: _body, revision: _revision, referencedBy: _refs, ...rest }: LibraryDocDto): LibraryEntryDto => rest;

  const api: LibraryApi = {
    list: async () => [...docs.values()].map(entry).sort((a, b) => a.id.localeCompare(b.id)),
    get: async (id) => {
      const doc = docs.get(id);
      if (!doc) throw new HttpFailure(`The library has no document "${id}"`, 404);
      return doc;
    },
    create: async (input) => {
      if (docs.has(input.id)) throw new HttpFailure('exists', 400);
      const doc = make({ ...input, title: input.title ?? input.id });
      docs.set(doc.id, doc);
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
    move: async (id, to) => {
      const doc = docs.get(id)!;
      docs.delete(id);
      docs.set(to, { ...doc, id: to, path: `.lpm/library/${to}.md` });
      return { moved: [{ from: id, to }], rewritten: doc.referencedBy, stale: [] };
    },
  };
  /** Change a document behind the dialog's back, as a second window or `lpm` does. */
  const touch = (id: string, body: string): void => void docs.set(id, make({ ...docs.get(id)!, body }));
  return { api, docs, updates, touch };
}

const seed = [
  { id: 'prd/payments', title: 'Payments PRD', description: 'What payments must do', body: '## Goals\n', referencedBy: ['LP-4'] },
  { id: 'prompts/code-review', title: 'Code review prompt', body: 'Check the tests.\n' },
];

describe('the Library dialog', () => {
  it('lists the documents, filters them, and opens the one it was asked for', async () => {
    const { api } = fakeServer(seed);
    const browser = new LibraryBrowser(api);
    await browser.load('library:PRD/payments');

    expect(browser.entries.map((entry) => entry.id)).toEqual(['prd/payments', 'prompts/code-review']);
    expect(browser.selected).toBe('prd/payments');
    expect(browser.doc?.body).toBe('## Goals\n');
    expect(browser.ref).toBe('library:prd/payments');

    browser.search = 'review';
    expect(browser.visible.map((entry) => entry.id)).toEqual(['prompts/code-review']);
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
    expect(browser.draft.editing).toBe(false);
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
    expect(browser.selected).toBe('prd/payments');

    await browser.resolvePendingSelect(false);
    expect(browser.selected).toBe('prd/payments');
    expect(browser.description).toBe('Changed');

    await browser.select('prompts/code-review');
    await browser.resolvePendingSelect(true);
    expect(browser.selected).toBe('prompts/code-review');
    expect(browser.dirty).toBe(false);
  });

  it('checks the id of a new document, adds it and opens the editor on it', async () => {
    const { api } = fakeServer(seed);
    const browser = new LibraryBrowser(api);
    await browser.load();

    browser.openCreate();
    browser.creating!.id = 'Bad Name';
    expect(browser.newIdProblem).toContain('lowercase letters');
    browser.creating!.id = 'prd/payments';
    expect(browser.newIdProblem).toBe('The library already has a document "prd/payments".');
    browser.creating!.id = 'Summaries/Q3.md';
    browser.creating!.title = 'Q3 summary';
    expect(browser.newIdProblem).toBeNull();

    expect(await browser.create()).toBe(true);
    expect(browser.selected).toBe('summaries/q3');
    expect(browser.draft.editing).toBe(true);
    expect(browser.entries.map((entry) => entry.id)).toEqual(['prd/payments', 'prompts/code-review', 'summaries/q3']);
  });

  it('renames the open document, checks the new id, and opens the document under it', async () => {
    const { api, docs } = fakeServer(seed);
    const browser = new LibraryBrowser(api);
    await browser.load('prd/payments');

    browser.openRename();
    expect(browser.renaming).toBe('prd/payments');
    expect(browser.renameProblem).toBe('The document already has this id.');
    browser.renaming = 'prompts/code-review';
    expect(browser.renameProblem).toBe('The library already has a document "prompts/code-review".');
    browser.renaming = 'Spec/Payments';
    expect(browser.renameProblem).toBeNull();

    expect(await browser.rename()).toBe(true);
    expect(browser.renaming).toBeNull();
    expect(browser.selected).toBe('spec/payments');
    expect(browser.doc?.body).toBe('## Goals\n');
    expect([...docs.keys()].sort()).toEqual(['prompts/code-review', 'spec/payments']);
    expect(browser.notice).toBe('Renamed to library:spec/payments. Rewrote the references of LP-4.');
  });

  it('opens no rename form while the editor is open', async () => {
    const { api } = fakeServer(seed);
    const browser = new LibraryBrowser(api);
    await browser.load('prd/payments');
    browser.startEdit();
    browser.openRename();
    expect(browser.renaming).toBeNull();
  });

  it('deletes the open document and names the issues that still reference it', async () => {
    const { api } = fakeServer(seed);
    const browser = new LibraryBrowser(api);
    await browser.load('prd/payments');
    expect(await browser.remove()).toBe(true);
    expect(browser.selected).toBeNull();
    expect(browser.entries.map((entry) => entry.id)).toEqual(['prompts/code-review']);
    expect(browser.notice).toBe('Deleted library:prd/payments. LP-4 still reference it.');
  });
});

describe('search in the library', () => {
  const entry: LibraryEntryDto = {
    id: 'prd/payments',
    title: 'Payments PRD',
    description: 'What payments must do',
    path: '',
    updated: '',
  };

  it('needs every word, in the id, the title or the description', () => {
    expect(matchesSearch(entry, '')).toBe(true);
    expect(matchesSearch(entry, 'prd must')).toBe(true);
    expect(matchesSearch(entry, 'prd refunds')).toBe(false);
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
