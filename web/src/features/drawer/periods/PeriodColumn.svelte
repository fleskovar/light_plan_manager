<script lang="ts">
  import type { ConfigDto } from '$shared';
  import type { SquadDto } from '$shared';
  import Self from './PeriodColumn.svelte';
  import PeriodCard from './PeriodCard.svelte';
  import PeriodColumnHeader from './PeriodColumnHeader.svelte';
  import type { PeriodColumn } from './periods.js';
  import { PERIOD_DROP_ATTRIBUTE, UNSCHEDULED } from './periods.js';
  import { readDropIntent } from './dragDrop.js';

  /**
   * One period, holding its own cards and the periods inside it.
   *
   * The recursive shell — composes PeriodColumnHeader, PeriodCard, and Self
   * for children. Drag-and-drop target logic (§3.1 dragDrop.ts carve) still
   * lives here because the three-phase state (idle/hovering/dropping) is
   * interleaved with the section element and `periodDropAt` lives beside the
   * component emitting `data-period-drop`.
   */
  interface Props {
    column: PeriodColumn;
    config: ConfigDto;
    /** Squads on the board, for picking one on a period. */
    squads: SquadDto[];
    /** Key of the box the pointer is over, so one target lights up at a time. */
    hovering: string | null;
    /** Issues are selected somewhere: offer to take them. */
    canTake: boolean;
    isSelected: (id: string) => boolean;
    onhover: (key: string | null) => void;
    ondropped: (key: string, issueId: string) => void;
    ontake: (key: string) => void;
    onopen: (id: string) => void;
    onedit: (periodId: string, patch: Record<string, unknown>) => void;
    onadd: (type: string, parentId: string) => void;
    onremove: (periodId: string) => void;
    onunschedule: (issueId: string) => void;
    onstart: (periodId: string) => void;
    onswitch: (periodId: string, active: boolean | null) => void;
    oncorrect: (periodId: string) => void;
    isFolded: (key: string) => boolean;
    onfold: (key: string) => void;
    onreorder: (movedId: string, targetId: string) => void;
  }

  let {
    column,
    config,
    squads,
    hovering,
    canTake,
    isSelected,
    onhover,
    ondropped,
    ontake,
    onopen,
    onedit,
    onadd,
    onremove,
    onunschedule,
    onstart,
    onswitch,
    oncorrect,
    isFolded,
    onfold,
    onreorder,
  }: Props = $props();

  const folded = $derived(isFolded(column.key));
  const period = $derived(column.period);
  const label = (type: string): string => config.types[type]?.label ?? type;

  function drop(event: DragEvent): void {
    const intent = readDropIntent(event);
    if (intent.kind === 'reorder' && period) {
      event.preventDefault();
      event.stopPropagation();
      onreorder(intent.periodId, column.key);
      return;
    }
    if (intent.kind === 'schedule') {
      event.preventDefault();
      event.stopPropagation();
      ondropped(column.key, intent.issueId);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section
  {...{ [PERIOD_DROP_ATTRIBUTE]: column.key }}
  class="column depth-{Math.min(column.depth, 2)}"
  class:over={hovering === column.key}
  class:backlog={column.key === UNSCHEDULED}
  class:nested={column.children.length > 0}
  class:current={column.current}
  class:holds={column.holdsCurrent}
  class:paused={column.stance === 'off'}
  class:late={column.overdue}
  ondragover={(event) => {
    event.preventDefault();
    event.stopPropagation();
    onhover(column.key);
  }}
  ondragleave={(event) => {
    event.stopPropagation();
    onhover(null);
  }}
  ondrop={drop}
>
  <PeriodColumnHeader
    {column}
    {config}
    {squads}
    {folded}
    {canTake}
    {onfold}
    {onedit}
    {onswitch}
    {onstart}
    {oncorrect}
    onremove={(key) => onremove(key)}
    ontake={(key) => ontake(key)}
  />

  {#if !folded}
    <div class="cards">
      {#each column.issues as issue (issue.id)}
        <PeriodCard
          {issue}
          {config}
          selected={isSelected(issue.id)}
          canUnschedule={column.key !== UNSCHEDULED}
          {onopen}
          {onunschedule}
        />
      {/each}

      {#if !column.issues.length}
        <p class="empty">
          {column.children.length ? 'Nothing scheduled here directly.' : 'Drop issues here.'}
        </p>
      {/if}
    </div>

    {#if column.children.length || column.childType}
      <div class="children">
        {#each column.children as child (child.key)}
          <Self
            column={child}
            {config}
            {squads}
            {hovering}
            {canTake}
            {isSelected}
            {onhover}
            {ondropped}
            {ontake}
            {onopen}
            {onedit}
            {onadd}
            {onremove}
            {onunschedule}
            {onstart}
            {onswitch}
            {oncorrect}
            {isFolded}
            {onfold}
            {onreorder}
          />
        {/each}

        {#if column.childType}
          <button class="add-child" type="button" onclick={() => onadd(column.childType!, column.key)}>
            + {label(column.childType)}
          </button>
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .column {
    flex: none;
    display: flex;
    flex-direction: column;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2);
  }

  .column.nested {
    background: var(--surface-3);
  }

  .column.backlog {
    background: var(--surface-1);
    border-style: dashed;
  }

  .column.over {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .column.current {
    border-color: var(--warn);
    box-shadow: inset 3px 0 0 var(--warn);
    background: color-mix(in srgb, var(--warn) 12%, var(--surface-2));
  }

  .column.holds:not(.current) {
    border-color: color-mix(in srgb, var(--warn) 55%, var(--border));
  }

  .column.paused {
    opacity: 0.72;
  }

  .column.paused,
  .column.paused.current,
  .column.paused.holds {
    border-color: var(--border);
    box-shadow: none;
    background: var(--surface-2);
  }

  .column.late,
  .column.late.current,
  .column.late.paused {
    border-color: var(--danger);
    box-shadow: inset 3px 0 0 var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, var(--surface-2));
  }

  .children {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-1);
    padding: var(--space-1);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--surface-0) 55%, transparent);
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-height: 1.5rem;
  }

  .add-child {
    flex: none;
    align-self: stretch;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-muted);
    padding: var(--space-2);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .add-child:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .empty {
    margin: auto 0;
    text-align: center;
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }
</style>
