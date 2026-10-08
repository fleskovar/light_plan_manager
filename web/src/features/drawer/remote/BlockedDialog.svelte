<script lang="ts">
  import Modal from '$lib/ui/Modal.svelte';
  import { useRemoteState } from './remote.svelte.js';

  /**
   * What this remote cannot store, and what would change that — in a window of
   * its own rather than on the panel.
   *
   * These are rarely defects and often facts: a board assigns work to a pool
   * and no tracker has pools, a person has no account on the platform, a field
   * has nowhere to go. Most of them will not be closed this week and some never
   * will, so a section sitting open under the counts reads as an outstanding
   * problem every time anybody opens the tab — which is how a true list becomes
   * a list people learn to ignore. The chip still carries the number, because
   * the fact is worth having; the explanation is one click away, for the
   * afternoon somebody decides to deal with it.
   *
   * Presentational, like the rest of the drawer: the grouping by cause, the
   * remedies and the counts are all decided in `remote.svelte.ts`.
   */
  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  const remote = useRemoteState();
  const groups = $derived(remote.blockedGroups);
  const documents = $derived(remote.countOf('blocked'));
</script>

<Modal title="Unsupported values" size="lg" {onclose}>
  <p class="lead">
    <strong>{documents}</strong>
    {documents === 1 ? 'edit' : 'edits'} can't be pushed. The tracker has no field for these values.
  </p>

  <ul class="causes">
    {#each groups as group (group.key)}
      <li class="cause">
        <p class="cause-head">
          <span class="field">{group.field}</span>
          <span class="reason">{group.reason}</span>
          <span class="spacer"></span>
          <span class="affects">
            {group.localIds.length}
            {group.localIds.length === 1 ? 'document' : 'documents'}
          </span>
        </p>
        {#if group.remedy}
          <p class="remedy">{group.remedy}</p>
        {/if}
        <p class="ids">
          <button
            type="button"
            class="link"
            onclick={() => {
              remote.selectDocuments(group.localIds);
              onclose();
            }}
          >
            Show {group.localIds.length === 1 ? 'it' : 'them'} on the canvas
          </button>
          <span class="faint">
            {group.localIds.slice(0, 6).join(', ')}{group.localIds.length > 6
              ? `, +${group.localIds.length - 6} more`
              : ''}
          </span>
        </p>
      </li>
    {/each}
  </ul>
</Modal>

<style>
  .lead {
    margin: 0 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--ink-muted);
    line-height: 1.5;
  }

  .lead strong {
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }

  .causes {
    margin: 0;
    padding: 0;
    list-style: none;
    border-top: 1px solid var(--surface-2);
  }

  .cause {
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--surface-2);
  }

  .cause:last-child {
    border-bottom: none;
  }

  .cause-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
  }

  /* The document count is the *size* of a cause, not its importance, so it sits
     at the end in the quiet type rather than leading the row. */
  .cause-head .affects {
    flex: none;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--ink-faint);
  }

  .cause-head .field {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--ink-faint);
  }

  .cause-head .reason {
    color: var(--ink-muted);
  }

  .spacer {
    flex: 1;
  }

  .remedy {
    margin: 0.25rem 0 0;
    font-size: var(--text-xs);
    color: var(--ink);
  }

  .ids {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0.3rem 0 0;
    font-size: var(--text-xs);
    min-width: 0;
  }

  .ids .link {
    border: none;
    background: none;
    padding: 0;
    font-size: var(--text-xs);
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 2px;
    white-space: nowrap;
  }

  .ids .faint {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-faint);
  }
</style>
