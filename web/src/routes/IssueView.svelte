<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { canvasWindow, issueWindowLinks, openIssueWindow } from '$lib/app/issue-window.js';
  import { neighbours } from '$lib/board/links.js';
  import AttributeField from '$lib/ui/fields/AttributeField.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Markdown from '$lib/ui/Markdown.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import LibraryDialog from '$features/library/LibraryDialog.svelte';
  import { provideNodeLinks } from '$lib/ui/node-links.js';
  import Splitter from '$lib/ui/Splitter.svelte';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import Notices from '$lib/ui/Notices.svelte';
  import { editNode, removeDependency } from '$lib/workspace/mutations.js';
  import { Workspace, provideWorkspace } from '$lib/workspace/workspace.svelte.js';
  import { BodyDraft } from '$features/issue/body-draft.svelte.js';
  import {
    SIDE_MAX,
    SIDE_MIN,
    loadIssueLayout,
    splitFromCommentsHeight,
    storeIssueLayout,
  } from '$features/issue/layout.js';
  import { saveLabel, type SavedBy } from '$features/issue/save-status.js';
  import Comments from '$features/panel/sections/Comments.svelte';
  import Details from '$features/panel/sections/Details.svelte';
  import Files from '$features/panel/sections/Files.svelte';
  import Flag from '$features/panel/sections/Flag.svelte';
  import Neighbours from '$features/panel/sections/Neighbours.svelte';

  /**
   * A full-window issue detail view, opened as a popup when double-clicking a
   * node on the canvas. It loads its own workspace so editing flows straight to
   * the server, and notifies the opener on push so the main window can pull.
   *
   * The window has two columns. The left column holds the description and
   * scrolls on its own. The right column holds the details above the
   * comments, each in a pane that scrolls on its own, with a splitter between
   * them. A window narrower than `STACK_BELOW` pixels stacks the three panes
   * in one scrolling column.
   *
   * A change to a field is pushed by the workspace `AUTOSAVE_DELAY` after it
   * is made. A change to the description stays in a draft until the reader
   * presses Save, so the window can warn before it closes on one.
   */
  interface Props {
    nodeId: string;
    viewId: string;
  }

  let { nodeId, viewId }: Props = $props();

  /** Below this window width, the panes stack in one column. */
  const STACK_BELOW = 760;
  /** The narrowest the description column gets when the side column grows. */
  const BODY_MIN = 360;
  /** The shortest the details pane or the comments pane gets. */
  const PANE_MIN = 120;

  const workspace = provideWorkspace(new Workspace());
  // `[[ID]]` in the description or a comment opens another issue window, and
  // a `library:` link opens the Library dialog in this window.
  provideNodeLinks({
    ...issueWindowLinks(workspace, () => viewId),
    openLibrary: (id) => (library = { id }),
  });
  /** The Library dialog of this window, or null while it is closed. */
  let library = $state<{ id: string | null } | null>(null);

  /** The window with the canvas. It pulls after a push here, and it can select this issue. */
  const canvas = canvasWindow();

  let ready = $state(false);
  let failed = $state(false);

  // -- Saving ---------------------------------------------------------------

  const draft = new BodyDraft();
  let commentDraft = $state('');
  /** True while a push that the Save button started runs. */
  let saving = $state(false);
  let savedAt = $state<number | null>(null);
  let savedBy = $state<SavedBy>('auto');
  let now = $state(Date.now());
  /** Set just before this window closes itself, after the reader confirmed. */
  let closing = false;

  onMount(() => {
    workspace.open(viewId).then(() => (ready = true)).catch(() => (failed = true));
    // Edits push themselves. This hook records the write for the save label,
    // and tells the opener to pull.
    workspace.onPushed = () => {
      savedAt = Date.now();
      savedBy = saving ? 'manual' : 'auto';
      canvas?.postMessage({ type: 'lpm:pushed', nodeId }, window.location.origin);
    };
    // The label counts the time since the last write.
    const clock = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(clock);
  });

  onDestroy(() => workspace.dispose());

  // A push replaces the temporary id of an unpushed document with a real one.
  const node = $derived(workspace.node(workspace.resolve(nodeId)));
  const type = $derived(node ? workspace.config.types[node.type] : undefined);
  const links = $derived(
    node
      ? neighbours(workspace.nodes, node.id)
      : { upstream: [], downstream: [], rolledUpUpstream: [], rolledUpDownstream: [] },
  );

  const busy = $derived(saving || workspace.status === 'pushing');
  const unsaved = $derived(draft.dirty || workspace.dirty);
  const status = $derived(saveLabel({ saving: busy, unsaved, savedAt, savedBy }, now));

  $effect(() => {
    document.title = node
      ? `${unsaved ? '● ' : ''}${node.id} ${node.title} — light-plan`
      : `${nodeId} — light-plan`;
  });

  function edit(patch: Record<string, unknown>): void {
    if (node) editNode(workspace, node.id, patch);
  }

  /**
   * Store the description draft and push every pending change now. With
   * `closeEditor`, the description editor closes too. Returns true when the
   * board holds every change afterwards.
   */
  async function save(closeEditor = false): Promise<boolean> {
    if (!node || busy) return false;
    const body = draft.commit(closeEditor);
    if (body !== null && body !== node.body) edit({ body });
    if (!workspace.dirty) return true;
    saving = true;
    try {
      const failures = await workspace.push(true);
      return failures.length === 0 && !workspace.dirty;
    } finally {
      saving = false;
    }
  }

  async function flag(reason: string | null, comment: string): Promise<void> {
    if (!node) return;
    // A flag is written to disk at once, without the queue.
    if (await workspace.setFlag(node.id, reason, comment)) {
      savedAt = Date.now();
      savedBy = 'auto';
    }
  }

  function unlink(other: string, direction: 'upstream' | 'downstream'): void {
    if (!node) return;
    if (direction === 'upstream') removeDependency(workspace, node.id, other);
    else removeDependency(workspace, other, node.id);
  }

  // -- Leaving --------------------------------------------------------------

  /** True when a canvas window opened this window, so there is a window to go back to. */
  const hasOpener = Boolean(canvas);

  /** What the reader loses when this window closes. */
  function losses(): string[] {
    const items: string[] = [];
    if (draft.dirty) items.push('Your changes to the description.');
    if (workspace.dirty) {
      const count = workspace.pending.length;
      items.push(`${count} field change${count === 1 ? '' : 's'} that the board does not hold yet.`);
    }
    if (commentDraft.trim()) items.push('A comment that you did not post. Save does not post it.');
    return items;
  }

  interface Prompt {
    title: string;
    items: string[];
    /** The label of the button that saves first. Absent when Save cannot help. */
    saveLabel?: string;
    discardLabel: string;
    proceed: () => void;
  }

  let prompt = $state<Prompt | null>(null);

  function confirmClose(proceed: () => void): void {
    const items = losses();
    if (!items.length) return proceed();
    const saveHelps = draft.dirty || workspace.dirty;
    prompt = {
      title: 'Close with unsaved changes?',
      items,
      saveLabel: saveHelps ? 'Save and close' : undefined,
      discardLabel: 'Close without saving',
      proceed,
    };
  }

  async function saveAndProceed(): Promise<void> {
    const current = prompt;
    if (!current) return;
    prompt = null;
    // A failed save stays on screen as an error notice, and the window stays open.
    if (await save(true)) current.proceed();
  }

  function discardAndProceed(): void {
    const current = prompt;
    prompt = null;
    draft.discard();
    current?.proceed();
  }

  function closeWindow(): void {
    closing = true;
    window.close();
  }

  function requestClose(): void {
    confirmClose(closeWindow);
  }

  /** A linked issue opens in its own window, so this window keeps its changes. */
  function openIssue(id: string): void {
    openIssueWindow(id, viewId);
  }

  function showOnCanvas(): void {
    if (!node) return;
    canvas?.postMessage({ type: 'lpm:open', nodeId: node.id }, window.location.origin);
    canvas?.focus();
  }

  function cancelEdit(): void {
    if (!draft.dirty) return draft.discard();
    prompt = {
      title: 'Discard your changes to the description?',
      items: ['Your changes to the description.'],
      discardLabel: 'Discard changes',
      proceed: () => {},
    };
  }

  /**
   * The browser asks before the window closes or reloads. A browser shows its
   * own text in that dialog, so the text here does not reach the reader.
   */
  function onbeforeunload(event: BeforeUnloadEvent): void {
    if (!closing && losses().length) event.preventDefault();
  }

  function onkeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (unsaved) void save();
    }
  }

  // -- Pane sizes -----------------------------------------------------------

  let layout = $state(loadIssueLayout());
  let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1200);
  let sideHeight = $state(0);

  const stacked = $derived(windowWidth < STACK_BELOW);
  const sideMax = $derived(Math.max(SIDE_MIN, Math.min(SIDE_MAX, windowWidth - BODY_MIN)));
  const sideWidth = $derived(Math.min(Math.max(layout.side, SIDE_MIN), sideMax));
  const commentsHeight = $derived(Math.round((1 - layout.split) * sideHeight));

  function resizeSide(width: number): void {
    layout = { ...layout, side: width };
    storeIssueLayout(layout);
  }

  function resizeComments(height: number): void {
    layout = { ...layout, split: splitFromCommentsHeight(height, sideHeight) };
    storeIssueLayout(layout);
  }
</script>

<svelte:window bind:innerWidth={windowWidth} {onbeforeunload} {onkeydown} />

{#if failed}
  <div class="failure">
    <h1>Could not open “{viewId}”</h1>
    <p>Could not load the view for this issue.</p>
  </div>
{:else if !ready}
  <p class="loading">Loading…</p>
{:else if !node}
  <div class="failure">
    <h1>Issue “{nodeId}” not found</h1>
    <p>It may have been deleted or renamed.</p>
  </div>
{:else}
  <div class="popup-layout">
    <header class="topbar">
      <div class="identity">
        <span class="icon"><TypeIcon type={node.type} depth={node.depth} size={16} /></span>
        <span class="id">{node.id}</span>
        <span class="type-label">{type?.label ?? node.type}</span>
        <span class="title" title={node.title}>{node.title}</span>
      </div>
      <div class="toolbar">
        <span
          class="save-status tone-{status.tone}"
          title={status.title}
          role="status"
          aria-live="polite"
        >
          <span class="dot" aria-hidden="true"></span>
          {status.text}
        </span>
        <Button
          size="sm"
          variant="primary"
          disabled={!unsaved || busy}
          title="Write every change to the board (Ctrl+S)"
          onclick={() => void save()}
        >
          Save
        </Button>
        {#if node.kind === 'issue' && hasOpener}
          <Button
            size="sm"
            variant="ghost"
            title="Select this issue on the canvas of the main window"
            onclick={showOnCanvas}
          >
            Show on canvas
          </Button>
        {/if}
        {#if hasOpener}
          <button class="close" type="button" aria-label="Close this window" title="Close this window" onclick={requestClose}>
            ✕
          </button>
        {/if}
      </div>
    </header>

    <div class="columns" class:stacked style:--side-width="{sideWidth}px">
      <section class="pane body-pane" aria-label="Description">
        <div class="pane-head">
          <h2>Description</h2>
          <div class="pane-actions">
            {#if draft.editing}
              <div class="segmented" role="group" aria-label="Editor mode">
                <button type="button" aria-pressed={!draft.previewing} onclick={() => (draft.previewing = false)}>
                  Write
                </button>
                <button type="button" aria-pressed={draft.previewing} onclick={() => (draft.previewing = true)}>
                  Preview
                </button>
              </div>
              <Button size="sm" variant="ghost" onclick={cancelEdit}>Cancel</Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                title="Save the description and close the editor"
                onclick={() => void save(true)}
              >
                Save
              </Button>
            {:else}
              <Button size="sm" title="Edit the markdown source" onclick={() => draft.open(node.body)}>
                Edit
              </Button>
            {/if}
          </div>
        </div>

        {#if draft.editing && !draft.previewing}
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            class="source"
            bind:value={draft.text}
            aria-label="Description, in markdown"
            placeholder="Write the description in markdown."
            autofocus
          ></textarea>
        {:else}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="pane-scroll rendered"
            class:preview={draft.editing}
            ondblclick={() => draft.open(node.body)}
            title={draft.editing ? undefined : 'Double-click to edit'}
          >
            <Markdown source={draft.editing ? draft.text : node.body} />
          </div>
        {/if}
      </section>

      {#if !stacked}
        <Splitter
          orientation="vertical"
          size={sideWidth}
          min={SIDE_MIN}
          max={sideMax}
          label="Resize the side column"
          onresize={resizeSide}
        />
      {/if}

      <div class="side" bind:clientHeight={sideHeight}>
        <section class="pane details-pane" aria-label="Details">
          <div class="pane-head">
            <h2>Details</h2>
          </div>
          <div class="pane-scroll details">
            <Details {workspace} {node} config={workspace.config} nodes={workspace.nodes} onedit={edit} />

            {#if type?.attributes.length}
              <h4>Attributes</h4>
              <div class="attributes">
                {#each type.attributes as attribute (attribute.name)}
                  <label>
                    <span title={attribute.description}>{attribute.name.replace(/_/g, ' ')}</span>
                    <AttributeField
                      {attribute}
                      value={node.attributes[attribute.name]}
                      onchange={(value) => edit({ attributes: { [attribute.name]: value } })}
                    />
                  </label>
                {/each}
              </div>
            {/if}

            {#if node.kind === 'issue'}
              <Flag issue={node} onflag={(reason, comment) => void flag(reason, comment)} />

              <Neighbours
                nodes={workspace.nodes}
                config={workspace.config}
                upstream={links.upstream}
                downstream={links.downstream}
                rolledUpUpstream={links.rolledUpUpstream}
                rolledUpDownstream={links.rolledUpDownstream}
                onopen={openIssue}
                onunlink={unlink}
              />

              <Files files={node.relatedFiles} onchange={(files) => edit({ relatedFiles: files })} />
            {/if}
          </div>
        </section>

        {#if !stacked}
          <Splitter
            orientation="horizontal"
            size={commentsHeight}
            min={PANE_MIN}
            max={Math.max(PANE_MIN, sideHeight - PANE_MIN)}
            label="Resize the comments"
            onresize={resizeComments}
          />
        {/if}

        <section
          class="pane comments-pane"
          aria-label="Comments"
          style:flex-basis={stacked ? undefined : `${(1 - layout.split) * 100}%`}
        >
          <Comments id={node.id} fill={!stacked} bind:draft={commentDraft} onerror={(error) => workspace.report(error)} />
        </section>
      </div>
    </div>
  </div>

  {#if library}
    {#key library}
      <LibraryDialog initial={library.id} onclose={() => (library = null)} />
    {/key}
  {/if}

  {#if prompt}
    <Modal title={prompt.title} size="sm" onclose={() => (prompt = null)}>
      <p class="prompt-lead">If you continue, you lose:</p>
      <ul class="prompt-items">
        {#each prompt.items as item (item)}
          <li>{item}</li>
        {/each}
      </ul>
      {#snippet footer()}
        <Button onclick={() => (prompt = null)}>Keep editing</Button>
        <Button variant="danger" onclick={discardAndProceed}>{prompt!.discardLabel}</Button>
        {#if prompt!.saveLabel}
          <Button variant="primary" onclick={() => void saveAndProceed()}>{prompt!.saveLabel}</Button>
        {/if}
      {/snippet}
    </Modal>
  {/if}

  <Notices notices={workspace.notices} ondismiss={(id) => workspace.dismiss(id)} />
{/if}

<style>
  :global(html) {
    background: var(--surface-0);
  }
  :global(body) {
    background: var(--surface-0);
    margin: 0;
  }

  .popup-layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--surface-0);
  }

  /* -- Top bar ------------------------------------------------------------ */

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    flex: none;
  }

  .identity {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .icon {
    display: inline-flex;
    color: var(--ink-muted);
  }

  .id {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: var(--text-md);
    white-space: nowrap;
  }

  .type-label {
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--ink-muted);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
  }

  .save-status {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--ink-faint);
  }

  .tone-saved .dot {
    background: var(--tone-done);
  }

  .tone-unsaved {
    color: var(--warn);
  }

  .tone-unsaved .dot {
    background: var(--warn);
  }

  .tone-saving .dot {
    background: var(--accent);
    animation: pulse 1s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }

  .close {
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-muted);
    padding: 0.15rem 0.45rem;
  }

  .close:hover {
    border-color: var(--border);
    color: var(--ink);
  }

  /* -- Columns ------------------------------------------------------------ */

  .columns {
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--surface-1);
  }

  .body-pane {
    flex: 1;
  }

  .side {
    flex: none;
    width: var(--side-width);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .details-pane {
    flex: 1 1 0;
  }

  .comments-pane {
    flex: 0 0 50%;
    background: var(--surface-0);
  }

  .pane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex: none;
    min-height: 2.25rem;
    padding: var(--space-1) var(--space-4);
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }

  .pane-head h2 {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-muted);
  }

  .pane-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .pane-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  /* -- Description --------------------------------------------------------- */

  .rendered {
    padding: var(--space-4) var(--space-5) var(--space-6);
  }

  .rendered :global(.prose) {
    max-width: 52rem;
    font-size: var(--text-md);
    line-height: 1.65;
  }

  .rendered.preview {
    background: var(--surface-0);
  }

  .source {
    flex: 1;
    min-height: 0;
    width: 100%;
    margin: 0;
    padding: var(--space-4) var(--space-5);
    border: none;
    outline: none;
    background: var(--surface-0);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: 1.6;
    color: var(--ink);
    resize: none;
    tab-size: 2;
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

  /* -- Details ------------------------------------------------------------- */

  .details {
    padding: var(--space-3) var(--space-4) var(--space-4);
  }

  h4 {
    margin: var(--space-4) 0 var(--space-1);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }

  .attributes {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .attributes label {
    display: grid;
    grid-template-columns: 5.5rem 1fr;
    align-items: center;
    gap: var(--space-2);
  }

  .attributes label > span {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: capitalize;
  }

  /* -- A narrow window: one column that scrolls as a whole ----------------- */

  .columns.stacked {
    flex-direction: column;
    overflow-y: auto;
  }

  .stacked .pane,
  .stacked .side {
    flex: none;
    width: auto;
    min-height: auto;
  }

  .stacked .pane + .pane,
  .stacked .side {
    border-top: 1px solid var(--border);
  }

  .stacked .pane-scroll {
    overflow: visible;
  }

  .stacked .comments-pane {
    padding: 0 var(--space-4) var(--space-4);
  }

  .stacked .source {
    min-height: 60vh;
  }

  /* -- Prompt and states --------------------------------------------------- */

  .prompt-lead {
    margin: 0 0 var(--space-2);
  }

  .prompt-items {
    margin: 0;
    padding-left: 1.2rem;
    line-height: 1.55;
  }

  .loading,
  .failure {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    height: 100vh;
    color: var(--ink-muted);
  }

  .failure h1 {
    margin: 0;
    font-size: var(--text-lg);
    color: var(--ink);
  }
</style>
