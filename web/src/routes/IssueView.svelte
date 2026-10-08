<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { neighbours } from '$lib/board/links.js';
  import AttributeField from '$lib/ui/fields/AttributeField.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Markdown from '$lib/ui/Markdown.svelte';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import Notices from '$lib/ui/Notices.svelte';
  import { editNode, removeDependency } from '$lib/workspace/mutations.js';
  import {
    Workspace,
    provideWorkspace,
    useWorkspace,
  } from '$lib/workspace/workspace.svelte.js';
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
   * The body is the main focus — the details and other sections are stacked
   * above and below it in a single scrolling column designed for reading and
   * comparing issues side by side.
   */
  interface Props {
    nodeId: string;
    viewId: string;
  }

  let { nodeId, viewId }: Props = $props();

  const workspace = provideWorkspace(new Workspace());

  let ready = $state(false);
  let failed = $state(false);

  onMount(() => {
    workspace.open(viewId).then(() => (ready = true)).catch(() => (failed = true));
    document.title = `${nodeId} — light-plan`;
    // Edits push themselves now; this is what still tells the opener to
    // pull, the way the old manual Push button did.
    workspace.onPushed = () => {
      window.opener?.postMessage({ type: 'lpm:pushed', nodeId }, window.location.origin);
    };
  });

  onDestroy(() => workspace.dispose());

  const node = $derived(workspace.node(nodeId));
  const type = $derived(node ? workspace.config.types[node.type] : undefined);
  const links = $derived(
    node
      ? neighbours(workspace.nodes, node.id)
      : { upstream: [], downstream: [], rolledUpUpstream: [], rolledUpDownstream: [] },
  );
  let editingBody = $state(false);
  let expandedBody = $state(false);

  function edit(patch: Record<string, unknown>): void {
    if (node) editNode(workspace, node.id, patch);
  }

  function unlink(other: string, direction: 'upstream' | 'downstream'): void {
    if (!node) return;
    if (direction === 'upstream') removeDependency(workspace, node.id, other);
    else removeDependency(workspace, other, node.id);
  }

  /** The window was opened as a popup — is there an opener to go back to? */
  const hasOpener = $state(typeof window !== 'undefined' && Boolean(window.opener));
</script>

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
    <!-- Header: identity and type. Edits push themselves — see workspace.svelte.ts. -->
    <header>
      <div class="header-left">
        <span class="icon"><TypeIcon type={node.type} depth={node.depth} size={16} /></span>
        <span class="id">{node.id}</span>
        <span class="type-label">{type?.label ?? node.type}</span>
      </div>
      <div class="header-right">
        {#if hasOpener}
          <button class="chip" type="button" title="Close this window" onclick={() => window.close()}>
            ✕
          </button>
        {/if}
      </div>
    </header>

    <div class="body" class:expanded={expandedBody}>
      {#if !expandedBody}
        <!-- Details: title, type, status, assignee, period, parent. -->
        <Details {workspace} {node} config={workspace.config} nodes={workspace.nodes} onedit={edit} />

        <!-- Attributes declared on this type. -->
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
          <Files files={node.relatedFiles} onchange={(files) => edit({ relatedFiles: files })} />

          <Flag
            issue={node}
            onflag={(reason, comment) => void workspace.setFlag(node.id, reason, comment)}
          />
        {/if}
      {/if}

      <!-- Body: the main reading space. Editing is inline, same as the side panel. -->
      <div class="section-head">
        <h4>Body</h4>
        <div class="section-head-actions">
          <button
            class="chip"
            type="button"
            title={editingBody ? 'Show the rendered body' : 'Edit the markdown source'}
            onclick={() => (editingBody = !editingBody)}
          >
            {editingBody ? 'Done' : 'Edit'}
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
      {#if editingBody}
        <textarea
          class="markdown"
          class:expanded={expandedBody}
          rows={expandedBody ? undefined : 20}
          value={node.body}
          onchange={(event) => edit({ body: event.currentTarget.value })}
        ></textarea>
      {:else}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class="rendered"
          class:expanded={expandedBody}
          ondblclick={() => (editingBody = true)}
          title="Double-click to edit"
        >
          <Markdown source={node.body} />
        </div>
      {/if}

      {#if !expandedBody}
        {#if node.kind === 'issue'}
          <Neighbours
            nodes={workspace.nodes}
            config={workspace.config}
            upstream={links.upstream}
            downstream={links.downstream}
            rolledUpUpstream={links.rolledUpUpstream}
            rolledUpDownstream={links.rolledUpDownstream}
            onopen={(id) => {
              // Open another popup: navigate this window to the new issue.
              const base = location.href.replace(/#.*$/, '');
              location.href = `${base}#/issue/${encodeURIComponent(id)}?view=${encodeURIComponent(viewId)}`;
            }}
            onunlink={unlink}
          />

        {/if}

        <Comments id={node.id} onerror={(error) => workspace.report(error)} />

        <!-- Actions at the bottom. -->
        <div class="actions">
          {#if node.kind === 'issue' && hasOpener}
            <Button size="sm" onclick={() => {
              window.opener?.postMessage({ type: 'lpm:open', nodeId }, window.location.origin);
            }}>Focus in main window</Button>
          {/if}
        </div>
      {/if}
    </div>
  </div>

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

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    flex: none;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .icon {
    display: inline-flex;
    color: var(--ink-muted);
  }

  .id {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: var(--text-md);
  }

  .type-label {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .chip {
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-muted);
    font-size: var(--text-xs);
    padding: 0.1rem 0.35rem;
  }

  .body {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-4);
    max-width: 860px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }

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
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    min-height: 6rem;
  }

  .rendered.expanded {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
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
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.6;
    color: var(--ink);
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
    margin-top: var(--space-5);
    padding-bottom: var(--space-4);
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
