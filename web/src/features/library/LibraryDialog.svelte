<script lang="ts">
  import { api } from '$lib/api/client.js';
  import Button from '$lib/ui/Button.svelte';
  import Markdown from '$lib/ui/Markdown.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import { useNodeLinks } from '$lib/ui/node-links.js';
  import { LibraryBrowser, type LibraryApi } from './library.svelte.js';

  /**
   * The Library dialog: the list of the documents in `.lpm/library/` on the
   * left, and the open document on the right. `LibraryBrowser` holds the state
   * and the actions, so this component only draws them.
   *
   * The editor of a document is the editor of the issue window: Edit opens the
   * markdown source, Write and Preview switch between the source and the
   * rendered text, and Save writes the file. A close with unsaved changes asks
   * first.
   */
  interface Props {
    /** The document to open first, or null for none. */
    initial: string | null;
    onclose: () => void;
  }

  let { initial, onclose }: Props = $props();

  const libraryApi: LibraryApi = {
    list: api.listLibrary,
    get: api.getLibraryDoc,
    create: api.createLibraryDoc,
    update: api.updateLibraryDoc,
    remove: api.deleteLibraryDoc,
    move: api.moveLibraryDoc,
  };
  const browser = new LibraryBrowser(libraryApi);
  // svelte-ignore state_referenced_locally
  void browser.load(initial);

  const links = useNodeLinks();
  let closing = $state(false);
  let copied = $state(false);

  function requestClose(): void {
    if (browser.dirty) closing = true;
    else onclose();
  }

  async function copyRef(): Promise<void> {
    const ref = browser.ref;
    if (!ref) return;
    try {
      await navigator.clipboard.writeText(ref);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // The browser refused the clipboard. The reference stays on screen to copy by hand.
    }
  }

  function submitRename(event: SubmitEvent): void {
    event.preventDefault();
    void browser.rename();
  }

  function submitCreate(event: SubmitEvent): void {
    event.preventDefault();
    void browser.create();
  }
</script>

<Modal title="Library" size="lg" fixedHeight onclose={requestClose}>
  <div class="library">
    <aside class="list" aria-label="Library documents">
      <div class="list-head">
        <input
          class="search"
          type="search"
          placeholder="Search the library"
          aria-label="Search the library"
          bind:value={browser.search}
        />
        <Button size="sm" variant="primary" title="Add a document to .lpm/library" onclick={() => browser.openCreate()}>
          New
        </Button>
      </div>

      {#if browser.creating}
        <form class="create" onsubmit={submitCreate}>
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
            <p class="hint">The file is .lpm/library/&lt;id&gt;.md. Use "/" for folders.</p>
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

      {#if browser.loading}
        <p class="hint pad">Loading the library…</p>
      {:else if !browser.entries.length}
        <p class="hint pad">
          The library is empty. Add prompts, summaries and requirement documents that belong beside the board.
        </p>
      {:else if !browser.visible.length}
        <p class="hint pad">No document matches the search.</p>
      {:else}
        <ul>
          {#each browser.visible as entry (entry.id)}
            <li>
              <button
                type="button"
                class="entry"
                class:active={entry.id === browser.selected}
                aria-current={entry.id === browser.selected ? 'true' : undefined}
                onclick={() => browser.select(entry.id)}
              >
                <span class="entry-title">{entry.title}</span>
                <span class="entry-id">{entry.id}</span>
                {#if entry.description}<span class="entry-description">{entry.description}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </aside>

    <section class="doc" aria-label="Library document">
      {#if browser.pendingSelect !== null}
        <div class="bar warn" role="alert">
          <span>This document has unsaved changes.</span>
          <Button size="sm" variant="ghost" onclick={() => browser.resolvePendingSelect(false)}>Keep editing</Button>
          <Button size="sm" variant="danger" onclick={() => browser.resolvePendingSelect(true)}>Discard the changes</Button>
        </div>
      {/if}
      {#if browser.error}
        <div class="bar error" role="alert">
          <span>{browser.error}</span>
          {#if browser.conflict}
            <Button size="sm" onclick={() => browser.reload()}>Reload the document</Button>
          {/if}
        </div>
      {:else if browser.notice}
        <div class="bar done" role="status">{browser.notice}</div>
      {/if}

      {#if browser.selected === null}
        <div class="empty">
          <p>Open a document on the left, or add one with New.</p>
          <p class="hint">
            An issue references a document with the related file <code>library:&lt;id&gt;</code>, or with a link
            <code>[text](library:&lt;id&gt;)</code> in its description. The working brief of the issue prints each
            document that it references.
          </p>
        </div>
      {:else if browser.reading}
        <p class="hint pad">Loading {browser.selected}…</p>
      {:else if browser.doc}
        {@const doc = browser.doc}
        <div class="doc-head">
          {#if browser.draft.editing}
            <div class="fields">
              <label>
                <span>Title</span>
                <input bind:value={browser.title} />
              </label>
              <label>
                <span>Description</span>
                <input bind:value={browser.description} placeholder="One line that says what the document is for" />
              </label>
            </div>
          {:else}
            <div class="identity">
              <h3>{doc.title}</h3>
              {#if doc.description}<p class="description">{doc.description}</p>{/if}
            </div>
          {/if}
          <div class="actions">
            {#if browser.draft.editing}
              <div class="segmented" role="group" aria-label="Editor mode">
                <button
                  type="button"
                  aria-pressed={!browser.draft.previewing}
                  onclick={() => (browser.draft.previewing = false)}
                >
                  Write
                </button>
                <button
                  type="button"
                  aria-pressed={browser.draft.previewing}
                  onclick={() => (browser.draft.previewing = true)}
                >
                  Preview
                </button>
              </div>
              <Button size="sm" variant="ghost" onclick={() => browser.cancelEdit()}>Cancel</Button>
              <Button
                size="sm"
                variant="primary"
                disabled={browser.busy}
                title="Save the document and close the editor"
                onclick={() => void browser.save(true)}
              >
                Save
              </Button>
            {:else if browser.confirmingDelete}
              <span class="confirm">Delete {doc.path}?</span>
              <Button size="sm" variant="ghost" onclick={() => (browser.confirmingDelete = false)}>Cancel</Button>
              <Button size="sm" variant="danger" disabled={browser.busy} onclick={() => void browser.remove()}>
                Delete
              </Button>
            {:else}
              <Button size="sm" title="Edit the markdown source" onclick={() => browser.startEdit()}>Edit</Button>
              <Button
                size="sm"
                variant="ghost"
                title="Give the document a new id, and rewrite the references to it"
                onclick={() => browser.openRename()}
              >
                Rename
              </Button>
              <Button size="sm" variant="ghost" title="Delete the file" onclick={() => (browser.confirmingDelete = true)}>
                Delete
              </Button>
            {/if}
          </div>
        </div>

        {#if browser.renaming !== null}
          <form class="rename" onsubmit={submitRename}>
            <label>
              <span>New id</span>
              <!-- svelte-ignore a11y_autofocus -->
              <input bind:value={browser.renaming} autofocus />
            </label>
            <Button size="sm" variant="ghost" onclick={() => browser.closeRename()}>Cancel</Button>
            <Button
              size="sm"
              variant="primary"
              type="submit"
              disabled={!browser.renaming.trim() || browser.renameProblem !== null || browser.busy}
            >
              Rename
            </Button>
            {#if browser.renameProblem}
              <p class="problem">{browser.renameProblem}</p>
            {:else}
              <p class="hint">The issues and templates that reference this document get the new id.</p>
            {/if}
          </form>
        {/if}

        <div class="meta">
          <button type="button" class="ref" title="Copy the reference" onclick={copyRef}>
            <code>{browser.ref}</code>
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <span class="path" title="The file of this document">{doc.path}</span>
        </div>

        {#if browser.draft.editing && !browser.draft.previewing}
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            class="source"
            bind:value={browser.draft.text}
            aria-label="Document, in markdown"
            placeholder="Write the document in markdown."
            autofocus
          ></textarea>
        {:else}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="rendered"
            class:preview={browser.draft.editing}
            ondblclick={() => !browser.draft.editing && browser.startEdit()}
            title={browser.draft.editing ? undefined : 'Double-click to edit'}
          >
            <Markdown
              source={browser.draft.editing ? browser.draft.text : doc.body}
              placeholder="This document is empty."
            />
          </div>
        {/if}

        <div class="refs">
          <h4>Referenced by</h4>
          {#if doc.referencedBy.length}
            <ul>
              {#each doc.referencedBy as id (id)}
                <li>
                  {#if links?.target(id)}
                    <button type="button" class="node" onclick={() => links.open(id)}>{id}</button>
                  {:else}
                    <span class="node">{id}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="hint">No issue or template references this document.</p>
          {/if}
        </div>
      {/if}
    </section>
  </div>

  {#snippet footer()}
    {#if closing}
      <span class="closing">The open document has unsaved changes.</span>
      <Button onclick={() => (closing = false)}>Keep editing</Button>
      <Button variant="danger" onclick={onclose}>Close without saving</Button>
    {:else}
      <Button onclick={requestClose}>Close</Button>
    {/if}
  {/snippet}
</Modal>

<style>
  .library {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(13rem, 18rem) 1fr;
    gap: var(--space-4);
  }

  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
    padding-right: var(--space-3);
  }

  .list-head {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }

  .search,
  input {
    min-width: 0;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
  }

  .search {
    flex: 1;
  }

  .list ul {
    flex: 1;
    min-height: 0;
    overflow: auto;
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .entry {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: none;
    color: var(--ink);
    text-align: left;
  }

  .entry:hover {
    background: var(--surface-2);
  }

  .entry.active {
    background: var(--accent-soft);
    border-color: var(--accent);
  }

  .entry-title {
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .entry-id,
  .path,
  code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .entry-id {
    color: var(--ink-muted);
  }

  .entry-description {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .create {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2);
    margin-bottom: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-0);
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  label span,
  h4 {
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

  .doc {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    gap: var(--space-2);
  }

  .doc-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .identity h3 {
    margin: 0;
    font-size: var(--text-lg);
  }

  .description {
    margin: var(--space-1) 0 0;
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }

  .fields {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .actions {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .confirm {
    color: var(--danger);
    font-size: var(--text-sm);
  }

  .rename {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-2);
  }

  .rename label {
    flex: 1;
    min-width: 12rem;
  }

  .rename p {
    flex-basis: 100%;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }

  .ref {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--ink);
  }

  .ref span {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .path {
    color: var(--ink-faint);
  }

  .source,
  .rendered {
    flex: 1;
    min-height: 12rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .source {
    width: 100%;
    margin: 0;
    padding: var(--space-3) var(--space-4);
    outline: none;
    background: var(--surface-0);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: 1.6;
    resize: none;
  }

  .rendered {
    overflow: auto;
    padding: var(--space-3) var(--space-4);
  }

  .rendered.preview {
    background: var(--surface-0);
  }

  .segmented {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .segmented button {
    border: none;
    padding: 0.15rem 0.6rem;
    background: var(--surface-1);
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }

  .segmented button + button {
    border-left: 1px solid var(--border);
  }

  .segmented button[aria-pressed='true'] {
    background: var(--accent-soft);
    color: var(--ink);
    font-weight: 600;
  }

  .refs h4 {
    margin: 0 0 var(--space-1);
  }

  .refs ul {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .node {
    padding: 0.05rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  span.node {
    color: var(--ink-muted);
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }

  .bar.error {
    color: var(--tone-blocked);
    background: var(--tone-blocked-soft);
  }

  .bar.warn {
    border: 1px solid var(--warn);
  }

  .bar.done {
    border: 1px solid var(--tone-done);
    background: var(--tone-done-soft);
  }

  .empty {
    margin: auto;
    max-width: 30rem;
    text-align: center;
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
    margin: 0;
    color: var(--danger);
    font-size: var(--text-xs);
  }

  .closing {
    margin-right: auto;
    color: var(--danger);
    font-size: var(--text-sm);
  }

  @media (max-width: 44rem) {
    .library {
      grid-template-columns: 1fr;
    }

    .list {
      max-height: 14rem;
      border-right: none;
      border-bottom: 1px solid var(--border);
      padding: 0 0 var(--space-2);
    }
  }
</style>
