<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { AttributeDto, NodeDto } from '$shared';
  import { useShell } from '$lib/app/shell.svelte.js';
  import { ancestorsOf, nodesOfKind, subtreeIds } from '$lib/board/selectors.js';
  import { editNode } from '$lib/workspace/mutations.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import { nodeMenu } from '$features/canvas/menus.js';
  import { useRemoteState } from '$features/drawer/remote/remote.svelte.js';
  import MultiSelect from '$lib/ui/fields/MultiSelect.svelte';
  import { QUICK_FILTERS, filterMatcher, foldToDepth, levelChoices, type QuickFilter } from './filters.js';
  import { buildRows } from './rows.js';
  import { columnComparator, type SortColumn, type SortDir } from './sort.js';
  import { windowSlice, rowOffset } from './windowing.js';
  import { emptyFacet, faceted, facetKeep, availableStatuses, availableTypes, availableAssignees, availablePeriods, type FacetState } from './facet.js';
  import { computeSubtreeMembership } from './subtrees.js';
  import TableRow from './TableRow.svelte';

  /**
   * The whole board as a tree of rows, for quick edits and side-by-side reading.
   * Selecting a row selects the node everywhere, which is what makes clicking
   * here move the canvas — and, the other way round, selecting a node anywhere
   * else scrolls this list to it and opens whatever it was buried under.
   */
  const workspace = useWorkspace();
  const shell = useShell();
  const remote = useRemoteState();

  let collapsed = $state<Record<string, true>>({});
  let search = $state('');
  let filter = $state<QuickFilter>('all');
  let scroller = $state<HTMLElement | null>(null);
  let sortColumn = $state<SortColumn>('title');
  let sortDir = $state<SortDir>('asc');
  let facet = $state<FacetState>(emptyFacet());
  let hiddenColumns = $state(new Set<string>());

  const members = $derived(new Set(workspace.members));

  // Stable empty set so matcher doesn't track `members` as a dependency when
  // the active filter isn't `canvas`. Without this, ticking a single "on
  // canvas" box invalidates matcher and rebuilds every row on the board.
  const NO_MEMBERS = new Set<string>();

  const matcher = $derived(
    filterMatcher(filter, {
      nodes: workspace.nodes,
      config: workspace.config,
      members: filter === 'canvas' ? members : NO_MEMBERS,
    }),
  );

  const sortComparator = $derived(
    columnComparator(sortColumn, sortDir, workspace.config, workspace.nodes),
  );

  const facetPred = $derived(facetKeep(facet, workspace.nodes));

  const combined = $derived((node: NodeDto): boolean => {
    return (!matcher || matcher(node)) && facetPred(node);
  });

  const rows = $derived(
    buildRows(workspace.nodes, {
      // Whichever collection the view is over: the table is the registry's
      // only reading, so it has to follow the mode. @see Workspace.nodeKind
      kind: workspace.nodeKind,
      search,
      keep: combined,
      isExpanded: (id) => !collapsed[id],
      compare: sortComparator,
    }, workspace.index),
  );

  // -- virtual scrolling ----------------------------------------------------
  const ROW_HEIGHT = 32; // px; matched by CSS `height` on td
  const OVERSCAN = 5;
  let scrollTop = $state(0);
  let viewHeight = $state(0);

  function onScroll(): void {
    if (!scroller) return;
    scrollTop = scroller.scrollTop;
    viewHeight = scroller.clientHeight;
  }

  const window = $derived(windowSlice(scrollTop, viewHeight, ROW_HEIGHT, rows.length, OVERSCAN));
  const visibleRows = $derived(rows.slice(window.start, window.start + window.count));

  // Measure the viewport once the scroller is in the DOM. Also runs when the
  // window resizes; the scroll handler already covers scrolling.
  $effect(() => {
    if (scroller) viewHeight = scroller.clientHeight;
  });

  const levels = $derived(levelChoices(workspace.config));

  /**
   * Follow the selection, wherever it was made. Opening the ancestors first is
   * the point: a story selected on the canvas is usually folded away in here,
   * and scrolling to a row that is not rendered would do nothing at all.
   */
  $effect(() => {
    const id = workspace.selection.primary;
    if (!id) return;
    untrack(() => void reveal(id));
  });

  async function reveal(id: string): Promise<void> {
    const buried = ancestorsOf(workspace.nodes, id)
      .map((ancestor) => ancestor.id)
      .filter((ancestorId) => collapsed[ancestorId]);
    if (buried.length) {
      for (const ancestorId of buried) delete collapsed[ancestorId];
      await tick();
    }
    // Find the row index and scroll to its pixel offset. Works with
    // virtualization: the scroller is told where to go, and the next
    // scroll event recomputes the window around it.
    const index = rows.findIndex((row) => row.node.id === id);
    if (index >= 0 && scroller) {
      scroller.scrollTop = rowOffset(index, ROW_HEIGHT);
    }
  }

  /** The two attributes the engine itself knows about get their own columns. */
  const columns = $derived.by(() => {
    const config = workspace.config;
    const wanted = [config.priorityAttribute, config.effortAttribute].filter(Boolean);
    const found = new Map<string, AttributeDto>();
    for (const type of Object.values(config.types)) {
      for (const attribute of type.attributes) {
        if (wanted.includes(attribute.name) && !found.has(attribute.name)) {
          found.set(attribute.name, attribute);
        }
      }
    }
    return [...found.values()];
  });

  const visibleColumns = $derived(columns.filter((c) => !hiddenColumns.has(c.name)));

  const assignees = $derived(nodesOfKind(workspace.nodes, 'resource'));
  const periods = $derived(nodesOfKind(workspace.nodes, 'period'));
  const allIssues = $derived(nodesOfKind(workspace.nodes, 'issue'));
  const issueCount = $derived(allIssues.length);

  function sortBy(column: SortColumn): void {
    if (sortColumn === column) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = column;
      sortDir = 'asc';
    }
  }

  function sortIndicator(col: SortColumn): string {
    if (sortColumn !== col) return '';
    return sortDir === 'asc' ? ' ▴' : ' ▾';
  }

  function setFacet(dim: keyof FacetState, next: Set<string>): void {
    facet = { ...facet, [dim]: next };
  }

  /*
   * Status, assignee and period are properties of a piece of work. A template
   * is the shape of one, so the registry hides those three columns and the
   * filters over them rather than showing empty cells in every row.
   */
  const scheduling = $derived(workspace.mode !== 'templates');

  const facetStatuses = $derived(scheduling ? availableStatuses(workspace.config) : []);
  const facetTypes = $derived(availableTypes(workspace.config));
  const facetAssignees = $derived(scheduling ? availableAssignees(workspace.nodes) : []);
  // A board working as one queue draws no period anywhere, the table included.
  const periodColumn = $derived(scheduling && workspace.planning === 'periods');
  const facetPeriods = $derived(periodColumn ? availablePeriods(workspace.nodes) : []);

  function toggle(id: string): void {
    if (collapsed[id]) {
      delete collapsed[id];
    } else {
      collapsed[id] = true;
    }
  }

  function select(id: string, event: MouseEvent): void {
    if (event.shiftKey || event.ctrlKey || event.metaKey) workspace.selection.toggle(id);
    else workspace.selection.focus(id);
  }

  function toggleMembership(id: string, subtree: boolean): void {
    if (!subtree) {
      if (workspace.isMember(id)) workspace.removeMembers([id]);
      else workspace.addMembers([id]);
      return;
    }
    // The subtree box reads as "all of this branch", so a half-full branch
    // fills up rather than emptying — otherwise its own box would clear rows
    // it never showed as checked.
    const ids = subtreeIds(workspace.nodes, id, workspace.index);
    if (ids.every((entry) => members.has(entry))) workspace.removeMembers(ids);
    else workspace.addMembers(ids);
  }

  /**
   * What each row's subtree box shows, computed in one bottom-up pass — O(n)
   * instead of the previous O(n·depth) per-row walk with subtreeIds.
   */
  const subtrees = $derived(
    computeSubtreeMembership(workspace.nodes, members, workspace.index),
  );

  /**
   * What the header checkbox acts on: everything the filter matches, which with
   * no filter is the whole board — including branches that happen to be folded
   * here, because folding a row is a way of reading the list, not a way of
   * choosing issues. That is why it walks with every branch open instead of
   * reusing `rows`, which now stops at a fold.
   */
  const narrowed = $derived(Boolean(search.trim()) || Boolean(matcher) || faceted(facet));

  const listed = $derived(
    narrowed
      ? buildRows(
          workspace.nodes,
          { kind: workspace.nodeKind, search, keep: combined, isExpanded: () => true },
          workspace.index,
        ).map((row) => row.node.id)
      : allIssues.map((issue) => issue.id),
  );

  const inView = $derived(listed.filter((id) => members.has(id)).length);

  function toggleAll(): void {
    if (inView === listed.length) workspace.removeMembers(listed);
    else workspace.addMembers(listed);
  }
</script>

<div class="table-view">
  <div class="toolbar">
    <input
      class="search"
      bind:value={search}
      placeholder="Filter by title, id or type"
      aria-label="Filter issues"
    />

    <span class="chips" role="group" aria-label="Quick filters">
      {#each QUICK_FILTERS as choice (choice.id)}
        <button
          type="button"
          class:active={filter === choice.id}
          title={choice.hint}
          onclick={() => (filter = choice.id)}
        >
          {choice.label}
        </button>
      {/each}
    </span>

    <span class="count">
      {rows.length} of {issueCount}
      {#if inView}· {inView} on the canvas{/if}
      {#if faceted(facet)}· filtered{/if}
    </span>
  </div>

  {#if facetStatuses.length > 0 || facetTypes.length > 0 || facetAssignees.length > 0 || facetPeriods.length > 0}
    <div class="toolbar facets">
      <span class="label">Filter by</span>
      {#if facetStatuses.length > 0}
        <MultiSelect
          options={facetStatuses.map((s) => ({ value: s, label: s }))}
          selected={facet.statuses}
          placeholder="status"
          onchange={(next) => setFacet('statuses', next)}
        />
      {/if}
      {#if facetTypes.length > 0}
        <MultiSelect
          options={facetTypes.map((t) => ({ value: t, label: t }))}
          selected={facet.types}
          placeholder="type"
          onchange={(next) => setFacet('types', next)}
        />
      {/if}
      {#if facetAssignees.length > 0}
        <MultiSelect
          options={facetAssignees.map((a) => ({ value: a, label: workspace.nodes[a]?.title ?? a }))}
          selected={facet.assignees}
          placeholder="assignee"
          onchange={(next) => setFacet('assignees', next)}
        />
      {/if}
      {#if facetPeriods.length > 0}
        <MultiSelect
          options={facetPeriods.map((p) => ({ value: p, label: workspace.nodes[p]?.title ?? p }))}
          selected={facet.periods}
          placeholder="period"
          onchange={(next) => setFacet('periods', next)}
        />
      {/if}
    </div>
  {/if}

  <div class="toolbar levels">
    <span class="label">Show down to</span>
    <span class="chips" role="group" aria-label="Expand to a level">
      {#each levels as level (level.depth)}
        <button
          type="button"
          title="Fold everything below {level.label}"
          onclick={() => (collapsed = foldToDepth(workspace.nodes, level.depth))}
        >
          {level.label}
        </button>
      {/each}
      <button type="button" title="Expand all" onclick={() => (collapsed = {})}>
        Everything
      </button>
    </span>
    <span class="hint">Second checkbox: include children.</span>
  </div>

  {#if columns.length > 0}
    <div class="toolbar columns">
      <span class="label">Columns</span>
      <span class="chips" role="group" aria-label="Show/hide columns">
        {#each columns as column (column.name)}
          <button
            type="button"
            title="Toggle {column.name.replace(/_/g, ' ')} column"
            onclick={() => {
              const next = new Set(hiddenColumns);
              if (hiddenColumns.has(column.name)) next.delete(column.name);
              else next.add(column.name);
              hiddenColumns = next;
            }}
          >
            {column.name.replace(/_/g, ' ')} {hiddenColumns.has(column.name) ? '☐' : '☑'}
          </button>
        {/each}
      </span>
    </div>
  {/if}

  <div class="scroll" bind:this={scroller} onscroll={onScroll}>
    <table>
      <thead>
        <tr>
          <th class="title sortable" onclick={() => sortBy('title')}>
            {scheduling ? 'Issue' : 'Template'}{sortIndicator('title')}
          </th>
          <th class="sortable" onclick={() => sortBy('type')}>
            Type{sortIndicator('type')}
          </th>
          {#if scheduling}
            <th class="sortable" onclick={() => sortBy('status')}>
              Status{sortIndicator('status')}
            </th>
            <th class="sortable" onclick={() => sortBy('assignee')}>
              Assignee{sortIndicator('assignee')}
            </th>
            {#if periodColumn}
              <th class="sortable" onclick={() => sortBy('period')}>
                Period{sortIndicator('period')}
              </th>
            {/if}
          {/if}
          {#each visibleColumns as column (column.name)}
            <th class="sortable" onclick={() => sortBy(column.name)}>
              {column.name.replace(/_/g, ' ')}{sortIndicator(column.name)}
            </th>
          {/each}
          <th title="Shown on the canvas">
            <span class="member-head">
              <input
                type="checkbox"
                checked={listed.length > 0 && inView === listed.length}
                indeterminate={inView > 0 && inView < listed.length}
                disabled={!listed.length}
                title={inView === listed.length
                  ? 'Remove all from the canvas'
                  : `Add all ${listed.length} to the canvas`}
                aria-label="Add all listed issues to the canvas"
                onchange={toggleAll}
              />
              View
            </span>
          </th>
          <th class="member" title="On the canvas with its children">Tree</th>
        </tr>
      </thead>
      <tbody>
        {#if window.topPad > 0}
          <tr style="height: {window.topPad}px" aria-hidden="true"></tr>
        {/if}
        {#each visibleRows as row (row.node.id)}
          <TableRow
            {row}
            config={workspace.config}
            columns={visibleColumns}
            {assignees}
            {periods}
            {scheduling}
            selected={workspace.selection.has(row.node.id)}
            inView={members.has(row.node.id)}
            subtreeInView={subtrees.get(row.node.id) ?? null}
            onselect={select}
            ontoggle={toggle}
            onedit={(id, patch) => editNode(workspace, id, patch)}
            onattribute={(id, name, value) =>
              editNode(workspace, id, { attributes: { [name]: value } })}
            ontoggleMembership={toggleMembership}
            oncontext={(id, event) => {
              // Shift-clicking rows and then right-clicking one is how a bulk
              // edit is asked for here, so a right-click inside the selection
              // leaves it alone — exactly as it does on the canvas.
              if (!workspace.selection.has(id)) workspace.selection.set([id]);
              shell.openMenu(event, nodeMenu({ workspace, shell, remote }, id));
            }}
          />
        {/each}
        {#if window.bottomPad > 0}
          <tr style="height: {window.bottomPad}px" aria-hidden="true"></tr>
        {/if}
      </tbody>
    </table>

    {#if !rows.length}
      <p class="empty">No issues match.</p>
    {/if}
  </div>
</div>

<style>
  .table-view {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  /*
   * The toolbars do not scroll and the table does, which is the whole trick:
   * the header used to be stuck to a guessed offset below a sticky toolbar, so
   * the moment the toolbar was a different height than the guess — another row
   * of buttons, a wrapped line — it slid down over the rows. Now the scroll
   * container starts below them and `th` sticks to its own top, which is a
   * fact rather than a measurement.
   */
  .toolbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }

  .toolbar.levels {
    padding-top: 0;
    padding-bottom: var(--space-2);
  }

  .label {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .chips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.15rem;
  }

  .chips button.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .search {
    flex: 0 1 20rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    font-size: var(--text-sm);
  }

  .count {
    margin-left: auto;
    color: var(--ink-muted);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .hint {
    margin-left: auto;
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  th.member {
    text-align: center;
  }

  .member-head {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }

  .toolbar button {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    padding: 0.15rem 0.5rem;
    font-size: var(--text-xs);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: var(--space-2);
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
    text-align: left;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--ink-muted);
    text-transform: capitalize;
    white-space: nowrap;
  }

  .empty {
    padding: var(--space-5);
    text-align: center;
    color: var(--ink-muted);
  }
</style>
