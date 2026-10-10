<script lang="ts">
  import type { AttributeDto, ConfigDto, NodeDto } from '$shared';
  import { flagLabel, plansWithPeriods } from '$shared';
  import AttributeField from '$lib/ui/fields/AttributeField.svelte';
  import LazySelect from '$lib/ui/fields/LazySelect.svelte';
  import StatusChip from '$lib/ui/StatusChip.svelte';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import type { TableRow } from './rows.js';

  /**
   * One row. Presentational: it renders the values it is handed and reports the
   * edits back, so the table above it owns every decision about what an edit
   * means.
   */
  interface Props {
    row: TableRow;
    config: ConfigDto;
    selected: boolean;
    inView: boolean;
    /**
     * How much of what is *under* this issue is on the canvas — `null` for a
     * leaf, which has no subtree box at all.
     */
    subtreeInView: 'none' | 'some' | 'all' | null;
    columns: AttributeDto[];
    assignees: NodeDto[];
    periods: NodeDto[];
    /**
     * Draw the status, assignee and period cells. Off in a registry view: a
     * template is the shape of a piece of work and has none of the three.
     */
    scheduling?: boolean;
    onselect: (id: string, event: MouseEvent) => void;
    ontoggle: (id: string) => void;
    onedit: (id: string, patch: Record<string, unknown>) => void;
    onattribute: (id: string, name: string, value: unknown) => void;
    /** `subtree` puts everything under the issue on the canvas as well. */
    ontoggleMembership: (id: string, subtree: boolean) => void;
    oncontext: (id: string, event: MouseEvent) => void;
  }

  let {
    row,
    config,
    selected,
    inView,
    subtreeInView,
    columns,
    assignees,
    periods,
    scheduling = true,
    onselect,
    ontoggle,
    onedit,
    onattribute,
    ontoggleMembership,
    oncontext,
  }: Props = $props();

  const issue = $derived(row.node.kind === 'issue' ? row.node : null);

  const assigneeOptions = $derived(
    assignees.map((resource) => ({ value: resource.id, label: resource.title })),
  );
  const periodOptions = $derived(
    periods.map((period) => ({ value: period.id, label: period.title })),
  );
</script>

<tr
  class:selected
  data-row={row.node.id}
  onclick={(event) => onselect(row.node.id, event)}
  oncontextmenu={(event) => oncontext(row.node.id, event)}
>
  <td class="title" style="--depth: {row.depth}">
    <!-- The flex row lives on a wrapper, not on the `td`: a table cell told to
         be a flex container stops being a table cell, so the browser wraps it
         in an anonymous one and this cell's border-bottom is drawn at the
         bottom of its *content* instead of the bottom of the row. That is a
         couple of pixels out of line with every other column. -->
    <div class="cell">
      <span class="indent"></span>
      {#if row.hasChildren}
        <button
          class="twisty"
          class:open={row.expanded}
          type="button"
          aria-label={row.expanded ? 'Collapse' : 'Expand'}
          onclick={(event) => {
            event.stopPropagation();
            ontoggle(row.node.id);
          }}
        >
          ▸
        </button>
      {:else}
        <span class="twisty"></span>
      {/if}
      <span class="icon"><TypeIcon type={row.node.type} depth={row.node.depth} /></span>
      <span class="id">{row.node.id}</span>
      {#if issue?.flag}
        <!-- Read-only here: raising or clearing one needs the comment that makes
             it actionable, and that lives in the side panel. -->
        <span class="flag" title="Flagged: {flagLabel(issue.flag)}">
          {flagLabel(issue.flag)}
        </span>
      {/if}
      <input
        class="name"
        value={row.node.title}
        onclick={(event) => event.stopPropagation()}
        onchange={(event) => onedit(row.node.id, { title: event.currentTarget.value })}
      />
    </div>
  </td>

  <td class="type">{config.types[row.node.type]?.label ?? row.node.type}</td>

  {#if scheduling}
    <td>
      {#if issue}
        <StatusChip
          {config}
          status={issue.status}
          editable
          onchange={(status) => onedit(row.node.id, { status })}
        />
      {/if}
    </td>

    <td>
      {#if issue && config.hasResources}
        <LazySelect
          value={issue.assignee ?? ''}
          options={assigneeOptions}
          onchange={(value) => onedit(row.node.id, { assignee: value || null })}
        />
      {/if}
    </td>

    {#if plansWithPeriods(config)}
      <td>
        {#if issue}
          <LazySelect
            value={issue.period ?? ''}
            options={periodOptions}
            onchange={(value) => onedit(row.node.id, { period: value || null })}
          />
        {/if}
      </td>
    {/if}
  {/if}

  {#each columns as column (column.name)}
    <td class="attribute">
      {#if config.types[row.node.type]?.attributes.some((entry) => entry.name === column.name)}
        <AttributeField
          attribute={column}
          value={row.node.attributes[column.name]}
          compact
          onchange={(value) => onattribute(row.node.id, column.name, value)}
        />
      {/if}
    </td>
  {/each}

  <td class="member">
    <input
      type="checkbox"
      checked={inView}
      title={inView ? 'Remove from the canvas' : 'Add to the canvas'}
      aria-label="On the canvas"
      onclick={(event) => event.stopPropagation()}
      onchange={() => ontoggleMembership(row.node.id, false)}
    />
  </td>

  <!-- Its own box rather than a modifier on the one beside it: taking a branch
       is common enough that it should be visible, not remembered. -->
  <td class="member">
    {#if subtreeInView}
      <input
        type="checkbox"
        checked={subtreeInView === 'all'}
        indeterminate={subtreeInView === 'some'}
        title={subtreeInView === 'all'
          ? 'Remove this issue and its children from the canvas'
          : 'Add this issue and its children to the canvas'}
        aria-label="Subtree on the canvas"
        onclick={(event) => event.stopPropagation()}
        onchange={() => ontoggleMembership(row.node.id, true)}
      />
    {/if}
  </td>
</tr>

<style>
  tr:hover {
    background: var(--surface-2);
  }

  /* Selected anywhere — canvas, Gantt, here — and the list scrolls to it, so
     the row has to be findable at a glance once it arrives. */
  tr.selected {
    background: var(--accent-soft);
    box-shadow: inset 3px 0 0 var(--accent);
  }

  td {
    padding: 0.1rem var(--space-2);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    height: 2rem; /* fixed for virtual-scroll windowing; matches ROW_HEIGHT in TableView */
    /* Every cell centres its content in that height. Without this the cells
       are baseline-aligned and the title column — which centres its own
       contents — sits a little lower than its neighbours. */
    vertical-align: middle;
  }

  .title {
    min-width: 22rem;
  }

  /* See the note in the markup: this is a wrapper precisely so the `td` above
     it stays a table cell and its border stays on the row's baseline. */
  .cell {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .indent {
    width: calc(var(--depth) * 1.1rem);
    flex: none;
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

  .icon {
    display: inline-flex;
    color: var(--ink-muted);
  }

  .id {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .flag {
    flex: none;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--danger);
    color: var(--danger-ink);
    font-size: var(--text-xs);
    font-weight: 700;
    white-space: nowrap;
  }

  .name {
    flex: 1;
    min-width: 8rem;
    padding: 0.15rem 0.3rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
  }

  .name:hover,
  .name:focus {
    border-color: var(--border);
    background: var(--surface-0);
  }

  .type {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .attribute {
    max-width: 9rem;
  }

  .member {
    text-align: center;
  }
</style>
