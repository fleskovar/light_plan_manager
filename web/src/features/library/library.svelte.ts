import type { LibraryDocDto, LibraryDocPatch, LibraryEntryDto, LibraryMoveResultDto } from '$shared';
import { libraryRef, normalizeLibraryId } from '$shared';
import { BodyDraft } from '$features/issue/body-draft.svelte.js';

/**
 * The Library dialog: the documents in `.lpm/library/`, one of them open, and
 * its editor.
 *
 * The list on the left comes from `GET /api/library`. A click on an entry reads
 * the document with its body (`GET /api/library/:id`). The editor is the editor
 * of the issue window: `BodyDraft` holds the markdown while the reader writes,
 * and the dialog shows it as source (Write) or rendered (Preview). Edit also
 * opens the title and the description for editing.
 *
 * Save sends the revision that the dialog read. When the file changed on disk
 * after the read, the server answers 409, the draft stays, and `conflict` is
 * true until the reader reloads the document.
 *
 * Rename gives the open document a new id. The server renames the file and
 * rewrites the `library:` references of the issues and templates, so the
 * board shows the new id after its next pull.
 *
 * The logic is here and `LibraryDialog.svelte` only draws it, so the tests in
 * `web/test/library.test.ts` need no browser.
 */
export interface LibraryApi {
  list(): Promise<LibraryEntryDto[]>;
  get(id: string): Promise<LibraryDocDto>;
  create(input: { id: string; title?: string; description?: string; body?: string }): Promise<LibraryDocDto>;
  update(id: string, patch: LibraryDocPatch): Promise<LibraryDocDto>;
  remove(id: string): Promise<{ deleted: string; referencedBy: string[] }>;
  move(id: string, to: string): Promise<LibraryMoveResultDto>;
}

/** The form that adds a document. */
export interface NewDocForm {
  id: string;
  title: string;
  description: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/** True when `entry` holds every word of `search`, in its id, title or description. */
export function matchesSearch(entry: LibraryEntryDto, search: string): boolean {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${entry.id} ${entry.title} ${entry.description}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

export class LibraryBrowser {
  /** Replaced as a whole on each load, so it is not a deep proxy. */
  entries = $state.raw<LibraryEntryDto[]>([]);
  loading = $state(true);
  /** The message of the last failure, or null. The next action clears it. */
  error = $state<string | null>(null);
  /** A line that says what the last action did, or null. */
  notice = $state<string | null>(null);
  search = $state('');

  /** The id of the open document, or null. */
  selected = $state<string | null>(null);
  /** The open document as the server sent it. */
  doc = $state.raw<LibraryDocDto | null>(null);
  /** True while the request for the open document runs. */
  reading = $state(false);
  busy = $state(false);

  /** The body editor. Its `editing` is the edit mode of the whole document. */
  readonly draft = new BodyDraft();
  title = $state('');
  description = $state('');
  /** True after a save failed because the file changed on disk. */
  conflict = $state(false);

  /** The id that the reader asked to open while the draft held changes. */
  pendingSelect = $state<string | null>(null);
  /** True while the dialog asks whether to delete the open document. */
  confirmingDelete = $state(false);
  /** The form that adds a document, or null while it is closed. */
  creating = $state<NewDocForm | null>(null);
  /** The new id that the rename form holds, or null while the form is closed. */
  renaming = $state<string | null>(null);

  readonly #api: LibraryApi;

  constructor(api: LibraryApi) {
    this.#api = api;
  }

  visible = $derived.by<LibraryEntryDto[]>(() => this.entries.filter((entry) => matchesSearch(entry, this.search)));

  /** True when the editor holds a change that no save wrote. */
  get dirty(): boolean {
    if (!this.draft.editing || !this.doc) return false;
    return this.draft.dirty || this.title.trim() !== this.doc.title || this.description.trim() !== this.doc.description;
  }

  /** The reference text of the open document, for example `library:prd/payments`. */
  get ref(): string | null {
    return this.selected === null ? null : libraryRef(this.selected);
  }

  /** The problem of the id in the new-document form, or null when the id is valid and free. */
  get newIdProblem(): string | null {
    return this.creating ? this.#idProblem(this.creating.id) : null;
  }

  /** The problem of the id in the rename form, or null when the id is valid, free and new. */
  get renameProblem(): string | null {
    if (this.renaming === null) return null;
    if (normalizeLibraryId(this.renaming) === this.selected) return 'The document already has this id.';
    return this.#idProblem(this.renaming);
  }

  #idProblem(raw: string): string | null {
    if (!raw.trim()) return null;
    const id = normalizeLibraryId(raw);
    if (id === null) return 'Use lowercase letters, digits, "-", "_" and ".", with "/" between folders.';
    if (this.entries.some((entry) => entry.id === id)) return `The library already has a document "${id}".`;
    return null;
  }

  /** Read the list, then open `initial` when it is given. */
  async load(initial: string | null = null): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      this.entries = await this.#api.list();
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      this.loading = false;
    }
    const id = initial === null ? null : normalizeLibraryId(initial);
    if (id !== null) await this.#open(id);
    else if (initial !== null) this.error = `"${initial}" is not a valid library id.`;
  }

  /** Open a document. With unsaved changes, the dialog asks first (`pendingSelect`). */
  async select(id: string): Promise<void> {
    if (id === this.selected) return;
    if (this.dirty) {
      this.pendingSelect = id;
      return;
    }
    await this.#open(id);
  }

  /** Answer the question of `pendingSelect`. `discard` drops the changes and opens the document. */
  async resolvePendingSelect(discard: boolean): Promise<void> {
    const id = this.pendingSelect;
    this.pendingSelect = null;
    if (discard && id !== null) {
      this.draft.discard();
      await this.#open(id);
    }
  }

  async #open(id: string): Promise<void> {
    this.selected = id;
    this.doc = null;
    this.draft.discard();
    this.conflict = false;
    this.confirmingDelete = false;
    this.renaming = null;
    this.error = null;
    this.notice = null;
    this.reading = true;
    try {
      this.doc = await this.#api.get(id);
    } catch (error) {
      this.error = statusOf(error) === 404 ? `The library has no document "${id}".` : messageOf(error);
    } finally {
      this.reading = false;
    }
  }

  /** Open the editor on the open document. */
  startEdit(): void {
    if (!this.doc) return;
    this.title = this.doc.title;
    this.description = this.doc.description;
    this.draft.open(this.doc.body);
  }

  cancelEdit(): void {
    this.draft.discard();
    this.conflict = false;
  }

  /**
   * Write the changes. `close` closes the editor after a save that worked.
   * A field that the reader did not change is not sent, so a title that comes
   * from the first heading stays out of the frontmatter.
   */
  async save(close = true): Promise<boolean> {
    const doc = this.doc;
    if (!doc || !this.draft.editing || this.busy) return false;
    const patch: LibraryDocPatch = { revision: doc.revision };
    const title = this.title.trim();
    const description = this.description.trim();
    if (title !== doc.title) patch.title = title;
    if (description !== doc.description) patch.description = description;
    if (this.draft.text !== doc.body) patch.body = this.draft.text;
    if (Object.keys(patch).length === 1) {
      if (close) this.draft.discard();
      return true;
    }
    this.busy = true;
    this.error = null;
    try {
      const saved = await this.#api.update(doc.id, patch);
      this.doc = saved;
      this.draft.commit(close);
      if (!close) {
        this.title = saved.title;
        this.description = saved.description;
      }
      this.conflict = false;
      this.notice = `Saved ${libraryRef(saved.id)}.`;
      this.#replaceEntry(saved);
      return true;
    } catch (error) {
      this.conflict = statusOf(error) === 409;
      this.error = messageOf(error);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Drop the draft and read the open document again, after a conflict. */
  async reload(): Promise<void> {
    if (this.selected === null) return;
    this.draft.discard();
    await this.#open(this.selected);
  }

  openCreate(): void {
    this.creating = { id: '', title: '', description: '' };
    this.error = null;
  }

  closeCreate(): void {
    this.creating = null;
  }

  /** Add the document of the form, open it and start the editor. */
  async create(): Promise<boolean> {
    const form = this.creating;
    const id = form ? normalizeLibraryId(form.id) : null;
    if (!form || id === null || this.newIdProblem || this.busy) return false;
    this.busy = true;
    this.error = null;
    try {
      const doc = await this.#api.create({
        id,
        title: form.title.trim() || undefined,
        description: form.description.trim() || undefined,
      });
      this.creating = null;
      this.entries = [...this.entries, doc].sort((a, b) => a.id.localeCompare(b.id));
      this.search = '';
      this.selected = doc.id;
      this.doc = doc;
      this.draft.discard();
      this.startEdit();
      this.notice = `Added ${libraryRef(doc.id)}.`;
      return true;
    } catch (error) {
      this.error = messageOf(error);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Open the rename form on the id of the open document. */
  openRename(): void {
    if (this.selected !== null && !this.draft.editing) this.renaming = this.selected;
  }

  closeRename(): void {
    this.renaming = null;
  }

  /** Give the open document the id of the rename form, then open it under that id. */
  async rename(): Promise<boolean> {
    const from = this.selected;
    const to = this.renaming === null ? null : normalizeLibraryId(this.renaming);
    if (from === null || to === null || this.renameProblem || this.busy) return false;
    this.busy = true;
    this.error = null;
    try {
      const result = await this.#api.move(from, to);
      this.renaming = null;
      this.entries = await this.#api.list();
      await this.#open(to);
      this.notice = result.rewritten.length
        ? `Renamed to ${libraryRef(to)}. Rewrote the references of ${result.rewritten.join(', ')}.`
        : `Renamed to ${libraryRef(to)}.`;
      return true;
    } catch (error) {
      this.error = messageOf(error);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Delete the open document. The dialog asks first (`confirmingDelete`). */
  async remove(): Promise<boolean> {
    const doc = this.doc;
    if (!doc || this.busy) return false;
    this.busy = true;
    this.error = null;
    try {
      const result = await this.#api.remove(doc.id);
      this.entries = this.entries.filter((entry) => entry.id !== doc.id);
      this.selected = null;
      this.doc = null;
      this.draft.discard();
      this.confirmingDelete = false;
      this.notice = result.referencedBy.length
        ? `Deleted ${libraryRef(doc.id)}. ${result.referencedBy.join(', ')} still reference it.`
        : `Deleted ${libraryRef(doc.id)}.`;
      return true;
    } catch (error) {
      this.error = messageOf(error);
      return false;
    } finally {
      this.busy = false;
    }
  }

  #replaceEntry(doc: LibraryDocDto): void {
    const entry: LibraryEntryDto = {
      id: doc.id,
      title: doc.title,
      description: doc.description,
      path: doc.path,
      updated: doc.updated,
    };
    this.entries = this.entries.map((existing) => (existing.id === doc.id ? entry : existing));
  }
}
