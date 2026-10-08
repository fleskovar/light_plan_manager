<script lang="ts">
  import type { IssueDto } from '$shared';
  import StatusChip from '$lib/ui/StatusChip.svelte';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import { setStatus } from '$lib/workspace/mutations.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import { buildQueue, laneStatus, type Lane, type QueueCard } from './queue.js';

  /**
   * The board for a team that does not plan in sprints.
   *
   * Same shape as the periods view — lanes of cards you drag between — but the
   * lanes come from the dependency graph rather than from the calendar: what
   * can be started, what is being worked on, and what is waiting on something
   * else. Dropping a card is one status change, exactly as dropping a card in
   * the periods view is one `period` change.
   *
   * `lpm task next` in the terminal answers the same question with the same
   * ordering; this is that answer with somewhere to put your hands.
   */
  const workspace = useWorkspace();

  let search = $state('');
  let hovering = $state<Lane | null>(null);

  const queue = $derived(buildQueue(workspace.nodes, workspace.config, { search }, workspace.index));

  const lanes = $derived([
    {
      id: 'ready' as const,
      label: 'Ready',
      hint: 'Ready to start',
      cards: queue.ready,
    },
    {
      id: 'active' as const,
      label: 'In progress',
      hint: 'Being worked on',
      cards: queue.active,
    },
    {
      id: 'blocked' as const,
      label: 'Blocked',
      hint: 'Waiting on unfinished work',
      cards: queue.blocked,
    },
  ]);

  /** Dropping into a lane is a status change, and only two lanes take a drop. */
  function drop(lane: Lane, event: DragEvent): void {
    const id = event.dataTransfer?.getData('application/x-lpm-issue');
    hovering = null;
    if (!id || lane === 'blocked') return;
    event.preventDefault();
    const status = laneStatus(workspace.config, lane);
    if (status) setStatus(workspace, [id], status);
  }

  function start(issue: IssueDto): void {
    const status = laneStatus(workspace.config, 'active');
    if (status) setStatus(workspace, [issue.id], status);
  }

  function finish(issue: IssueDto): void {
    const status = laneStatus(workspace.config, 'done');
    if (status) setStatus(workspace, [issue.id], status);
  }

  const effortLabel = (card: QueueCard): string =>
    workspace.config.effortAttribute && card.effort ? `${card.effort}` : '';
</script>

<div class="queue">
  <div class="toolbar">
    <input
      class="search"
      bind:value={search}
      placeholder="Filter by title, id or type"
      aria-label="Filter issues"
    />
    <span class="hint">
      {queue.ready.length} ready · {queue.active.length} in progress · {queue.blocked.length} blocked
    </span>
    <span class="spacer"></span>
    <span class="hint">Drag a card to start or finish it.</span>
  </div>

  <div class="lanes">
    {#each lanes as lane (lane.id)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <section
        class="lane {lane.id}"
        class:over={hovering === lane.id}
        ondragover={(event) => {
          if (lane.id === 'blocked') return;
          event.preventDefault();
          hovering = lane.id;
        }}
        ondragleave={() => (hovering = null)}
        ondrop={(event) => drop(lane.id, event)}
      >
        <header>
          <h3>{lane.label}</h3>
          <span class="count">{lane.cards.length}</span>
        </header>

        <div class="cards">
          {#each lane.cards as card (card.issue.id)}
            <article
              class="card"
              class:selected={workspace.selection.has(card.issue.id)}
              draggable="true"
              ondragstart={(event) => {
                event.dataTransfer?.setData('application/x-lpm-issue', card.issue.id);
                event.dataTransfer?.setData('text/plain', card.issue.title);
              }}
            >
              <button
                class="open"
                type="button"
                onclick={() => workspace.selection.focus(card.issue.id)}
              >
                <span class="head">
                  <span class="icon">
                    <TypeIcon type={card.issue.type} depth={card.issue.depth} />
                  </span>
                  <span class="id">{card.issue.id}</span>
                  <StatusChip config={workspace.config} status={card.issue.status} />
                  {#if effortLabel(card)}<span class="effort">{effortLabel(card)}</span>{/if}
                </span>
                <span class="title">{card.issue.title}</span>
                {#if card.lineage.length}
                  <span class="lineage" title={card.lineage.join(' › ')}>
                    {card.lineage[card.lineage.length - 1]}
                  </span>
                {/if}
              </button>

              <div class="foot">
                {#if lane.id === 'blocked'}
                  <span class="waiting" title={card.blockedBy.map((b) => b.title).join(', ')}>
                    waiting on {card.blockedBy.map((blocker) => blocker.id).join(', ')}
                  </span>
                {:else if card.unblocks}
                  <span class="unblocks">unblocks {card.unblocks}</span>
                {/if}

                <span class="spacer"></span>
                {#if lane.id === 'ready'}
                  <button type="button" onclick={() => start(card.issue)}>Start</button>
                {:else if lane.id === 'active'}
                  <button type="button" onclick={() => finish(card.issue)}>Finish</button>
                {/if}
              </div>
            </article>
          {/each}

          {#if !lane.cards.length}
            <p class="empty">
              {lane.id === 'ready'
                ? queue.total
                  ? 'Nothing ready.'
                  : 'No issues yet.'
                : lane.id === 'active'
                  ? 'Drag an issue here to start it.'
                  : 'Nothing blocked.'}
            </p>
          {/if}
        </div>

        <p class="lane-hint">{lane.hint}</p>
      </section>
    {/each}

    <section class="lane done">
      <header>
        <h3>Just finished</h3>
        <span class="count">{queue.done.length}</span>
      </header>
      <div class="cards">
        {#each queue.done as card (card.issue.id)}
          <article class="card quiet" class:selected={workspace.selection.has(card.issue.id)}>
            <button
              class="open"
              type="button"
              onclick={() => workspace.selection.focus(card.issue.id)}
            >
              <span class="head">
                <span class="icon">
                  <TypeIcon type={card.issue.type} depth={card.issue.depth} />
                </span>
                <span class="id">{card.issue.id}</span>
                <StatusChip config={workspace.config} status={card.issue.status} />
              </span>
              <span class="title">{card.issue.title}</span>
            </button>
          </article>
        {/each}
        {#if !queue.done.length}
          <p class="empty">Nothing finished yet.</p>
        {/if}
      </div>
      <p class="lane-hint">The tail of the queue, newest first.</p>
    </section>
  </div>
</div>

<style>
  .queue {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .toolbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }

  .search {
    flex: 0 1 18rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    font-size: var(--text-sm);
  }

  .hint {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .spacer {
    flex: 1;
  }

  .lanes {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: var(--space-2);
    padding: var(--space-3);
    overflow: auto;
  }

  .lane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2);
  }

  /* Ready is the lane the whole view is for, so it is the one that is lit. */
  .lane.ready {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    background: color-mix(in srgb, var(--accent) 6%, var(--surface-2));
  }

  .lane.blocked,
  .lane.done {
    background: var(--surface-1);
    border-style: dashed;
  }

  .lane.over {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  header {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding-bottom: var(--space-1);
  }

  h3 {
    margin: 0;
    font-size: var(--text-sm);
  }

  .count {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .cards {
    flex: 1;
    min-height: 3rem;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .card {
    content-visibility: auto;
    contain-intrinsic-size: auto 2.2rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    cursor: grab;
  }

  .card.quiet {
    cursor: default;
    opacity: 0.75;
  }

  .card.selected {
    outline: 2px solid var(--accent);
  }

  .open {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    border: none;
    background: none;
    padding: 0;
    text-align: left;
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
  }

  .icon {
    display: inline-flex;
    color: var(--ink-muted);
  }

  .id {
    font-family: var(--font-mono);
    color: var(--ink-muted);
  }

  .effort {
    padding: 0 0.3rem;
    border-radius: 999px;
    background: var(--surface-3);
    font-weight: 600;
  }

  .title {
    font-size: var(--text-sm);
    line-height: 1.3;
  }

  .lineage {
    color: var(--ink-faint);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--ink-faint);
  }

  .unblocks {
    color: var(--accent);
  }

  .waiting {
    color: var(--warn);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .foot button {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    padding: 0 0.4rem;
    font-size: var(--text-xs);
  }

  .foot button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .lane-hint {
    flex: none;
    margin: var(--space-2) 0 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    line-height: 1.4;
  }

  .empty {
    margin: auto 0;
    padding: var(--space-2);
    text-align: center;
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }
</style>
