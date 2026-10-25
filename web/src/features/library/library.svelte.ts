import type {
  LibraryDocDto,
  LibraryDocPatch,
  LibraryEntryDto,
  LibraryFolderRemovalDto,
  LibraryListDto,
  LibraryMoveResultDto,
} from '$shared';
import { libraryRef, normalizeLibraryId } from '$shared';
import { BodyDraft } from '$features/issue/body-draft.svelte.js';
import {
  ancestorsOf,
  buildLibraryTree,
  dropTarget,
  join,
  nameOf,
  parentOf,
  visibleRows,
  within,
  type FolderNode,
  type LibraryItem,
  type TreeRow,
} from './tree.js';

/**
 * The Library page: the folders and the documents of `.lpm/library/`, one
 * document open, and its editor.
 *
 * The tree on the left comes from `GET /api/library`, which sends every folder
 * and every document. A click on a document reads it with its body
 * (`GET /api/library/:id`). The editor is the editor of the issue window:
 * `BodyDraft` holds the markdown while the reader writes, and the page shows
 * it as source (Write) or rendered (Preview).
 *
 * The page manages the folder structure too. **New folder** creates a folder
 * in the current folder. **Move** gives a document or a folder a new path,
 * and a drag of a row onto a folder does the same. The server renames the file
 * or the folder and rewrites the `library:` references of the issues and
 * templates. **Delete** on a folder that holds documents asks first, and then
 * deletes the documents too.
 *
 * Save sends the revision that the page read. When the file changed on disk
 * after the read, the server answers 409, the draft stays, and `conflict` is
 * true until the reader reloads the document.
 *
 * The logic is here and `LibraryPage.svelte` only draws it, so the tests in
 * `web/test/library.test.ts` need no browser.
 */
export interface LibraryApi {
  list(): Promise<LibraryListDto>;
  get(id: string): Promise<LibraryDocDto>;
  create(input: { id: string; title?: string; description?: string; body?: string }): Promise<LibraryDocDto>;
  update(id: string, patch: LibraryDocPatch): Promise<LibraryDocDto>;
  remove(id: string): Promise<{ deleted: string; referencedBy: string[] }>;
  move(id: string, to: string): Promise<LibraryMoveResultDto>;
  createFolder(path: string): Promise<{ folder: string }>;
  removeFolder(path: string, recursive: boolean): Promise<LibraryFolderRemovalDto>;
}

export interface LibraryBrowserOptions {
  /** Called with the id of each document the page opens, and with null when none is open. */
  onselect?: (id: string | null) => void;
}

/** The form that adds a document. */
export interface NewDocForm {
  id: string;
  title: string;
  description: string;
}

/** The form that adds a folder inside `parent`. */
export interface NewFolderForm {
  parent: string;
  name: string;
}

/** The form that gives `item` the new path `to`. */
export interface MoveForm {
  item: LibraryItem;
  to: string;
}

const ID_RULE = 'Use lowercase letters, digits, "-", "_" and ".", with "/" between folders.';

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
  folders = $state.raw<string[]>([]);
  loading = $state(true);
  /** The message of the last failure, or null. The next action clears it. */
  error = $state<string | null>(null);
  /** A line that says what the last action did, or null. */
  notice = $state<string | null>(null);
  search = $state('');

  /** The folders whose contents the tree shows. */
  expanded = $state.raw<ReadonlySet<string>>(new Set());
  /**
   * The folder that New document and New folder put the new item in. An
   * empty text names the library folder itself. A click on a folder sets it,
   * and so does opening a document.
   */
  currentFolder = $state('');

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
  /** True while the page asks whether to delete the open document. */
  confirmingDelete = $state(false);
  /** The folder that the page asks about before it deletes it with its documents, or null. */
  folderToDelete = $state<{ path: string; count: number } | null>(null);

  creating = $state<NewDocForm | null>(null);
  creatingFolder = $state<NewFolderForm | null>(null);
  moving = $state<MoveForm | null>(null);

  readonly #api: LibraryApi;
  readonly #onselect: (id: string | null) => void;

  constructor(api: LibraryApi, options: LibraryBrowserOptions = {}) {
    this.#api = api;
    this.#onselect = options.onselect ?? (() => {});
  }

  tree = $derived.by<FolderNode>(() => buildLibraryTree(this.folders, this.entries));

  /** The rows of the tree, as the page draws them. A search opens every folder that holds a match. */
  rows = $derived.by<TreeRow[]>(() => {
    const search = this.search.trim();
    return visibleRows(this.tree, this.expanded, search ? (entry) => matchesSearch(entry, search) : null);
  });

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
    return this.creating ? this.#docIdProblem(this.creating.id) : null;
  }

  /** The problem of the name in the new-folder form, or null when the folder can be created. */
  get newFolderProblem(): string | null {
    const form = this.creatingFolder;
    if (!form || !form.name.trim()) return null;
    const path = normalizeLibraryId(join(form.parent, form.name.trim()));
    if (path === null) return ID_RULE;
    if (this.folders.includes(path)) return `The library already has a folder "${path}".`;
    return null;
  }

  /** The problem of the path in the move form, or null when the move can run. */
  get moveProblem(): string | null {
    const form = this.moving;
    if (!form || !form.to.trim()) return null;
    const to = normalizeLibraryId(form.to);
    if (to === null) return ID_RULE;
    if (to === form.item.path) return 'This is the path it has now.';
    if (form.item.kind === 'folder') {
      if (within(to, form.item.path)) return 'A folder cannot move into itself.';
      if (this.folders.includes(to)) return `The library already has a folder "${to}".`;
      return null;
    }
    return this.entries.some((entry) => entry.id === to) ? `The library already has a document "${to}".` : null;
  }

  #docIdProblem(raw: string): string | null {
    if (!raw.trim()) return null;
    const id = normalizeLibraryId(raw);
    if (id === null) return ID_RULE;
    if (this.entries.some((entry) => entry.id === id)) return `The library already has a document "${id}".`;
    return null;
  }

  /** Read the tree, then open `initial` when it is given. */
  async load(initial: string | null = null): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      await this.#readList();
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      this.loading = false;
    }
    const id = initial === null ? null : normalizeLibraryId(initial);
    if (id !== null) await this.#open(id);
    else if (initial !== null) this.error = `"${initial}" is not a valid library id.`;
  }

  async #readList(): Promise<void> {
    const list = await this.#api.list();
    this.entries = list.documents;
    this.folders = list.folders;
  }

  // -- The tree ----------------------------------------------------------------

  toggleFolder(path: string): void {
    const next = new Set(this.expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this.expanded = next;
  }

  /** Make `path` the current folder, and open it in the tree. */
  selectFolder(path: string): void {
    this.currentFolder = path;
    if (path) this.#expand([...ancestorsOf(path), path]);
  }

  #expand(paths: string[]): void {
    if (paths.every((path) => this.expanded.has(path))) return;
    this.expanded = new Set([...this.expanded, ...paths]);
  }

  // -- Documents ---------------------------------------------------------------

  /** Open a document. With unsaved changes, the page asks first (`pendingSelect`). */
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
    this.error = null;
    this.reading = true;
    this.currentFolder = parentOf(id);
    this.#expand(ancestorsOf(id));
    this.#onselect(id);
    try {
      this.doc = await this.#api.get(id);
    } catch (error) {
      this.error = statusOf(error) === 404 ? `The library has no document "${id}".` : messageOf(error);
    } finally {
      this.reading = false;
    }
  }

  #close(): void {
    this.selected = null;
    this.doc = null;
    this.draft.discard();
    this.confirmingDelete = false;
    this.#onselect(null);
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
    return this.#run(async () => {
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
      } catch (error) {
        this.conflict = statusOf(error) === 409;
        throw error;
      }
    });
  }

  /** Drop the draft and read the open document again, after a conflict. */
  async reload(): Promise<void> {
    if (this.selected === null) return;
    this.draft.discard();
    await this.#open(this.selected);
  }

  /** Open the form that adds a document in the current folder. */
  openCreate(): void {
    this.creating = { id: this.currentFolder ? `${this.currentFolder}/` : '', title: '', description: '' };
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
    return this.#run(async () => {
      const doc = await this.#api.create({
        id,
        title: form.title.trim() || undefined,
        description: form.description.trim() || undefined,
      });
      this.creating = null;
      this.search = '';
      await this.#readList();
      await this.#open(doc.id);
      this.startEdit();
      this.notice = `Added ${libraryRef(doc.id)}.`;
    });
  }

  /** Delete the open document. The page asks first (`confirmingDelete`). */
  async remove(): Promise<boolean> {
    const doc = this.doc;
    if (!doc || this.busy) return false;
    return this.#run(async () => {
      const result = await this.#api.remove(doc.id);
      await this.#readList();
      this.#close();
      this.notice = result.referencedBy.length
        ? `Deleted ${libraryRef(doc.id)}. ${result.referencedBy.join(', ')} still reference it.`
        : `Deleted ${libraryRef(doc.id)}.`;
    });
  }

  // -- Folders -----------------------------------------------------------------

  /** Open the form that adds a folder inside `parent`, the current folder by default. */
  openCreateFolder(parent: string = this.currentFolder): void {
    this.creatingFolder = { parent, name: '' };
    this.error = null;
  }

  closeCreateFolder(): void {
    this.creatingFolder = null;
  }

  async createFolder(): Promise<boolean> {
    const form = this.creatingFolder;
    const path = form ? normalizeLibraryId(join(form.parent, form.name.trim())) : null;
    if (!form || path === null || this.newFolderProblem || this.busy) return false;
    return this.#run(async () => {
      const { folder } = await this.#api.createFolder(path);
      this.creatingFolder = null;
      await this.#readList();
      this.selectFolder(folder);
      this.notice = `Created the folder ${folder}/.`;
    });
  }

  /**
   * Ask before deleting a folder. An empty folder goes at once. A folder that
   * holds documents sets `folderToDelete`, and `removeFolder` deletes it with
   * its documents.
   */
  async requestRemoveFolder(path: string): Promise<boolean> {
    const count = this.entries.filter((entry) => within(entry.id, path)).length;
    if (count) {
      this.folderToDelete = { path, count };
      return false;
    }
    return this.#removeFolder(path, false);
  }

  /** Answer the question of `folderToDelete`. */
  async resolveRemoveFolder(confirmed: boolean): Promise<boolean> {
    const target = this.folderToDelete;
    this.folderToDelete = null;
    return confirmed && target ? this.#removeFolder(target.path, true) : false;
  }

  async #removeFolder(path: string, recursive: boolean): Promise<boolean> {
    if (recursive && this.selected !== null && within(this.selected, path) && this.dirty) {
      this.error = 'The open document is inside this folder and has unsaved changes. Save or cancel them first.';
      return false;
    }
    return this.#run(async () => {
      const result = await this.#api.removeFolder(path, recursive);
      await this.#readList();
      if (this.selected !== null && within(this.selected, path)) this.#close();
      if (within(this.currentFolder, path)) this.currentFolder = parentOf(path);
      const removed = result.removed.length ? ` and ${result.removed.length} document${result.removed.length === 1 ? '' : 's'}` : '';
      const stale = result.referencedBy.length ? ` ${result.referencedBy.join(', ')} still reference them.` : '';
      this.notice = `Deleted the folder ${path}/${removed}.${stale}`;
    });
  }

  // -- Moving ------------------------------------------------------------------

  /** Open the form that gives `item` a new path. */
  openMove(item: LibraryItem): void {
    this.moving = { item, to: item.path };
    this.error = null;
  }

  closeMove(): void {
    this.moving = null;
  }

  /** Run the move of the form. */
  async move(): Promise<boolean> {
    const form = this.moving;
    const to = form ? normalizeLibraryId(form.to) : null;
    if (!form || to === null || this.moveProblem || this.busy) return false;
    const done = await this.moveItem(form.item, to);
    if (done) this.moving = null;
    return done;
  }

  /** Move a row that the reader dropped onto `folder`. A drop that changes nothing does nothing. */
  async drop(item: LibraryItem, folder: string): Promise<boolean> {
    const to = dropTarget(item, folder);
    if (to === null) return false;
    const taken = item.kind === 'folder' ? this.folders.includes(to) : this.entries.some((entry) => entry.id === to);
    if (taken) {
      this.error = `${folder ? `The folder ${folder}/` : 'The library'} already holds "${nameOf(to)}".`;
      return false;
    }
    return this.moveItem(item, to);
  }

  /**
   * Give a document or a folder the path `to`. The server rewrites the
   * references to every document that moved. The open document stays open
   * under its new id.
   */
  async moveItem(item: LibraryItem, to: string): Promise<boolean> {
    if (this.selected !== null && within(this.selected, item.path) && this.dirty) {
      this.error = 'The open document has unsaved changes. Save or cancel them before you move it.';
      return false;
    }
    return this.#run(async () => {
      const result = await this.#api.move(item.path, to);
      await this.#readList();
      const opened = this.selected;
      const next = opened === null ? undefined : result.moved.find((entry) => entry.from === opened)?.to;
      if (next !== undefined) await this.#open(next);
      if (item.kind === 'folder') {
        if (within(this.currentFolder, item.path)) this.currentFolder = to + this.currentFolder.slice(item.path.length);
        this.#expand([...ancestorsOf(to), to]);
      } else {
        this.#expand(ancestorsOf(to));
      }
      const what = item.kind === 'folder' ? `the folder ${item.path}/ to ${to}/` : `${libraryRef(item.path)} to ${libraryRef(to)}`;
      const rewritten = result.rewritten.length ? ` Rewrote the references of ${result.rewritten.join(', ')}.` : '';
      this.notice = `Moved ${what}.${rewritten}`;
    });
  }

  // -- Helpers -----------------------------------------------------------------

  /** Run a write. A failure goes to `error`, and the method returns false. */
  async #run(action: () => Promise<void>): Promise<boolean> {
    this.busy = true;
    this.error = null;
    this.notice = null;
    try {
      await action();
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
