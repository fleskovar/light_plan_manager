<script lang="ts">
  import { DEFAULT_PANEL_WIDTH } from '$shared';
  import { useShell } from '$lib/app/shell.svelte.js';
  import { neighbours } from '$lib/board/links.js';
  import { childrenOf } from '$lib/board/selectors.js';
  import AttributeField from '$lib/ui/fields/AttributeField.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Markdown from '$lib/ui/Markdown.svelte';
  import { paneScale } from '$lib/ui/scale.js';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import {
    editNode,
    removeDependency,
    removeNodes,
  } from '$lib/workspace/mutations.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import { useRemoteState } from '$features/drawer/remote/remote.svelte.js';
  import Comments from './sections/Comments.svelte';
  import Conflicts from './sections/Conflicts.svelte';
  import Details from './sections/Details.svelte';
  import Files from './sections/Files.svelte';
  import Flag from './sections/Flag.svelte';
  import Neighbours from './sections/Neighbours.svelte';
  import Remote from './sections/Remote.svelte';
  import Params from './sections/Params.svelte';

  /**
   * Everything about the selected document, in one column: its fields, its
   * declared attributes, its body, and a step in each direction along the graph.
   * Pinning keeps it open while you click around the canvas.
   */
  const workspace = useWorkspace();
  const shell = useShell();
  /** Tracker remotes are experimental: their two sections need `lpm ui --experimental`. */
  const remote = useRemoteState();

  const node = $derived(
    workspace.selection.primary ? workspace.node(workspace.selection.primary) : undefined,
  );

  /**
   * The body reads as markdown and is edited as source. Editing is per node:
   * clicking away to another issue puts the panel back in reading mode, which
   * is the mode you want nine times out of ten.
   */
  let editingBody = $state<string | null>(null);
  /** When true every section except the body is hidden, giving it the full panel. */
  let expandedBody = $state(false);
  const editing = $derived(node !== undefined && editingBody === node.id);
  const type = $derived(node ? workspace.config.types[node.type] : undefined);
  const links = $derived(
    node
      ? neighbours(workspace.nodes, node.id)
      : { upstream: [], downstream: [], rolledUpUpstream: [], rolledUpDownstream: [] },
  );
  function edit(patch: Record<string, unknown>): void {
    if (node) editNode(workspace, node.id, patch);
  }

  function close(): void {
    workspace.doc.panel.open = false;
    workspace.scheduleSave();
  }

  function togglePin(): void {
    workspace.doc.panel.pinned = !workspace.doc.panel.pinned;
    workspace.scheduleSave();
  }

  function unlink(other: string, direction: 'upstream' | 'downstream'): void {
    if (!node) return;
    if (direction === 'upstream') removeDependency(workspace, node.id, other);
    else removeDependency(workspace, other, node.id);
  }
</script>

<!-- `ui-scale`: a panel dragged wider reads at a size that uses the width. -->
<aside
  class="panel ui-scale"
  aria-label="Details"
  style="width: {workspace.doc.panel.width}px; --ui-scale: {paneScale(
    workspace.doc.panel.width,
    DEFAULT_PANEL_WIDTH,
  )}"
>
  <header>
    {#if node}
      <span class="icon"><TypeIcon type={node.type} depth={node.depth} size={16} /></span>
      <span class="id">{node.id}</span>
      <span class="type">{type?.label ?? node.type}</span>
    {:else}
      <span class="type">Nothing selected</span>
    {/if}
    <div class="spacer"></div>
    <button
      class="chip"
      class:on={workspace.doc.panel.pinned}
      type="button"
      title="Keep the panel open"
      onclick={togglePin}
    >
      Pin
    </button>
    <button class="chip" type="button" title="Close" onclick={close}>×</button>
  </header>

  {#if !node}
    <p class="empty">Select a node on the canvas, in the table or in the Gantt chart.</p>
  {:else}
    <div class="body" class:expanded={expandedBody}>
      {#if !expandedBody}
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

        {#if node.kind === 'template'}
          <h4>Description</h4>
          <textarea
            class="description"
            rows="2"
            value={node.description}
            placeholder="What this template is for"
            onchange={(event) => edit({ description: event.currentTarget.value })}
          ></textarea>

          {#key node.id}
            <Params
              params={node.params}
              root={node.root}
              onchange={(params) => edit({ params })}
            />
          {/key}
        {/if}

        {#if node.kind === 'issue' || node.kind === 'template'}
          <Files files={node.relatedFiles} onchange={(files) => edit({ relatedFiles: files })} />
        {/if}

        {#if node.kind === 'issue'}
          <!-- Written straight to disk, not queued: see `Workspace.setFlag`. -->
          <Flag
            issue={node}
            onflag={(reason, comment) => void workspace.setFlag(node.id, reason, comment)}
          />

          <!-- The two sides of a conflicted twin, resolved here and applied by
               the next Sync. The remote link is shown whenever the node is linked. -->
          {#if remote.enabled}
            <Remote id={node.id} hasChildren={childrenOf(workspace.nodes, node.id).length > 0} />

            <Conflicts id={node.id} />
          {/if}
        {/if}

        {#if node.kind === 'issue' || node.kind === 'template'}
          <Neighbours
            nodes={workspace.nodes}
            config={workspace.config}
            upstream={links.upstream}
            downstream={links.downstream}
            rolledUpUpstream={links.rolledUpUpstream}
            rolledUpDownstream={links.rolledUpDownstream}
            onopen={(id) => workspace.selection.focus(id)}
            onunlink={unlink}
          />
        {/if}
      {/if}

      <div class="section-head">
        <h4>Body</h4>
        <div class="section-head-actions">
          <button
            class="chip"
            type="button"
            title={editing ? 'Show the rendered body' : 'Edit the markdown source'}
            onclick={() => (editingBody = editing ? null : node.id)}
          >
            {editing ? 'Done' : 'Edit'}
          </button>
          <button
            class="chip"
            type="button"
            title={expandedBody ? 'Show all sections' : 'Expand body'}
            onclick={() => (expandedBody = !expandedBody)}
          >
            {expandedBody ? 'Collapse' : 'Expand'}
          </button>
        </div>
      </div>
      {#if editing}
        <textarea
          class="markdown"
          class:expanded={expandedBody}
          rows={expandedBody ? undefined : 12}
          value={node.body}
          onchange={(event) => edit({ body: event.currentTarget.value })}
        ></textarea>
      {:else}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class="rendered"
          class:expanded={expandedBody}
          ondblclick={() => (editingBody = node.id)}
          title="Double-click to edit"
        >
          <Markdown source={node.body} />
        </div>
      {/if}

      {#if !expandedBody}
        <Comments id={node.id} onerror={(error) => workspace.report(error)} />

        <div class="actions">
          {#if node.kind === 'issue'}
            <Button size="sm" onclick={() => shell.openBreakdown(node.id)}>Break down…</Button>
          {/if}
          {#if workspace.isMember(node.id)}
            <Button size="sm" onclick={() => workspace.removeMembers([node.id])}>
              Remove from view
            </Button>
          {:else if node.kind === 'issue' || node.kind === 'template'}
            <Button size="sm" onclick={() => workspace.addMembers([node.id])}>Add to view</Button>
          {/if}
          <Button
            size="sm"
            variant="danger"
            onclick={() =>
              shell.confirm({
                title: 'Delete from the board?',
                message: `${node.id} and its children will be deleted on push.`,
                confirmLabel: 'Delete',
                danger: true,
                onConfirm: () => removeNodes(workspace, [node.id]),
              })}
          >
            Delete
          </Button>
        </div>
      {/if}
    </div>
  {/if}
</aside>

<style>
  /*
   * The panel is the one part of the shell that is *about* one thing, so it
   * reads as a surface laid over the rest rather than as another region of it:
   * a heavier edge, a shadow, and a background a step away from the canvas and
   * the drawer. Its own fields go back to the lightest surface so they stay
   * legible against it.
   */
  .panel {
    display: flex;
    flex-direction: column;
    flex: none;
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--border-strong);
    background: var(--surface-2);
    box-shadow: var(--shadow-md);
    z-index: 1;
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-strong);
    background: var(--surface-3);
  }

  /* Fields and cards inside the panel sit on the light surface. */
  .panel :global(input),
  .panel :global(select),
  .panel :global(textarea) {
    background: var(--surface-1);
  }

  .panel :global(input[type='checkbox']) {
    background: none;
  }

  .icon {
    display: inline-flex;
    color: var(--ink-muted);
  }

  .id {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: var(--text-sm);
  }

  .type {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .spacer {
    flex: 1;
  }

  .chip {
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-muted);
    font-size: var(--text-xs);
    padding: 0.1rem 0.35rem;
  }

  .chip.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--ink);
  }

  .body {
    flex: 1;
    overflow: auto;
    padding: var(--space-3);
  }

  /* In expanded mode the body container itself stretches everything inside. */
  .body.expanded {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  h4 {
    margin: var(--space-4) 0 var(--space-1);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-muted);
  }

  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    flex: none;
  }

  .section-head-actions {
    display: flex;
    gap: var(--space-1);
  }

  .rendered {
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
  }

  /* When expanded the body fills the panel, so the rendered block and
     textarea grow to use all the remaining space. */
  .rendered.expanded {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .description {
    width: 100%;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    line-height: 1.5;
    resize: vertical;
    box-sizing: border-box;
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

  .markdown {
    width: 100%;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.6;
    resize: vertical;
    box-sizing: border-box;
  }

  .markdown.expanded {
    flex: 1;
    min-height: 0;
    resize: none;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  .empty {
    padding: var(--space-5) var(--space-4);
    color: var(--ink-muted);
    font-size: var(--text-sm);
    text-align: center;
  }
</style>
