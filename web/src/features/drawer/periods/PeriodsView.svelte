<script lang="ts">
  import { planStartNow } from '$shared';
  import { useShell } from '$lib/app/shell.svelte.js';
  import { todayIso } from '$lib/board/periods.js';
  import { nodesOfKind } from '$lib/board/selectors.js';
  import {
    editNode,
    schedule,
    completePeriod,
    carryOverPeriod,
  } from '$lib/workspace/mutations.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import {
    addPeriod as doAddPeriod,
    clearPeriods as doClearPeriods,
    describeStart,
    findColumn,
    removePeriod as doRemovePeriod,
    startPeriod as doStartPeriod,
    switchPeriod as doSwitchPeriod,
  } from './actions.js';
  import CorrectDialog from './CorrectDialog.svelte';
  import PeriodColumn from './PeriodColumn.svelte';
  import {
    buildPeriodBoard,
    columnKeys,
    currentColumnKey,
    PERIOD_DROP_ATTRIBUTE,
    planResequence,
    UNSCHEDULED,
    type PeriodColumn as Column,
  } from './periods.js';

  /**
   * Filling the increments and sprints.
   *
   * The period tree drawn as nested boxes — sprints inside the increment they
   * belong to — with everything unscheduled beside it. Moving a card is a
   * single update to the issue's `period`: scheduling is a field on the issue,
   * so there is no "sprint contents" list to mirror and nothing can fall out of
   * step. Selecting a card selects it everywhere, so the canvas follows along.
   */
  const workspace = useWorkspace();
  const shell = useShell();

  let search = $state('');
  /** Sort direction for period columns. Default newest-first. */
  let newestFirst = $state(true);
  /** Hide finished/parked periods. Default true. */
  let hideArchived = $state(true);
  /** Squad to filter by, or empty for all. */
  let squadFilter = $state('');
  /** The box the pointer is over, so exactly one drop target lights up. */
  let hovering = $state<string | null>(null);
  /**
   * A drag from the canvas lights a box the same way one from inside does. It
   * arrives through the shell because the canvas is what is tracking the
   * pointer — see `periodDropAt`.
   */
  const overBox = $derived(shell.periodDropTarget ?? hovering);
  /**
   * Which boxes are rolled up. A way of reading rather than part of the plan,
   * so it lives here and not in the view file — the same call the table and the
   * Gantt make about their own folding.
   */
  let folded = $state(new Set<string>());

  const board = $derived(buildPeriodBoard(workspace.nodes, workspace.config, { search, newestFirst, hideArchived, squadId: squadFilter || undefined }));
  const rootType = $derived(workspace.config.hierarchy.period[0]?.[0] ?? null);
  /** Squads available on this board, for filtering and assigning. */
  const squads = $derived(Object.values(workspace.nodes).filter((node) => node.kind === 'squad'));
  const selectedIssues = $derived(
    workspace.selection.ids.filter((id) => workspace.node(id)?.kind === 'issue'),
  );

  // Auto-scroll to the current period on mount — the recurring pain point.
  // Once per mount (the component unmounts when the tab changes), never during
  // user scrolling.
  let scrolled = $state(false);

  function scrollToNow(): void {
    const key = currentColumnKey(board, todayIso());
    if (!key) return;
    const el = document.querySelector(`[${PERIOD_DROP_ATTRIBUTE}="${CSS.escape(key)}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }

  $effect(() => {
    // Track `board` so the effect re-runs when the board rebuilds.
    void board;
    if (scrolled) return;
    requestAnimationFrame(() => {
      scrollToNow();
      scrolled = true;
    });
  });

  const label = (type: string): string => workspace.config.types[type]?.label ?? type;

  /**
   * A new period lands with dates rather than blank ones: after the last one
   * beside it, for as long as that one ran. Filling a quarter is then a row of
   * clicks instead of a fortnight of date pickers.
   */
  function addPeriod(type: string, parentId: string | null): void {
    doAddPeriod(workspace, type, parentId);
  }

  function startPeriod(id: string): void {
    doStartPeriod(workspace, shell, id);
  }

  function switchPeriod(id: string, active: boolean | null): void {
    doSwitchPeriod(workspace, shell, id, active);
  }

  function removePeriod(id: string): void {
    doRemovePeriod(workspace, shell, id);
  }

  function clearPeriods(): void {
    doClearPeriods(workspace, shell);
  }

  /**
   * The box whose "Fix…" was clicked. Local rather than in the shell: nothing
   * outside this view opens it, and it is a way of reading the periods board,
   * not a piece of application state anyone else needs.
   */
  let correcting = $state<string | null>(null);
  const correctingColumn = $derived(
    correcting ? findColumn(board.roots, correcting) : null,
  );

  function fold(key: string): void {
    const next = new Set(folded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    folded = next;
  }

  /**
   * Drop a period on a period: the dragged one takes that one's place in the
   * running order, and the dates are rewritten to match — see `planResequence`.
   */
  function reorder(movedId: string, targetId: string): void {
    hovering = null;
    for (const edit of planResequence(workspace.nodes, movedId, targetId)) {
      editNode(workspace, edit.id, edit.patch);
    }
  }

  const periodOf = (key: string): string | null => (key === UNSCHEDULED ? null : key);

  /** The status "close it out" writes: the board's first terminal column. */
  const doneStatus = $derived(workspace.config.statuses.find((status) => status.terminal));

  /** A dragged card carries the whole selection when it is part of it. */
  function dropped(key: string, id: string): void {
    hovering = null;
    const ids =
      workspace.selection.has(id) && selectedIssues.length > 1 ? selectedIssues : [id];
    schedule(workspace, ids, periodOf(key));
  }
</script>

<div class="periods">
  <div class="toolbar">
    <input
      class="search"
      bind:value={search}
      placeholder="Filter by title, id or type"
      aria-label="Filter issues"
    />

    {#if squads.length}
      <select class="squad-filter" bind:value={squadFilter} aria-label="Filter by squad">
        <option value="">All squads</option>
        {#each squads as squad (squad.id)}
          <option value={squad.id}>{squad.title}</option>
        {/each}
      </select>
    {/if}

    <span class="hint">
      {board.unscheduled} unscheduled
    </span>

    <span class="spacer"></span>
    <span class="chips" role="group" aria-label="Fold periods">
      <button type="button" onclick={() => (folded = new Set(columnKeys(board)))}>
        Collapse all
      </button>
      <button type="button" onclick={() => (folded = new Set())}>Expand all</button>
      <button
        type="button"
        onclick={() => scrollToNow()}
        aria-label="Jump to the current period"
        title="Scroll to now"
      >
        Jump to now
      </button>
      <button
        type="button"
        onclick={() => (newestFirst = !newestFirst)}
        aria-label={newestFirst ? 'Show oldest first' : 'Show newest first'}
        title={newestFirst ? 'Newest first' : 'Oldest first'}
      >
        {newestFirst ? '↓ Newest' : '↑ Oldest'}
      </button>
      <button
        type="button"
        onclick={() => (hideArchived = !hideArchived)}
        aria-label={hideArchived ? 'Show all periods' : 'Hide archived periods'}
        title={hideArchived && board.hidden ? `${board.hidden} hidden` : 'Showing all periods'}
      >
        {hideArchived ? 'Filtered' : 'All'}
        {#if hideArchived && board.hidden}
          <span class="badge">{board.hidden}</span>
        {/if}
      </button>
    </span>
    {#if rootType}
      <button type="button" onclick={() => addPeriod(rootType, null)}>
        + {label(rootType)}
      </button>
    {/if}
    {#if board.roots.length}
      <button
        class="danger"
        type="button"
        title="Delete all periods"
        onclick={clearPeriods}
      >
        Clear all
      </button>
    {/if}
  </div>

  <div class="columns">
    {#snippet box(column: Column)}
      <PeriodColumn
        {column}
        config={workspace.config}
        {squads}
        hovering={overBox}
        canTake={selectedIssues.length > 0}
        isSelected={(id) => workspace.selection.has(id)}
        onhover={(key) => (hovering = key)}
        ondropped={dropped}
        ontake={(key) => schedule(workspace, selectedIssues, periodOf(key))}
        onopen={(id) => workspace.selection.focus(id)}
        onedit={(id, patch) => editNode(workspace, id, patch)}
        onadd={addPeriod}
        onremove={removePeriod}
        onunschedule={(id) => schedule(workspace, [id], null)}
        onstart={startPeriod}
        onswitch={switchPeriod}
        oncorrect={(key) => (correcting = key)}
        isFolded={(key) => folded.has(key)}
        onfold={fold}
        onreorder={reorder}
      />
    {/snippet}

    {#each board.roots as root (root.key)}
      {@render box(root)}
    {/each}

    {#if rootType}
      <button class="add-root" type="button" onclick={() => addPeriod(rootType, null)}>
        + {label(rootType)}
      </button>
    {/if}

    {@render box(board.backlog)}

    {#if !board.roots.length}
      <p class="none">
        No periods. Add {rootType ? `a ${label(rootType)}` : 'one'}, or switch to the queue in Options.
      </p>
    {/if}
  </div>
</div>

{#if correctingColumn?.period}
  <CorrectDialog
    title={correctingColumn.period.title}
    ends={correctingColumn.period.ends ?? ''}
    open={correctingColumn.open.length}
    nextTitle={correctingColumn.nextId
      ? (workspace.node(correctingColumn.nextId)?.title ?? null)
      : null}
    doneLabel={doneStatus?.label ?? 'done'}
    oncomplete={() => {
      completePeriod(workspace, correcting!);
      correcting = null;
    }}
    oncarry={() => {
      carryOverPeriod(workspace, correcting!);
      correcting = null;
    }}
    onclose={() => (correcting = null)}
  />
{/if}

<style>
  .periods {
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

  .squad-filter {
    flex: none;
    padding: 0.15rem 0.35rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-xs);
    max-width: 12rem;
  }

  .spacer {
    flex: 1;
  }

  .toolbar button {
    flex: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    padding: 0.15rem 0.5rem;
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .hint {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  /* One band per increment, stacked down the pane and scrolled vertically —
     the order a plan is read in, and the direction a mouse wheel already goes. */
  .columns {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    overflow: auto;
  }

  .add-root {
    align-self: start;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-muted);
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-xs);
  }

  .add-root:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .chips {
    display: inline-flex;
    gap: 0.15rem;
  }

  .toolbar button.danger:hover {
    border-color: var(--danger);
    color: var(--danger);
  }

  .none {
    margin: auto;
    color: var(--ink-muted);
    text-align: center;
  }
</style>
