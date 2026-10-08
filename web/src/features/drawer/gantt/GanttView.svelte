<script lang="ts">
  import { criticalPath } from '$lib/board/critical-path.js';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import {
    buildTimeline,
    foldToLevel,
    foldableKeys,
    ganttLevels,
    type GanttGrouping,
  } from './schedule.js';

  /**
   * The plan on a date scale, at whatever level the reader wants.
   *
   * Rows nest and fold: by period, with the issues scheduled in each one under
   * it, or by the issue hierarchy, where a programme is a single bar covering
   * everything beneath it until it is opened. Folding is a way of looking, so
   * it lives here rather than in the view file. Clicking anything selects it,
   * which moves the canvas — the point of the chart is to be a way into the
   * graph.
   */
  const workspace = useWorkspace();

  let showCritical = $state(true);
  let grouping = $state<GanttGrouping>('period');
  let folded = $state(new Set<string>());

  const critical = $derived(criticalPath(workspace.nodes, workspace.config));
  const chain = $derived(showCritical ? new Set(critical.chain) : new Set<string>());

  const timeline = $derived(
    buildTimeline(workspace.nodes, workspace.config, chain, {
      grouping,
      isCollapsed: (key) => folded.has(key),
    }, workspace.index),
  );

  const percent = (value: number): string => `${(value * 100).toFixed(3)}%`;

  function fold(key: string): void {
    const next = new Set(folded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    folded = next;
  }

  /** The chart with nothing folded, which is what a fold decision is made from. */
  function fullTimeline() {
    return buildTimeline(workspace.nodes, workspace.config, chain, { grouping }, workspace.index);
  }

  /**
   * Everything foldable, not just what is on screen: folding the top level
   * hides the rows below it, and they have to be folded too or opening one
   * would spill its whole subtree.
   */
  function foldAll(): void {
    folded = new Set(foldableKeys(fullTimeline()));
  }

  const levels = $derived(ganttLevels(workspace.config, grouping));

  /** Show the chart down to one level: increments, sprints, stories. */
  function showDownTo(rank: number): void {
    folded = foldToLevel(workspace.config, grouping, fullTimeline(), rank);
  }
</script>

<div class="gantt">
  <div class="toolbar">
    <span class="group" role="group" aria-label="Group the rows by">
      <button type="button" class:active={grouping === 'period'} onclick={() => (grouping = 'period')}>
        By period
      </button>
      <button
        type="button"
        class:active={grouping === 'hierarchy'}
        onclick={() => (grouping = 'hierarchy')}
        title="All issues on one scale; parents span their children"
      >
        By hierarchy
      </button>
    </span>

    <label>
      <input type="checkbox" bind:checked={showCritical} />
      Critical path
      {#if critical.chain.length}
        <span class="hint">{critical.chain.length} issues, {critical.weight} total</span>
      {/if}
    </label>

    {#if timeline.unscheduled.length}
      <span class="hint">{timeline.unscheduled.length} unscheduled</span>
    {/if}

    <span class="spacer"></span>
    <button type="button" onclick={foldAll}>Collapse all</button>
  </div>

  <!--
    One click per level of the two hierarchies this chart nests: increments,
    sprints, then the issue levels inside them. "Everything" is the same button
    the table has, and it is what "expand all" used to be.
  -->
  <div class="toolbar levels">
    <span class="hint">Show down to</span>
    <span class="chips" role="group" aria-label="Show the chart down to a level">
      {#each levels as level (level.key)}
        <button
          type="button"
          title="Fold everything below {level.label}"
          onclick={() => showDownTo(level.rank)}
        >
          {level.label}
        </button>
      {/each}
      <button type="button" title="Expand all" onclick={() => (folded = new Set())}>
        Everything
      </button>
    </span>
  </div>

  {#if !timeline.rows.length}
    <p class="empty">
      {grouping === 'period'
        ? 'No periods yet.'
        : 'Nothing scheduled yet.'}
    </p>
  {:else}
    <div class="chart">
      <div class="labels">
        <div class="head"></div>
        {#each timeline.rows as row (row.key)}
          <div class="label" style="--depth: {row.depth}">
            {#if row.hasChildren}
              <button
                class="twisty"
                class:open={!row.collapsed}
                type="button"
                aria-label={row.collapsed ? 'Expand' : 'Collapse'}
                title={row.collapsed ? 'Expand' : 'Collapse'}
                onclick={() => fold(row.key)}
              >
                ▸
              </button>
            {:else}
              <span class="twisty"></span>
            {/if}
            <button
              class="name"
              class:selected={workspace.selection.has(row.node.id)}
              type="button"
              onclick={() => workspace.selection.focus(row.node.id)}
            >
              <span class="icon"><TypeIcon type={row.node.type} depth={row.node.depth} /></span>
              <span class="text">{row.node.title}</span>
            </button>
          </div>
        {/each}
      </div>

      <div class="track">
        <div class="head">
          {#each timeline.ticks as tick (tick.label)}
            <span class="tick" style="left: {percent(tick.offset)}">{tick.label}</span>
          {/each}
        </div>
        {#each timeline.rows as row (row.key)}
          <div class="lane">
            {#each timeline.ticks as tick (tick.label)}
              <span class="gridline" style="left: {percent(tick.offset)}"></span>
            {/each}
            {#if row.bar}
              <button
                class="bar {row.kind} tone-{row.tone}"
                class:critical={row.critical}
                class:rolled={row.rolled}
                class:selected={workspace.selection.has(row.node.id)}
                style="left: {percent(row.bar.offset)}; width: {percent(row.bar.span)}"
                type="button"
                title="{row.node.title} · {row.starts} → {row.ends}{row.rolled
                  ? ' (from children)'
                  : ''}"
                onclick={() => workspace.selection.focus(row.node.id)}
              >
                <span>{row.node.id}</span>
              </button>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .gantt {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
  }

  .spacer {
    margin-left: auto;
  }

  label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .group {
    display: inline-flex;
  }

  .group button {
    border: 1px solid var(--border);
    background: var(--surface-1);
    padding: 0.15rem 0.5rem;
    font-size: var(--text-xs);
  }

  .group button:first-child {
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
  }

  .group button:last-child {
    border-left: none;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }

  .group button.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  .toolbar > button,
  .chips button {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    padding: 0.15rem 0.5rem;
    font-size: var(--text-xs);
  }

  /* The level row hangs under the first toolbar rather than beside it: with two
     hierarchies to name it is the wider of the two, and wrapping it into the
     controls above would move them around as the board changes shape. */
  .toolbar.levels {
    gap: var(--space-2);
    padding-top: 0;
    border-bottom: 1px solid var(--border);
  }

  .chips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.15rem;
  }

  .hint {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .chart {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(12rem, 22rem) 1fr;
    min-height: 0;
    overflow: auto;
  }

  .head {
    position: sticky;
    top: 0;
    z-index: 1;
    height: calc(1.6rem * var(--ui-scale));
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
  }

  .labels {
    border-right: 1px solid var(--border);
  }

  .label {
    display: flex;
    align-items: center;
    height: calc(1.7rem * var(--ui-scale));
    padding-left: calc(var(--space-2) + var(--depth) * 0.9rem);
    border-bottom: 1px solid var(--surface-2);
  }

  .twisty {
    width: 1rem;
    flex: none;
    border: none;
    background: none;
    padding: 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    transition: transform var(--duration-fast);
  }

  .twisty.open {
    transform: rotate(90deg);
  }

  .name {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex: 1;
    min-width: 0;
    height: 100%;
    border: none;
    background: none;
    font-size: var(--text-xs);
    text-align: left;
  }

  .name:hover {
    background: var(--surface-2);
  }

  .name.selected {
    background: var(--accent-soft);
  }

  .icon {
    display: inline-flex;
    color: var(--ink-muted);
  }

  .text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .track {
    position: relative;
    min-width: 32rem;
  }

  .tick {
    position: absolute;
    top: 0.25rem;
    transform: translateX(2px);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .lane {
    position: relative;
    height: calc(1.7rem * var(--ui-scale));
    border-bottom: 1px solid var(--surface-2);
  }

  .gridline {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--surface-2);
  }

  .bar {
    position: absolute;
    top: 0.25rem;
    height: calc(1.15rem * var(--ui-scale));
    min-width: 4px;
    padding: 0 0.3rem;
    border: 1px solid var(--tone);
    border-radius: var(--radius-sm);
    background: var(--tone-bg);
    color: var(--ink);
    font-size: var(--text-xs);
    line-height: 1;
    overflow: hidden;
    text-align: left;
  }

  .bar.period {
    background: var(--surface-3);
    border-color: var(--border-strong);
    font-weight: 600;
  }

  /* Dates borrowed from the work inside: drawn as a bracket over it. */
  .bar.rolled {
    background: transparent;
    border-style: dashed;
  }

  .bar.critical {
    outline: 2px solid var(--warn);
    outline-offset: -1px;
  }

  .bar.selected {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .tone-todo {
    --tone: var(--tone-todo);
    --tone-bg: var(--tone-todo-soft);
  }
  .tone-active {
    --tone: var(--tone-active);
    --tone-bg: var(--tone-active-soft);
  }
  .tone-blocked {
    --tone: var(--tone-blocked);
    --tone-bg: var(--tone-blocked-soft);
  }
  .tone-review {
    --tone: var(--tone-review);
    --tone-bg: var(--tone-review-soft);
  }
  .tone-done {
    --tone: var(--tone-done);
    --tone-bg: var(--tone-done-soft);
  }

  .empty {
    padding: var(--space-5);
    text-align: center;
    color: var(--ink-muted);
  }
</style>
