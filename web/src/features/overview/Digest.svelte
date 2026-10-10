<script lang="ts">
  import type { BoardSnapshot, IssueDto } from '$shared';
  import { allNodes } from '$shared';
  import StatusChip from '$lib/ui/StatusChip.svelte';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import { currentFocus, latestIssues, openPathways } from './digest.js';
  import { buildIndex } from '$lib/board/index.js';

  /**
   * What is going on on the board, for the overview dialog.
   *
   * Three readings of the same board: the sprint that is running, what has just
   * been written, and what the dependency graph says could be started. All the
   * judgement is in `digest.ts`; this only lays it out.
   */
  interface Props {
    board: BoardSnapshot;
    /** Injected by tests and by nothing else. */
    today?: string;
  }

  let { board, today }: Props = $props();

  const nodes = $derived(Object.fromEntries(allNodes(board).map((node) => [node.id, node])));
  const config = $derived(board.config);
  const index = $derived(buildIndex(nodes));

  const focus = $derived(currentFocus(nodes, config, { today }, index));
  const latest = $derived(latestIssues(nodes));
  const pathways = $derived(openPathways(nodes, config));

  const label = (type: string): string => config.types[type]?.label ?? type;
  const points = (value: number): string =>
    config.effortAttribute && value ? ` · ${value} ${config.effortAttribute.replace(/_/g, ' ')}` : '';

  const dates = (period: { starts?: string; ends?: string }): string =>
    [period.starts, period.ends].filter(Boolean).join(' → ');

  /** "2 days ago", roughly. The overview shows the age and not the timestamp. */
  function ago(iso: string | undefined): string {
    if (!iso) return '';
    const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
    if (!Number.isFinite(days)) return '';
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    const months = Math.round(days / 30);
    return months === 1 ? 'a month ago' : `${months} months ago`;
  }
</script>

{#snippet issueLine(issue: IssueDto, meta: string)}
  <li>
    <span class="icon"><TypeIcon type={issue.type} depth={issue.depth} /></span>
    <span class="id">{issue.id}</span>
    <span class="title" title={issue.title}>{issue.title}</span>
    <StatusChip {config} status={issue.status} />
    <span class="meta">{meta}</span>
  </li>
{/snippet}

<section class="card now">
  <h2>
    Now
    {#if focus.continuous}
      <span class="where"><strong>The whole board</strong><span class="when">one continuous queue</span></span>
    {:else if focus.sprint || focus.increment}
      <span class="where">
        {#if focus.increment}<strong>{focus.increment.title}</strong>{/if}
        {#if focus.sprint}<span class="sep">›</span><strong>{focus.sprint.title}</strong>{/if}
        <span class="when">{dates(focus.sprint ?? focus.increment!)}</span>
        {#if focus.upcoming}<span class="tag">upcoming</span>{/if}
      </span>
    {/if}
  </h2>

  {#if !focus.continuous && !focus.increment && !focus.sprint}
    <p class="hint">
      No current period. Add dates to a sprint.
    </p>
  {:else}
    <p class="hint">
      {focus.open} open{points(focus.effort)}
      {#if focus.active.length}· {focus.active.length} in progress{/if}
      {#if focus.blocked}· <span class="warn">{focus.blocked} blocked</span>{/if}
    </p>

    {#if focus.active.length}
      <h3>In progress</h3>
      <ul>
        {#each focus.active as entry (entry.issue.id)}
          {@render issueLine(
            entry.issue,
            `${entry.issue.assignee ? (nodes[entry.issue.assignee]?.title ?? entry.issue.assignee) : 'unassigned'}${points(entry.effort)}`,
          )}
        {/each}
      </ul>
    {/if}

    <h3>Ready to pick up</h3>
    {#if focus.ready.length}
      <ul>
        {#each focus.ready as entry (entry.issue.id)}
          {@render issueLine(
            entry.issue,
            `${entry.period && entry.period.id !== focus.sprint?.id ? `${entry.period.title} · ` : ''}${entry.unblocks ? `unblocks ${entry.unblocks}` : label(entry.issue.type)}${points(entry.effort)}`,
          )}
        {/each}
      </ul>
    {:else}
      <p class="hint">
        Nothing ready {focus.continuous ? 'on the board' : 'in this period'}{#if focus.blocked}; {focus.blocked} blocked{/if}.
      </p>
    {/if}
  {/if}
</section>

<section class="card added">
  <h2>Just added</h2>
  {#if !latest.length}
    <p class="hint">No issues yet.</p>
  {:else}
    <ul>
      {#each latest as issue (issue.id)}
        {@render issueLine(issue, `${label(issue.type)} · ${ago(issue.created ?? issue.updated)}`)}
      {/each}
    </ul>
  {/if}
</section>

<section class="card paths">
  <h2>
    Open pathways
    <span class="where"><span class="when">by dependencies</span></span>
  </h2>
  {#if !pathways.length}
    <p class="hint">
      No unblocked containers with open work.
    </p>
  {:else}
    <p class="hint">
      Unblocked containers, ordered by how much they unblock.
    </p>
    <ul>
      {#each pathways as pathway (pathway.issue.id)}
        {@render issueLine(
          pathway.issue,
          `${pathway.ready} of ${pathway.open} ready${points(pathway.effort)}${pathway.unblocks ? ` · unblocks ${pathway.unblocks}` : ''}${pathway.started ? ' · under way' : ''}`,
        )}
      {/each}
    </ul>
  {/if}
</section>

<style>
  /*
   * The three sections of the overview. The area names are the contract with
   * `OverviewDialog.svelte`, which defines the grid: `now` takes the full
   * width, and `added` and `paths` sit side by side under it.
   */
  .card {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: var(--space-4) var(--space-5);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
  }

  .now {
    grid-area: now;
  }

  .added {
    grid-area: added;
  }

  .paths {
    grid-area: paths;
  }

  h2 {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0 0 var(--space-3);
    font-size: var(--text-lg);
    letter-spacing: -0.01em;
  }

  .where {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1);
    font-size: var(--text-sm);
    font-weight: 400;
  }

  .sep,
  .when {
    color: var(--ink-faint);
  }

  .when {
    font-size: var(--text-xs);
  }

  .tag {
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--surface-3);
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  h3 {
    margin: var(--space-3) 0 var(--space-1);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-muted);
  }

  .hint {
    margin: 0;
    color: var(--ink-muted);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .warn {
    color: var(--warn);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
  }

  /*
   * The title is what the row is for, so it keeps its room and the meta gives
   * way — wrapping onto its own line in a narrow tile rather than squeezing the
   * title down to an ellipsis.
   */
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
    padding: 0.4rem 0;
    border-top: 1px solid var(--surface-2);
    font-size: var(--text-md);
  }

  li:first-child {
    border-top: none;
  }

  .icon {
    display: inline-flex;
    flex: none;
    color: var(--ink-muted);
  }

  .id {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .title {
    flex: 1 1 9rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    flex: none;
    margin-left: auto;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    white-space: nowrap;
  }
</style>
