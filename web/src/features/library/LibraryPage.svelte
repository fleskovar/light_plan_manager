<script lang="ts">
  import { untrack } from 'svelte';
  import type { BoardSnapshot } from '$shared';
  import { api } from '$lib/api/client.js';
  import { openIssueWindow } from '$lib/app/issue-window.js';
  import { issueHash, libraryHash } from '$lib/app/router.svelte.js';
  import { provideNodeLinks } from '$lib/ui/node-links.js';
  import LibraryDocument from './LibraryDocument.svelte';
  import LibraryTree from './LibraryTree.svelte';
  import { LibraryBrowser, type LibraryApi } from './library.svelte.js';

  /**
   * The Library page (`#/library`): the folders and the documents of
   * `.lpm/library/` on the left, the open document on the right. The board
   * page opens it in a window of its own with File ▸ Library…, with the
   * Library button of its top row, and with each `library:` link.
   *
   * `docId` names the document to open. The address follows the open
   * document, so a reload and a bookmark return to it. `viewId` names the view
   * whose issue windows the "Referenced by" links open.
   */
  interface Props {
    /** A new object on each change of the address, so a second request for the same document still opens it. */
    route: { docId: string | null; viewId: string | null };
  }

  let { route }: Props = $props();

  const libraryApi: LibraryApi = {
    list: api.listLibrary,
    get: api.getLibraryDoc,
    create: api.createLibraryDoc,
    update: api.updateLibraryDoc,
    remove: api.deleteLibraryDoc,
    move: api.moveLibraryDoc,
    createFolder: api.createLibraryFolder,
    removeFolder: api.deleteLibraryFolder,
  };

  const browser = new LibraryBrowser(libraryApi, {
    // `replaceState` changes the address without a `hashchange`, so the page
    // does not open the document a second time.
    onselect: (id) => history.replaceState(null, '', libraryHash(id, route.viewId)),
  });

  let board = $state.raw<BoardSnapshot | null>(null);
  let boardName = $state('');

  // svelte-ignore state_referenced_locally
  void browser.load(route.docId);
  void api
    .board()
    .then((snapshot) => (board = snapshot))
    .catch(() => {
      // Without the board, the page shows the ids of the issues that reference a document, and no titles.
    });
  void api
    .serverInfo()
    .then((info) => {
      boardName = info.root.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
      document.title = boardName ? `Library · ${boardName}` : 'Library';
    })
    .catch(() => (document.title = 'Library'));

  // Another window asks for a document: open it here.
  let first = true;
  $effect(() => {
    const wanted = route.docId;
    if (first) {
      first = false;
      return;
    }
    untrack(() => {
      if (wanted !== null && wanted !== browser.selected) void browser.select(wanted);
    });
  });

  function issueTitle(id: string): string | null {
    const nodes = board ? [...board.issues, ...board.templates] : [];
    return nodes.find((node) => node.id === id)?.title ?? null;
  }

  const viewId = $derived(route.viewId);
  const openIssue = $derived(viewId === null ? null : (id: string) => openIssueWindow(id, viewId));

  // A `library:` link in a document opens that document on this page, and
  // `[[ID]]` opens the issue window.
  provideNodeLinks({
    target: (id) => {
      const title = issueTitle(id);
      return title === null || viewId === null ? null : { href: issueHash(id, viewId), title };
    },
    open: (id) => {
      if (viewId !== null) openIssueWindow(id, viewId);
    },
    openLibrary: (id) => void browser.select(id),
  });

  function onbeforeunload(event: BeforeUnloadEvent): void {
    if (browser.dirty) event.preventDefault();
  }
</script>

<svelte:window {onbeforeunload} />

<div class="page">
  <header>
    <div class="title">
      <h1>Library</h1>
      {#if boardName}<span class="board">{boardName}</span>{/if}
    </div>
    <p class="lead">
      Markdown documents beside the board, in <code>.lpm/library</code>: prompts, summaries, requirement documents.
    </p>
    <div class="status" role="status">
      {#if browser.busy}<span>Saving…</span>{/if}
    </div>
  </header>

  {#if browser.error}
    <div class="bar error" role="alert">
      <span>{browser.error}</span>
      {#if browser.conflict}
        <button type="button" onclick={() => browser.reload()}>Reload the document</button>
      {/if}
      <button type="button" class="dismiss" aria-label="Dismiss" onclick={() => (browser.error = null)}>×</button>
    </div>
  {:else if browser.notice}
    <div class="bar done" role="status">
      <span>{browser.notice}</span>
      <button type="button" class="dismiss" aria-label="Dismiss" onclick={() => (browser.notice = null)}>×</button>
    </div>
  {/if}

  <main>
    <LibraryTree {browser} />
    <LibraryDocument {browser} {issueTitle} {openIssue} />
  </main>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--surface-0);
    color: var(--ink);
  }

  header {
    display: flex;
    align-items: baseline;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }

  .title {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  h1 {
    margin: 0;
    font-size: var(--text-xl);
  }

  .board {
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }

  .lead {
    flex: 1;
    margin: 0;
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }

  .status {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  code {
    font-family: var(--font-mono);
    font-size: 0.9em;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-2) var(--space-5) 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }

  .bar span {
    flex: 1;
  }

  .bar.error {
    color: var(--tone-blocked);
    background: var(--tone-blocked-soft);
  }

  .bar.done {
    border: 1px solid var(--tone-done);
    background: var(--tone-done-soft);
  }

  .bar button {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--ink);
    font-size: var(--text-xs);
    padding: 0.1rem 0.5rem;
  }

  .bar .dismiss {
    border: none;
    background: none;
    font-size: var(--text-md);
  }

  main {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(16rem, 22rem) 1fr;
  }

  @media (max-width: 48rem) {
    header {
      flex-wrap: wrap;
    }

    main {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(14rem, 40vh) 1fr;
    }
  }
</style>
