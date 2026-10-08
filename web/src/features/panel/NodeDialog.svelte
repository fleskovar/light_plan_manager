<script lang="ts">
  import { onMount } from 'svelte';
  import type { ConfigDto, IssueDto, NodeDto } from '$shared';
  import { flagLabel } from '$shared';
  import { dependentsIndex, statusTone } from '$lib/board/selectors.js';
  import { rolledUpEffort } from '$lib/board/selectors.js';
  import Markdown from '$lib/ui/Markdown.svelte';
  import Button from '$lib/ui/Button.svelte';
  import type { WorkingNodes } from '$lib/board/working.js';

  interface Props {
    node: NodeDto;
    nodes: WorkingNodes;
    config: ConfigDto;
    /** Plain-text only — set true for the viewer. */
    plainText?: boolean;
    /** Called when the dialog is closed (Esc, backdrop click, or close button). */
    onclose?: () => void;
  }

  let { node, nodes, config, plainText = false, onclose = undefined }: Props = $props();

  let dialog: HTMLDialogElement;

  onMount(() => {
    dialog.showModal();
  });

  function close(): void {
    dialog.close();
    onclose?.();
  }

  function onBackdropClick(event: MouseEvent): void {
    if (event.target === dialog) close();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
  }

  const issue = $derived(node.kind === 'issue' ? (node as IssueDto) : null);
  // "What does this block?" is the derived inverse of depends_on, never a field
  // on the document: only forward edges are stored.
  const dependents = $derived(dependentsIndex(nodes)[node.id] ?? []);
  const typeDef = $derived(node.type ? config.types[node.type] : null);
  const typeDisplayName = $derived(typeDef?.label ?? node.type ?? '');
  const effort = $derived(
    node.kind === 'issue' && config.effortAttribute
      ? rolledUpEffort(nodes, config, node.id, undefined)
      : 0,
  );

  $effect(() => {
    dialog && node; // re-open when node changes
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<dialog
  bind:this={dialog}
  class="node-dialog"
  onclick={onBackdropClick}
  onkeydown={onKeyDown}
>
  <div class="dialog-content">
    <header>
      <div class="header-left">
        <span class="id">{node.id}</span>
        <span class="type">{typeDisplayName}</span>
      </div>
      <Button size="sm" onclick={close}>✕</Button>
    </header>

    <h2>{node.title}</h2>

    {#if issue}
      <div class="meta">
        {#if issue.status}
          <span class="status tone-{statusTone(config, issue.status)}">
            {issue.status}
          </span>
        {/if}
        {#if issue.flag}
          <span class="flag">⚠ {flagLabel(issue.flag)}</span>
        {/if}
        {#if effort > 0}
          <span class="effort">{effort} {config.effortAttribute}</span>
        {/if}
        {#if issue.period}
          <span class="period">{issue.period}</span>
        {/if}
        {#if issue.assignee}
          <span class="assignee">{issue.assignee}</span>
        {/if}
      </div>

      {#if issue.dependsOn && issue.dependsOn.length > 0}
        <div class="links">
          <span class="label">Blocked by:</span>
          {#each issue.dependsOn as dep}
            <span class="link">{dep}</span>
          {/each}
        </div>
      {/if}

      {#if dependents.length > 0}
        <div class="links">
          <span class="label">Blocks:</span>
          {#each dependents as dep}
            <span class="link">{dep}</span>
          {/each}
        </div>
      {/if}

      {#if issue.relatedFiles && issue.relatedFiles.length > 0}
        <div class="links">
          <span class="label">Files:</span>
          {#each issue.relatedFiles as file}
            <span class="link">{file}</span>
          {/each}
        </div>
      {/if}

      {#if issue.attributes && Object.keys(issue.attributes).length > 0}
        <div class="links">
          <span class="label">Attributes:</span>
          {#each Object.entries(issue.attributes) as [name, value]}
            <span class="link">{name}: {String(value)}</span>
          {/each}
        </div>
      {/if}
    {/if}

    <div class="body">
      {#if plainText}
        <pre>{node.body}</pre>
      {:else}
        <Markdown source={node.body} />
      {/if}
    </div>
  </div>
</dialog>

<style>
  dialog {
    border: none;
    border-radius: 8px;
    padding: 0;
    max-width: 640px;
    width: 90vw;
    max-height: 80vh;
    background: var(--color-surface, #fff);
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
  }
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.3);
  }
  .dialog-content {
    padding: 1.25rem;
    overflow-y: auto;
    max-height: 80vh;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  .header-left {
    display: flex;
    gap: 0.5rem;
  }
  .id {
    font-family: monospace;
    color: var(--color-dim, #888);
    font-size: 0.875rem;
  }
  .type {
    font-size: 0.75rem;
    text-transform: uppercase;
    color: var(--color-dim, #888);
    letter-spacing: 0.05em;
  }
  h2 {
    margin: 0 0 0.75rem;
    font-size: 1.25rem;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  .meta span {
    font-size: 0.8rem;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background: var(--color-bg, #f0f0f0);
  }
  .flag {
    background: #fee2e2 !important;
    color: #b91c1c;
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
    font-size: 0.8rem;
  }
  .label {
    color: var(--color-dim, #888);
    margin-right: 0.25rem;
  }
  .link {
    font-family: monospace;
    font-size: 0.75rem;
    background: var(--color-bg, #f0f0f0);
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
  }
  .body {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border, #e0e0e0);
    font-size: 0.9rem;
    line-height: 1.6;
  }
  .body :global(pre) {
    white-space: pre-wrap;
    font-size: 0.85rem;
    line-height: 1.5;
  }
</style>
