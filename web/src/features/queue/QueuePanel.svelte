<script lang="ts">
  import { DEFAULT_QUEUE_WIDTH, type IssueDto } from '$shared';
  import StatusChip from '$lib/ui/StatusChip.svelte';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import { paneScale } from '$lib/ui/scale.js';
  import { setStatus } from '$lib/workspace/mutations.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import { buildQueue, laneStatus, queueSections, type QueueCard, type QueueSection, type SectionId } from './queue.js';

  /**
   * The queue, down the left edge, for a team that does not plan in sprints.
   *
   * One column read top to bottom, the way a queue is: what is being worked
   * on, then what comes next — numbered, because the order *is* the point —
   * then what is waiting and on what, and the finished tail folded away at the
   * bottom. A rail runs down the left of it so the eye follows the line rather
   * than scanning a grid. `lpm task next` in the terminal answers the same
   * question with the same ordering; this is that answer with somewhere to put
   * your hands. Dropping a card into a section is one status change.
   */
  interface Props {
    /** The width the workspace fitted this panel to; it scales the contents. */
    width: number;
  }

  let { width }: Props = $props();

  const workspace = useWorkspace();

  let search = $state('');
  let hovering = $state<SectionId | null>(null);
  /** Sections somebody opened or closed. Absent means the section's default. */
  let toggled = $state<Partial<Record<SectionId, boolean>>>({});

  const queue = $derived(buildQueue(workspace.nodes, workspace.config, { search }, workspace.index));
  const sections = $derived(queueSections(queue));

  const isFolded = (section: QueueSection): boolean => toggled[section.id] ?? section.folded;

  function toggle(section: QueueSection): void {
    toggled = { ...toggled, [section.id]: !isFolded(section) };
  }

  function drop(section: QueueSection, event: DragEvent): void {
    const id = event.dataTransfer?.getData('application/x-lpm-issue');
    hovering = null;
    if (!id || !section.dropsInto) return;
    event.preventDefault();
    const status = laneStatus(workspace.config, section.dropsInto);
    if (status) setStatus(workspace, [id], status);
  }

  function move(issue: IssueDto, lane: 'active' | 'done'): void {
    const status = laneStatus(workspace.config, lane);
    if (status) setStatus(workspace, [issue.id], status);
  }

  function collapse(): void {
    workspace.doc.queue.open = false;
    workspace.scheduleSave();
  }

  const effortLabel = (card: QueueCard): string =>
    workspace.config.effortAttribute && card.effort ? `${card.effort}` : '';
</script>

<aside
  class="queue ui-scale"
  aria-label="Queue"
  style="width: {width}px; --ui-scale: {paneScale(width, DEFAULT_QUEUE_WIDTH)}"
>
  <header class="top">
    <div class="heading">
      <h2>Queue</h2>
      <span class="summary">
        {queue.active.length} in progress · {queue.ready.length} next · {queue.blocked.length} waiting
      </span>
    </div>
    <button class="collapse" type="button" title="Hide the queue" onclick={collapse}>◂</button>
  </header>

  <div class="filter">
    <input bind:value={search} placeholder="Filter by title, id or type" aria-label="Filter the queue" />
  </div>

  <ol class="flow">
    {#each sections as section (section.id)}
      {@const folded = isFolded(section)}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <li
        class="section {section.id}"
        class:over={hovering === section.id}
        ondragover={(event) => {
          if (!section.dropsInto) return;
          event.preventDefault();
          hovering = section.id;
        }}
        ondragleave={() => (hovering = null)}
        ondrop={(event) => drop(section, event)}
      >
        <button
          class="section-head"
          type="button"
          title={section.hint}
          aria-expanded={!folded}
          onclick={() => toggle(section)}
        >
          <span class="node" aria-hidden="true"></span>
          <span class="label">{section.label}</span>
          <span class="count">{section.cards.length}</span>
          <span class="chevron" class:folded aria-hidden="true">▾</span>
        </button>

        {#if !folded}
          {#if section.cards.length}
            <ol class="cards">
              {#each section.cards as card, position (card.issue.id)}
                {@const first = section.numbered && position === 0}
                <li
                  class="card"
                  class:first
                  class:selected={workspace.selection.has(card.issue.id)}
                  draggable={section.id !== 'done'}
                  ondragstart={(event) => {
                    event.dataTransfer?.setData('application/x-lpm-issue', card.issue.id);
                    event.dataTransfer?.setData('text/plain', card.issue.title);
                  }}
                >
                  <span class="marker" aria-hidden="true">
                    {#if section.numbered}{position + 1}{:else if section.id === 'done'}✓{/if}
                  </span>

                  <div class="box">
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
                        {#if first}<span class="next-tag">Next</span>{/if}
                      </span>
                      <span class="title">{card.issue.title}</span>
                      {#if card.lineage.length}
                        <span class="lineage" title={card.lineage.join(' › ')}>
                          {card.lineage[card.lineage.length - 1]}
                        </span>
                      {/if}
                    </button>

                    {#if section.id !== 'done'}
                      <div class="foot">
                        {#if section.id === 'waiting'}
                          <span
                            class="blockers"
                            title={card.blockedBy.map((blocker) => blocker.title).join(', ')}
                          >
                            waiting on {card.blockedBy.map((blocker) => blocker.id).join(', ')}
                          </span>
                        {:else if card.unblocks}
                          <span class="unblocks">unblocks {card.unblocks}</span>
                        {/if}
                        <span class="spacer"></span>
                        {#if section.id === 'next'}
                          <button type="button" class="action" onclick={() => move(card.issue, 'active')}>
                            Start
                          </button>
                        {:else if section.id === 'now'}
                          <button type="button" class="action" onclick={() => move(card.issue, 'done')}>
                            Finish
                          </button>
                        {/if}
                      </div>
                    {/if}
                  </div>
                </li>
              {/each}
            </ol>
          {:else}
            <p class="empty">{section.empty}</p>
          {/if}
        {/if}
      </li>
    {/each}
  </ol>

  <p class="hint">Drag a card between sections to start or finish it.</p>
</aside>

<style>
  .queue {
    /* The gutter the rail runs down, and the markers sit centred on. */
    --rail: 1.75rem;

    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface-1);
  }

  .top {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .heading {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  h2 {
    margin: 0;
    font-size: var(--text-md);
  }

  .summary {
    color: var(--ink-faint);
    font-size: var(--text-xs);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .collapse {
    border: none;
    background: none;
    color: var(--ink-muted);
    line-height: 1;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
  }

  .collapse:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .filter {
    flex: none;
    padding: var(--space-2) var(--space-3);
  }

  .filter input {
    width: 100%;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    font-size: var(--text-sm);
  }

  .flow,
  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .flow {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 var(--space-3) var(--space-3);
  }

  /* Each section carries its own stretch of the rail, so the line is solid
     where work is moving and dashed where it is waiting. */
  .section {
    --tone: var(--ink-faint);
    --rail-style: solid;

    position: relative;
    padding-bottom: var(--space-2);
    border-radius: var(--radius-md);
  }

  .section::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(var(--rail) / 2 - 1px);
    border-left: 2px var(--rail-style) color-mix(in srgb, var(--tone) 45%, transparent);
  }

  .section:last-child::before {
    bottom: auto;
    height: 1rem;
  }

  .section.now {
    --tone: var(--tone-active);
  }

  .section.next {
    --tone: var(--accent);
  }

  .section.waiting {
    --tone: var(--warn);
    --rail-style: dashed;
  }

  .section.done {
    --tone: var(--tone-done);
  }

  .section.over {
    background: var(--accent-soft);
    outline: 1px dashed var(--accent);
  }

  .section-head {
    position: relative;
    display: grid;
    grid-template-columns: var(--rail) 1fr auto auto;
    align-items: center;
    gap: var(--space-1);
    width: 100%;
    padding: var(--space-2) 0 var(--space-1);
    border: none;
    background: none;
    text-align: left;
  }

  .node {
    justify-self: center;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 2px;
    background: var(--tone);
    transform: rotate(45deg);
    box-shadow: 0 0 0 3px var(--surface-1);
  }

  .label {
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-muted);
  }

  .count {
    min-width: 1.4rem;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-align: center;
  }

  .chevron {
    color: var(--ink-faint);
    font-size: var(--text-xs);
    transition: transform var(--duration-fast);
  }

  .chevron.folded {
    transform: rotate(-90deg);
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .card {
    position: relative;
    display: grid;
    grid-template-columns: var(--rail) 1fr;
    align-items: start;
    content-visibility: auto;
    contain-intrinsic-size: auto 3.5rem;
  }

  .card[draggable='true'] {
    cursor: grab;
  }

  .marker {
    justify-self: center;
    margin-top: var(--space-2);
    display: grid;
    place-items: center;
    width: 1.2rem;
    height: 1.2rem;
    border: 2px solid var(--tone);
    border-radius: 50%;
    background: var(--surface-1);
    color: var(--tone);
    font-size: 0.625rem;
    font-weight: 700;
    line-height: 1;
  }

  .now .marker {
    background: var(--tone);
    animation: pulse 2s ease-out infinite;
  }

  .waiting .marker {
    border-style: dashed;
  }

  .done .marker {
    width: 1rem;
    height: 1rem;
    border-width: 1.5px;
    font-size: 0.55rem;
  }

  .card.first .marker {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
  }

  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone) 55%, transparent);
    }
    100% {
      box-shadow: 0 0 0 6px transparent;
    }
  }

  .box {
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    transition:
      border-color var(--duration-fast),
      box-shadow var(--duration-fast);
  }

  .card:hover .box {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-sm);
  }

  .card.first .box {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
    background: color-mix(in srgb, var(--accent) 5%, var(--surface-1));
  }

  .waiting .box {
    border-style: dashed;
    background: var(--surface-0);
  }

  .done .box {
    padding: var(--space-1) var(--space-2);
    opacity: 0.75;
  }

  .card.selected .box {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }

  .open {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    min-width: 0;
    padding: 0;
    border: none;
    background: none;
    text-align: left;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
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

  .next-tag {
    margin-left: auto;
    padding: 0 0.4rem;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
  }

  .title {
    font-size: var(--text-sm);
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .done .title {
    font-size: var(--text-xs);
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }

  .lineage {
    max-width: 100%;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-height: 1.2rem;
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--ink-faint);
  }

  .unblocks {
    color: var(--accent);
  }

  .blockers {
    color: var(--warn);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
  }

  /* The actions stay out of the way until the card is pointed at, except on
     the next one up — that card is asking to be started. */
  .action {
    padding: 0 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    font-size: var(--text-xs);
    opacity: 0;
    transition: opacity var(--duration-fast);
  }

  .card:hover .action,
  .card:focus-within .action,
  .card.first .action {
    opacity: 1;
  }

  @media (hover: none) {
    .action {
      opacity: 1;
    }
  }

  .action:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .card.first .action {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-ink);
  }

  .empty {
    margin: 0 0 0 var(--rail);
    padding: var(--space-1) 0 var(--space-2);
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .hint {
    flex: none;
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-top: 1px solid var(--border);
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }
</style>
