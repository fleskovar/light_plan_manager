<script lang="ts">
  import type { ViewSummary } from '$shared';

  /**
   * One saved view in the landing page's list.
   *
   * Presentational — the parent owns the fetch/delete/save cycle.
   */
  interface Props {
    view: ViewSummary;
    when: string;
    onopen: (id: string) => void;
    onremove: (id: string) => void;
  }

  let { view, when, onopen, onremove }: Props = $props();
</script>

<li>
  <button class="open" type="button" onclick={() => onopen(view.id)}>
    <span class="name">
      {view.name}
      {#if view.mode === 'templates'}<span class="badge">registry</span>{/if}
    </span>
    <span class="meta">
      {view.members}
      {view.mode === 'templates' ? 'template' : 'issue'}{view.members === 1 ? '' : 's'} · saved {when}
    </span>
    {#if view.pendingChanges}
      <span class="pending">{view.pendingChanges} unpushed</span>
    {/if}
  </button>
  <button
    class="discard"
    type="button"
    title="Delete this view"
    aria-label="Delete {view.name}"
    onclick={() => onremove(view.id)}
  >
    ×
  </button>
</li>

<style>
  li {
    position: relative;
    display: flex;
    align-items: stretch;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    transition:
      border-color var(--duration-fast),
      background var(--duration-fast);
  }

  li:hover {
    border-color: var(--accent);
    background: var(--surface-1);
  }

  .open {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: var(--space-3);
    border: none;
    background: none;
    text-align: left;
    border-radius: var(--radius-md);
  }

  .name {
    font-size: var(--text-md);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  /* A registry view is a different thing to open, so it says so in the list. */
  .badge {
    margin-left: var(--space-2);
    padding: 0 0.4rem;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: var(--text-xs);
    font-weight: 600;
    vertical-align: middle;
  }

  .pending {
    align-self: flex-start;
    margin-top: var(--space-1);
    padding: 0 0.4rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--warn) 18%, transparent);
    color: var(--warn);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .discard {
    flex: none;
    width: 2rem;
    border: none;
    background: none;
    color: var(--ink-faint);
    font-size: var(--text-lg);
    line-height: 1;
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
  }

  .discard:hover {
    background: var(--tone-blocked-soft);
    color: var(--danger);
  }
</style>
