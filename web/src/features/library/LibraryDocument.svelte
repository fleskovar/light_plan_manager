<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import Markdown from '$lib/ui/Markdown.svelte';
  import type { LibraryBrowser } from './library.svelte.js';

  /**
   * The right side of the Library page: the open document, its editor and the
   * issues that reference it.
   *
   * The editor is the editor of the issue window: Edit opens the markdown
   * source, Write and Preview switch between the source and the rendered
   * text, and Save writes the file. Edit also opens the title and the
   * description. Move opens the move form of the tree pane on this document.
   */
  interface Props {
    browser: LibraryBrowser;
    /** The title of an issue, or null when the board has no issue with this id. */
    issueTitle: (id: string) => string | null;
    /** Open the issue window for an issue that references the document. Null when the page knows no view. */
    openIssue: ((id: string) => void) | null;
  }

  let { browser, issueTitle, openIssue }: Props = $props();

  let copied = $state(false);

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

  function onkeydown(event: KeyboardEvent): void {
    // Ctrl+S or Cmd+S saves and keeps the editor open, as in the issue window.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && browser.draft.editing) {
      event.preventDefault();
      void browser.save(false);
    }
  }
</script>

<svelte:window {onkeydown} />

<section class="doc" aria-label="Library document">
  {#if browser.pendingSelect !== null}
    <div class="bar warn" role="alert">
      <span>This document has unsaved changes.</span>
      <Button size="sm" variant="ghost" onclick={() => browser.resolvePendingSelect(false)}>Keep editing</Button>
      <Button size="sm" variant="danger" onclick={() => browser.resolvePendingSelect(true)}>Discard the changes</Button>
    </div>
  {/if}

  {#if browser.selected === null}
    <div class="empty">
      <h2>No document is open</h2>
      <p>Open a document in the tree, or add one with <strong>New document</strong>.</p>
      <p class="hint">
        Drag a document or a folder onto a folder to move it. A right-click on a row shows every action. An issue
        references a document with the related file <code>library:&lt;id&gt;</code>, or with a link
        <code>[text](library:&lt;id&gt;)</code> in its description. The working brief of the issue prints each document
        that it references.
      </p>
    </div>
  {:else if browser.reading}
    <p class="hint">Loading {browser.selected}…</p>
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
          <h2>{doc.title}</h2>
          {#if doc.description}<p class="description">{doc.description}</p>{/if}
        </div>
      {/if}
      <div class="actions">
        {#if browser.draft.editing}
          <div class="segmented" role="group" aria-label="Editor mode">
            <button type="button" aria-pressed={!browser.draft.previewing} onclick={() => (browser.draft.previewing = false)}>
              Write
            </button>
            <button type="button" aria-pressed={browser.draft.previewing} onclick={() => (browser.draft.previewing = true)}>
              Preview
            </button>
          </div>
          <Button size="sm" variant="ghost" onclick={() => browser.cancelEdit()}>Cancel</Button>
          <Button
            size="sm"
            variant="primary"
            disabled={browser.busy}
            title="Save the document and close the editor (Ctrl+S saves and keeps it open)"
            onclick={() => void browser.save(true)}
          >
            Save
          </Button>
        {:else if browser.confirmingDelete}
          <span class="confirm">Delete {doc.path}?</span>
          <Button size="sm" variant="ghost" onclick={() => (browser.confirmingDelete = false)}>Cancel</Button>
          <Button size="sm" variant="danger" disabled={browser.busy} onclick={() => void browser.remove()}>Delete</Button>
        {:else}
          <Button size="sm" title="Edit the markdown source" onclick={() => browser.startEdit()}>Edit</Button>
          <Button
            size="sm"
            variant="ghost"
            title="Give the document a new id or folder, and rewrite the references to it"
            onclick={() => browser.openMove({ kind: 'document', path: doc.id })}
          >
            Move
          </Button>
          <Button size="sm" variant="ghost" title="Delete the file" onclick={() => (browser.confirmingDelete = true)}>
            Delete
          </Button>
        {/if}
      </div>
    </div>

    <div class="meta">
      <button type="button" class="ref" title="Copy the reference" onclick={copyRef}>
        <code>{browser.ref}</code>
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
      <span class="path" title="The file of this document">{doc.path}</span>
      {#if doc.updated}<span class="path">Changed {doc.updated.slice(0, 16).replace('T', ' ')}</span>{/if}
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
        <Markdown source={browser.draft.editing ? browser.draft.text : doc.body} placeholder="This document is empty." />
      </div>
    {/if}

    <div class="refs">
      <h3>Referenced by</h3>
      {#if doc.referencedBy.length}
        <ul>
          {#each doc.referencedBy as id (id)}
            {@const title = issueTitle(id)}
            <li>
              {#if openIssue && title !== null}
                <button type="button" class="node" title="Open {id} in its window" onclick={() => openIssue(id)}>
                  <code>{id}</code>
                  {title}
                </button>
              {:else}
                <span class="node"><code>{id}</code>{#if title} {title}{/if}</span>
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

<style>
  .doc {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    height: 100%;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
  }

  .doc-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  h2 {
    margin: 0;
    font-size: var(--text-xl);
  }

  h3 {
    margin: 0 0 var(--space-1);
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .description {
    margin: var(--space-1) 0 0;
    color: var(--ink-muted);
  }

  .fields {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
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

  input {
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    color: var(--ink);
    font: inherit;
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

  code,
  .path {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .path {
    color: var(--ink-faint);
  }

  .source,
  .rendered {
    flex: 1;
    min-height: 14rem;
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
    padding: var(--space-4) var(--space-5);
  }

  .rendered :global(.prose) {
    max-width: 52rem;
    font-size: var(--text-md);
    line-height: 1.65;
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

  .refs ul {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .node {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1);
    padding: 0.1rem 0.45rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--ink);
    font-size: var(--text-sm);
  }

  button.node:hover {
    border-color: var(--accent);
  }

  .node code {
    color: var(--accent);
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--warn);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }

  .empty {
    margin: auto;
    max-width: 34rem;
    text-align: center;
  }

  .empty h2 {
    font-size: var(--text-lg);
    margin-bottom: var(--space-2);
  }

  .hint {
    margin: 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    line-height: 1.5;
  }
</style>
