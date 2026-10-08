<script lang="ts">
  import type { ConfigDto, IssueDto } from '$shared';
  import StatusChip from '$lib/ui/StatusChip.svelte';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';

  /**
   * One scheduled issue inside a period box.
   *
   * Presentational: the box that owns it supplies the callbacks and decides
   * whether to show the unschedule button.  It is always draggable — the
   * card is how issues are carried from one box to another.
   */
  interface Props {
    issue: IssueDto;
    config: ConfigDto;
    selected: boolean;
    canUnschedule: boolean;
    onopen: (id: string) => void;
    onunschedule: (id: string) => void;
  }

  let { issue, config, selected, canUnschedule, onopen, onunschedule }: Props = $props();
</script>

<article
  class="card"
  class:selected
  draggable="true"
  style="--indent: {Math.min(issue.depth, 4)}"
  ondragstart={(event) => {
    event.dataTransfer?.setData('application/x-lpm-issue', issue.id);
    event.dataTransfer?.setData('text/plain', issue.title);
  }}
>
  <button class="open" type="button" onclick={() => onopen(issue.id)}>
    <span class="icon"><TypeIcon type={issue.type} depth={issue.depth} /></span>
    <span class="id">{issue.id}</span>
    <span class="text">{issue.title}</span>
  </button>
  <StatusChip {config} status={issue.status} />
  {#if canUnschedule}
    <button
      class="remove"
      type="button"
      title="Take it out of this period"
      aria-label="Unschedule {issue.id}"
      onclick={() => onunschedule(issue.id)}
    >
      ×
    </button>
  {/if}
</article>

<style>
  .card {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-left: calc(var(--indent) * 0.4rem);
    padding: 0.2rem 0.3rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    cursor: grab;
  }

  .card.selected {
    outline: 2px solid var(--accent);
  }

  .open {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    padding: 0;
    font-size: var(--text-xs);
    text-align: left;
  }

  .id {
    font-family: var(--font-mono);
    color: var(--ink-muted);
  }

  .text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .icon {
    display: inline-flex;
    color: var(--ink-muted);
  }

  .remove {
    flex: none;
    border: none;
    background: none;
    color: var(--ink-faint);
    line-height: 1;
    padding: 0 0.15rem;
  }

  .remove:hover {
    color: var(--danger);
  }
</style>
