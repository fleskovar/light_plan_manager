<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import ContextMenu from '$lib/ui/menu/ContextMenu.svelte';
  import type { MenuAnchor, MenuEntry } from '$lib/ui/menu/types.js';
  import type { LibraryBrowser } from './library.svelte.js';
  import { dropTarget, parentOf, type LibraryItem, type TreeRow } from './tree.js';

  /**
   * The left side of the Library page: the folder tree, and the forms that
   * add a document, add a folder and move an item.
   *
   * A click on a folder makes it the current folder, where New document and
   * New folder put the new item. The arrow before a folder opens or closes it.
   * A row can be dragged onto a folder, or onto the row "Library" for the top
   * level, to move it there. A right-click on a row shows every action for it.
   */
  interface Props {
    browser: LibraryBrowser;
  }

  let { browser }: Props = $props();

  /** The MIME type of a dragged row. A drag from outside the page carries none, and no drop takes it. */
  const DRAG_TYPE = 'application/x-lpm-library-item';

  let dragged = $state<LibraryItem | null>(null);
  /** The folder under the pointer during a drag, or null. An empty text is the top level. */
  let dropFolder = $state<string | null>(null);
  let menu = $state<{ anchor: MenuAnchor; entries: MenuEntry[] } | null>(null);

  const itemOf = (row: TreeRow): LibraryItem =>
    row.kind === 'folder' ? { kind: 'folder', path: row.path } : { kind: 'document', path: row.entry.id };

  /** The folder that a drop onto `row` puts the item in: the folder itself, or the folder of a document. */
  const folderOf = (row: TreeRow | null): string => (row === null ? '' : row.kind === 'folder' ? row.path : parentOf(row.entry.id));

  function ondragstart(event: DragEvent, row: TreeRow): void {
    const item = itemOf(row);
    dragged = item;
    event.dataTransfer?.setData(DRAG_TYPE, JSON.stringify(item));
    event.dataTransfer?.setData('text/plain', item.kind === 'document' ? `library:${item.path}` : `${item.path}/`);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function ondragover(event: DragEvent, row: TreeRow | null): void {
    if (!dragged) return;
    const folder = folderOf(row);
    if (dropTarget(dragged, folder) === null) {
      dropFolder = null;
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dropFolder = folder;
  }

  function ondrop(event: DragEvent, row: TreeRow | null): void {
    event.preventDefault();
    const item = dragged;
    const folder = folderOf(row);
    dragged = null;
    dropFolder = null;
    if (item) void browser.drop(item, folder);
  }

  function ondragend(): void {
    dragged = null;
    dropFolder = null;
  }

  function onrowclick(row: TreeRow): void {
    if (row.kind === 'folder') browser.selectFolder(row.path);
    else void browser.select(row.entry.id);
  }

  function folderMenu(path: string): MenuEntry[] {
    return [
      { heading: path ? `${path}/` : 'Library' },
      {
        label: 'New document here…',
        onSelect: () => {
          browser.selectFolder(path);
          browser.openCreate();
        },
      },
      { label: 'New folder here…', onSelect: () => browser.openCreateFolder(path) },
      ...(path
        ? ([
            { separator: true },
            { label: 'Rename or move…', onSelect: () => browser.openMove({ kind: 'folder', path }) },
            { separator: true },
            { label: 'Delete folder…', danger: true, onSelect: () => void browser.requestRemoveFolder(path) },
          ] satisfies MenuEntry[])
        : []),
    ];
  }

  function documentMenu(id: string): MenuEntry[] {
    return [
      { heading: `library:${id}` },
      { label: 'Open', onSelect: () => void browser.select(id) },
      {
        label: 'Edit',
        onSelect: async () => {
          await browser.select(id);
          if (browser.selected === id) browser.startEdit();
        },
      },
      { label: 'Copy the reference', onSelect: () => void navigator.clipboard?.writeText(`library:${id}`) },
      { separator: true },
      { label: 'Rename or move…', onSelect: () => browser.openMove({ kind: 'document', path: id }) },
      { separator: true },
      {
        label: 'Delete…',
        danger: true,
        onSelect: async () => {
          await browser.select(id);
          if (browser.selected === id) browser.confirmingDelete = true;
        },
      },
    ];
  }

  function oncontextmenu(event: MouseEvent, row: TreeRow | null): void {
    event.preventDefault();
    const entries = row === null ? folderMenu('') : row.kind === 'folder' ? folderMenu(row.path) : documentMenu(row.entry.id);
    menu = { anchor: { x: event.clientX, y: event.clientY }, entries };
  }

  function submit(event: SubmitEvent, action: () => Promise<boolean>): void {
    event.preventDefault();
    void action();
  }

  const isOpen = (row: TreeRow): boolean => row.kind === 'folder' && (browser.search.trim() !== '' || browser.expanded.has(row.path));
</script>

{#snippet icon(kind: 'library' | 'folder' | 'open' | 'document')}
  <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
    {#if kind === 'document'}
      <path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3" />
    {:else if kind === 'library'}
      <path d="M2.5 2.5h3v11h-3z M6.5 2.5h3v11h-3z M10.5 3.2l2.6-.7 2.1 10.4-2.6.6z" />
    {:else if kind === 'open'}
      <path d="M1.5 4h4l1.5 1.5h6v2 M1.5 4v8.5h11l2-5h-11l-2 5" />
    {:else}
      <path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z" />
    {/if}
  </svg>
{/snippet}

<aside class="tree-pane" aria-label="Library folders and documents">
  <div class="head">
    <input class="search" type="search" placeholder="Search the library" aria-label="Search the library" bind:value={browser.search} />
  </div>
  <div class="toolbar">
    <Button size="sm" variant="primary" title="Add a document to the current folder" onclick={() => browser.openCreate()}>
      New document
    </Button>
    <Button size="sm" title="Add a folder inside the current folder" onclick={() => browser.openCreateFolder()}>New folder</Button>
  </div>

  {#if browser.creating}
    <form class="form" onsubmit={(event) => submit(event, () => browser.create())}>
      <strong>New document</strong>
      <label>
        <span>Id</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input bind:value={browser.creating.id} placeholder="prompts/code-review" autofocus />
      </label>
      <label>
        <span>Title</span>
        <input bind:value={browser.creating.title} placeholder="Code review prompt" />
      </label>
      <label>
        <span>Description</span>
        <input bind:value={browser.creating.description} placeholder="What a reviewer checks" />
      </label>
      {#if browser.newIdProblem}
        <p class="problem">{browser.newIdProblem}</p>
      {:else}
        <p class="hint">The file is .lpm/library/&lt;id&gt;.md. The part before the last "/" is the folder.</p>
      {/if}
      <div class="row">
        <Button size="sm" variant="ghost" onclick={() => browser.closeCreate()}>Cancel</Button>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={!browser.creating.id.trim() || browser.newIdProblem !== null || browser.busy}
        >
          Add
        </Button>
      </div>
    </form>
  {/if}

  {#if browser.creatingFolder}
    <form class="form" onsubmit={(event) => submit(event, () => browser.createFolder())}>
      <strong>New folder in {browser.creatingFolder.parent ? `${browser.creatingFolder.parent}/` : 'the library'}</strong>
      <label>
        <span>Name</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input bind:value={browser.creatingFolder.name} placeholder="prompts" autofocus />
      </label>
      {#if browser.newFolderProblem}
        <p class="problem">{browser.newFolderProblem}</p>
      {/if}
      <div class="row">
        <Button size="sm" variant="ghost" onclick={() => browser.closeCreateFolder()}>Cancel</Button>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={!browser.creatingFolder.name.trim() || browser.newFolderProblem !== null || browser.busy}
        >
          Create
        </Button>
      </div>
    </form>
  {/if}

  {#if browser.moving}
    <form class="form" onsubmit={(event) => submit(event, () => browser.move())}>
      <strong>Move {browser.moving.item.kind === 'folder' ? `the folder ${browser.moving.item.path}/` : `library:${browser.moving.item.path}`}</strong>
      <label>
        <span>New path</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input bind:value={browser.moving.to} autofocus />
      </label>
      {#if browser.moveProblem}
        <p class="problem">{browser.moveProblem}</p>
      {:else}
        <p class="hint">
          Change the last part to rename, the folders before it to move. The issues and templates that reference a
          moved document get the new id.
        </p>
      {/if}
      <div class="row">
        <Button size="sm" variant="ghost" onclick={() => browser.closeMove()}>Cancel</Button>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={!browser.moving.to.trim() || browser.moveProblem !== null || browser.busy}
        >
          Move
        </Button>
      </div>
    </form>
  {/if}

  {#if browser.folderToDelete}
    <div class="form danger" role="alert">
      <strong>Delete the folder {browser.folderToDelete.path}/?</strong>
      <p>
        It holds {browser.folderToDelete.count === 1 ? '1 document' : `${browser.folderToDelete.count} documents`}. The
        delete removes them too. The references to them stay on the issues.
      </p>
      <div class="row">
        <Button size="sm" variant="ghost" onclick={() => browser.resolveRemoveFolder(false)}>Cancel</Button>
        <Button size="sm" variant="danger" disabled={browser.busy} onclick={() => browser.resolveRemoveFolder(true)}>
          Delete everything
        </Button>
      </div>
    </div>
  {/if}

  <div class="tree" role="tree" aria-label="Library">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
    <div
      class="row-item top"
      class:current={browser.currentFolder === ''}
      class:drop={dropFolder === ''}
      role="treeitem"
      aria-selected={browser.currentFolder === ''}
      tabindex="0"
      onclick={() => browser.selectFolder('')}
      ondragover={(event) => ondragover(event, null)}
      ondragleave={() => (dropFolder = null)}
      ondrop={(event) => ondrop(event, null)}
      oncontextmenu={(event) => oncontextmenu(event, null)}
    >
      {@render icon('library')}
      <span class="name">Library</span>
      <span class="count">{browser.entries.length}</span>
    </div>

    {#if browser.loading}
      <p class="hint pad">Loading the library…</p>
    {:else if !browser.rows.length}
      <p class="hint pad">
        {browser.search.trim()
          ? 'No document matches the search.'
          : 'The library is empty. Add prompts, summaries and requirement documents that belong beside the board.'}
      </p>
    {/if}

    {#each browser.rows as row (row.kind === 'folder' ? `f:${row.path}` : `d:${row.entry.id}`)}
      {#if row.kind === 'folder'}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
        <div
          class="row-item folder"
          class:current={browser.currentFolder === row.path}
          class:drop={dropFolder === row.path}
          style:--depth={row.depth}
          role="treeitem"
          aria-expanded={isOpen(row)}
          aria-selected={browser.currentFolder === row.path}
          tabindex="0"
          draggable="true"
          title="{row.path}/"
          onclick={() => onrowclick(row)}
          onkeydown={(event) => event.key === 'Enter' && onrowclick(row)}
          ondragstart={(event) => ondragstart(event, row)}
          ondragover={(event) => ondragover(event, row)}
          ondragleave={() => (dropFolder = null)}
          ondrop={(event) => ondrop(event, row)}
          ondragend={ondragend}
          oncontextmenu={(event) => oncontextmenu(event, row)}
        >
          <button
            type="button"
            class="chevron"
            class:open={isOpen(row)}
            aria-label={isOpen(row) ? `Close ${row.name}` : `Open ${row.name}`}
            onclick={(event) => {
              event.stopPropagation();
              browser.toggleFolder(row.path);
            }}
          >
            ▸
          </button>
          {@render icon(isOpen(row) ? 'open' : 'folder')}
          <span class="name">{row.name}</span>
          <span class="count">{row.count}</span>
        </div>
      {:else}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
        <div
          class="row-item document"
          class:active={browser.selected === row.entry.id}
          class:drop={dropFolder !== null && dropFolder === parentOf(row.entry.id)}
          style:--depth={row.depth}
          role="treeitem"
          aria-selected={browser.selected === row.entry.id}
          tabindex="0"
          draggable="true"
          title="library:{row.entry.id}{row.entry.description ? `\n${row.entry.description}` : ''}"
          onclick={() => onrowclick(row)}
          onkeydown={(event) => event.key === 'Enter' && onrowclick(row)}
          ondragstart={(event) => ondragstart(event, row)}
          ondragover={(event) => ondragover(event, row)}
          ondragleave={() => (dropFolder = null)}
          ondrop={(event) => ondrop(event, row)}
          ondragend={ondragend}
          oncontextmenu={(event) => oncontextmenu(event, row)}
        >
          <span class="chevron-space" aria-hidden="true"></span>
          {@render icon('document')}
          <span class="doc-text">
            <span class="name">{row.entry.title}</span>
            <span class="file">{row.name}</span>
          </span>
        </div>
      {/if}
    {/each}
  </div>

  {#if browser.currentFolder}
    <div class="current-bar">
      <span title="New documents and folders go here">In <code>{browser.currentFolder}/</code></span>
      <button type="button" onclick={() => browser.openMove({ kind: 'folder', path: browser.currentFolder })}>Move</button>
      <button type="button" class="danger" onclick={() => void browser.requestRemoveFolder(browser.currentFolder)}>Delete</button>
    </div>
  {/if}
</aside>

{#if menu}
  <ContextMenu anchor={menu.anchor} entries={menu.entries} onclose={() => (menu = null)} />
{/if}

<style>
  .tree-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    gap: var(--space-2);
    padding: var(--space-3);
    border-right: 1px solid var(--border);
    background: var(--surface-1);
  }

  .search,
  input {
    width: 100%;
    min-width: 0;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
  }

  .toolbar {
    display: flex;
    gap: var(--space-2);
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    font-size: var(--text-sm);
  }

  .form.danger {
    border-color: var(--danger);
  }

  .form p {
    margin: 0;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  label span {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .row {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .tree {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .row-item {
    --depth: 0;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-height: 1.9rem;
    padding: 0.15rem var(--space-2) 0.15rem calc(var(--space-2) + var(--depth) * 1.1rem);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    color: var(--ink);
    font-size: var(--text-sm);
    cursor: pointer;
    user-select: none;
  }

  .row-item:hover {
    background: var(--surface-2);
  }

  .row-item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .row-item.current,
  .row-item.active {
    background: var(--accent-soft);
  }

  .row-item.active {
    border-color: var(--accent);
  }

  .row-item.drop {
    border-color: var(--accent);
    border-style: dashed;
    background: var(--accent-soft);
  }

  .row-item.top {
    font-weight: 600;
  }

  .chevron,
  .chevron-space {
    flex: none;
    width: 1.1rem;
  }

  .chevron {
    padding: 0;
    border: none;
    background: none;
    color: var(--ink-muted);
    font-size: var(--text-xs);
    transition: transform 120ms ease;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .icon {
    flex: none;
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: var(--ink-muted);
    stroke-width: 1.2;
    stroke-linejoin: round;
  }

  .folder .icon {
    stroke: var(--accent);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .folder .name {
    font-weight: 600;
  }

  .doc-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.25;
  }

  .file {
    color: var(--ink-faint);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .count {
    margin-left: auto;
    padding-left: var(--space-2);
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .current-bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .current-bar span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .current-bar button {
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--ink);
    font-size: var(--text-xs);
  }

  .current-bar button.danger {
    color: var(--danger);
  }

  code {
    font-family: var(--font-mono);
  }

  .hint {
    margin: 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .pad {
    padding: var(--space-2);
  }

  .problem {
    color: var(--danger);
    font-size: var(--text-xs);
  }
</style>
