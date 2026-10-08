<script lang="ts">
  import type { RemoteResolveOwner } from '$shared';
  import { formatValue, useRemoteState } from '$features/drawer/remote/remote.svelte.js';

  /**
   * A conflicted document's two sides, side by side, with a choice per field.
   *
   * Presentational: it asks the remote state machine what to show and tells it
   * what was chosen. Recording a choice is offline — the next Sync applies it —
   * so clicking a side never fires a request at the remote itself.
   *
   * The twin's link and the Push / Pull buttons live in `Remote.svelte`, which
   * is rendered above this: that section is about where a document *is*, this
   * one only about the case where the two sides disagree.
   */
  interface Props {
    id: string;
  }

  let { id }: Props = $props();

  const remote = useRemoteState();

  /** The report for the remote driving the canvas badges, when read. */
  const report = $derived(remote.badgeRemote ? (remote.reports[remote.badgeRemote] ?? null) : null);
  /** True when this node is conflicted on the badge remote. */
  const conflicted = $derived(report !== null && report.conflicted.includes(id));
  /** The detail the state machine fetched, when it is about this node. */
  const detail = $derived(remote.conflictFor === id ? remote.conflictDetail : null);

  $effect(() => {
    if (conflicted) {
      void remote.loadConflict(id);
    } else if (remote.conflictFor === id) {
      remote.clearConflict();
    }
  });

  function choose(field: string, owner: RemoteResolveOwner): void {
    void remote.chooseField(field, owner);
  }

  function chooseAll(owner: RemoteResolveOwner): void {
    void remote.chooseDefault(owner);
  }
</script>

{#if conflicted}
  <h4>Sync conflict</h4>
  {#if remote.conflictLoading && detail === null}
    <p class="hint">Loading…</p>
  {:else if detail === null}
    <p class="hint">Could not load the conflicting values.</p>
  {:else}
    <div class="conflict">
      <p class="hint">
        Choose a value per field. The next sync applies it.
      </p>

      <div class="all">
        <button type="button" class="take-all" onclick={() => chooseAll('local')}>All local</button>
        <button type="button" class="take-all" onclick={() => chooseAll('remote')}>All remote</button>
      </div>

      {#each detail.fields as field (field.field)}
        <div class="field">
          <div class="field-name">{field.field}</div>
          <div class="sides">
            <button
              type="button"
              class="side"
              class:chosen={field.chosen === 'local'}
              title="Keep the board value"
              onclick={() => choose(field.field, 'local')}
            >
              <span class="side-label">Local</span>
              <span class="value">{formatValue(field.local)}</span>
            </button>
            <button
              type="button"
              class="side"
              class:chosen={field.chosen === 'remote'}
              title="Use the remote value"
              onclick={() => choose(field.field, 'remote')}
            >
              <span class="side-label">Remote</span>
              <span class="value">{formatValue(field.remote)}</span>
            </button>
          </div>
        </div>
      {/each}

      {#if remote.conflictSaving}
        <p class="hint" aria-live="polite">Recording…</p>
      {/if}
    </div>
  {/if}
{/if}

<style>
  h4 {
    margin: var(--space-4) 0 var(--space-1);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }

  .hint {
    margin: 0 0 var(--space-2);
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .conflict {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .all {
    display: flex;
    gap: var(--space-1);
    margin-bottom: var(--space-1);
  }

  .take-all {
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .take-all:hover {
    border-color: var(--accent);
    color: var(--ink);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .field-name {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--ink-muted);
    text-transform: capitalize;
  }

  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-1);
  }

  .side {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    align-items: flex-start;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    text-align: left;
  }

  .side.chosen {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .side-label {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--ink-muted);
  }

  .side.chosen .side-label {
    color: var(--ink);
  }

  .value {
    font-size: var(--text-sm);
    color: var(--ink);
    word-break: break-word;
  }
</style>
