<script lang="ts">
  import type { ConfigDto, PeriodDto, SquadDto } from '$shared';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import { UNSCHEDULED } from './periods.js';
  import type { PeriodColumn } from './periods.js';

  /**
   * The header of one period box: title, fold button, grip, switch, badges
   * (now/paused/start/overdue), the "Fix…" affordance, dates, effort counts,
   * and the delete button.  The Unscheduled back-log column shares the same
   * markup but with most controls hidden.
   *
   * Presentational — every mutation is a callback.
   */
  interface Props {
    column: PeriodColumn;
    config: ConfigDto;
    squads: SquadDto[];
    folded: boolean;
    canTake: boolean;
    onfold: (key: string) => void;
    onedit: (key: string, patch: Record<string, unknown>) => void;
    onswitch: (key: string, active: boolean | null) => void;
    onstart: (key: string) => void;
    oncorrect: (key: string) => void;
    onremove: (key: string) => void;
    ontake: (key: string) => void;
  }

  let {
    column,
    config,
    squads,
    folded,
    canTake,
    onfold,
    onedit,
    onswitch,
    onstart,
    oncorrect,
    onremove,
    ontake,
  }: Props = $props();

  const period = $derived(column.period);
  const label = (type: string): string => config.types[type]?.label ?? type;

  const dates = $derived(
    period ? [period.starts, period.ends].filter(Boolean).join(' → ') : '',
  );

  const on = $derived(column.stance !== 'off');
  const nextSwitch = $derived<boolean | null>(
    column.stance === 'off' ? true : column.stance === 'on' ? null : false,
  );
  const switchTitle = $derived(
    column.stance === 'off'
      ? column.switchedOff
        ? 'Off. Click to turn on'
        : 'Off because the parent period is off'
      : column.stance === 'on'
        ? 'Always on. Click to follow dates'
        : 'Follows dates. Click to turn off',
  );
</script>

<header>
  <button
    class="twisty"
    class:open={!folded}
    type="button"
    title={folded ? 'Expand' : 'Collapse'}
    aria-label="{folded ? 'Expand' : 'Collapse'} {period?.title ?? 'the backlog'}"
    onclick={() => onfold(column.key)}
  >
    ▸
  </button>

  {#if period}
    <span
      class="grip"
      draggable="true"
      role="button"
      tabindex="-1"
      title="Drag to reorder"
      ondragstart={(event) => {
        event.dataTransfer?.setData('application/x-lpm-period', period.id);
        event.dataTransfer?.setData('text/plain', period.title);
      }}
    >
      ⠿
    </span>
    <span class="icon"><TypeIcon type={period.type} depth={period.depth} /></span>
    <input
      class="name"
      value={period.title}
      aria-label="Name of {period.id}"
      onchange={(event) => onedit(column.key, { title: event.currentTarget.value })}
    />
    <button
      class="switch"
      class:on
      class:inherited={column.stance === 'off' && !column.switchedOff}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="{on ? 'Switch off' : 'Switch on'} {period.title}"
      title={switchTitle}
      onclick={() => onswitch(column.key, nextSwitch)}
    >
      <span class="knob"></span>
    </button>

    {#if squads.length}
      <select
        class="squad"
        value={period.squad ?? ''}
        aria-label="Squad for {period.title}"
        title="Assign to a squad"
        onchange={(event) => onedit(column.key, { squad: event.currentTarget.value || null })}
      >
        <option value="">No squad</option>
        {#each squads as squad (squad.id)}
          <option value={squad.id}>{squad.title}</option>
        {/each}
      </select>
    {/if}

    {#if column.current}
      <span
        class="badge now"
        title={column.stance === 'on'
          ? 'On regardless of dates'
          : 'Today is in this period'}
      >
        ● now{column.stance === 'on' ? ' (switched on)' : ''}
      </span>
    {:else if column.stance === 'off'}
      <span
        class="badge paused"
        title={column.switchedOff
          ? 'Off: its work is held back from queues'
          : 'Its parent period is off'}
      >
        paused
      </span>
    {:else}
      <button
        class="badge start"
        type="button"
        title="Start today, keeping its length"
        onclick={() => onstart(column.key)}
      >
        Start now
      </button>
    {/if}

    {#if column.overdue}
      <span class="badge late" title="Ended {period.ends} with open work">
        ⚠ {column.open.length} open past {period.ends}
      </span>
      <button
        class="badge fix"
        type="button"
        title="Close or carry over open work"
        onclick={() => oncorrect(column.key)}
      >
        Fix…
      </button>
    {/if}

    <span class="kind">{label(period.type)}</span>
    <button
      class="remove"
      type="button"
      aria-label="Delete {period.title}"
      title="Delete period"
      onclick={() => onremove(column.key)}
    >
      ×
    </button>
  {:else}
    <span class="icon"><TypeIcon type="backlog" depth={3} /></span>
    <span class="name static">Unscheduled</span>
  {/if}
</header>

{#if folded}
  <p class="summary">
    {#if dates}<span class="when">{dates}</span>{/if}
    <span>{column.issues.length} issue{column.issues.length === 1 ? '' : 's'}</span>
    {#if config.effortAttribute && column.rolledEffort}
      <span>{column.rolledEffort} {config.effortAttribute.replace(/_/g, ' ')}</span>
    {/if}
    {#if column.children.length}
      <span>{column.children.length} inside</span>
    {/if}
  </p>
{:else}
  {#if period}
    <div class="dates">
      <input
        type="date"
        value={period.starts ?? ''}
        aria-label="Start of {period.id}"
        onchange={(event) => onedit(column.key, { starts: event.currentTarget.value })}
      />
      <span>→</span>
      <input
        type="date"
        value={period.ends ?? ''}
        aria-label="End of {period.id}"
        onchange={(event) => onedit(column.key, { ends: event.currentTarget.value })}
      />
    </div>
  {/if}

  <div class="meta">
    <span>{column.issues.length} issue{column.issues.length === 1 ? '' : 's'}</span>
    {#if config.effortAttribute}
      <span title="Effort scheduled directly here">
        {column.effort}
        {config.effortAttribute.replace(/_/g, ' ')}
      </span>
      {#if column.rolledEffort !== column.effort}
        <span class="faint" title="Including nested periods">
          {column.rolledEffort} in total
        </span>
      {/if}
    {/if}
    {#if canTake}
      <button
        class="take"
        type="button"
        title="Schedule the selected issues here"
        onclick={() => ontake(column.key)}
      >
        ← selection
      </button>
    {/if}
  </div>
{/if}

<style>
  header {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .icon {
    display: inline-flex;
    color: var(--ink-muted);
  }

  .kind {
    color: var(--ink-faint);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .name {
    flex: 1;
    min-width: 0;
    padding: 0.1rem 0.25rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    font-weight: 600;
    font-size: var(--text-sm);
  }

  .name:hover:not(.static),
  .name:focus {
    border-color: var(--border);
    background: var(--surface-0);
  }

  .dates {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-top: var(--space-1);
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .dates input {
    flex: none;
    width: 9.5rem;
    max-width: 45%;
    padding: 0.05rem 0.2rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-xs);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .faint {
    color: var(--ink-faint);
  }

  .take {
    margin-left: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    padding: 0 0.3rem;
    font-size: var(--text-xs);
  }

  .twisty {
    flex: none;
    width: 1rem;
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

  .grip {
    flex: none;
    padding: 0 0.15rem;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    line-height: 1;
    cursor: grab;
  }

  .grip:hover {
    color: var(--ink-muted);
  }

  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: var(--space-1) 0 0;
    padding-left: 1rem;
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .summary .when {
    font-family: var(--font-mono);
  }

  .badge {
    flex: none;
    padding: 0 0.35rem;
    border-radius: 999px;
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .badge.now {
    border: 1px solid var(--warn);
    background: color-mix(in srgb, var(--warn) 20%, transparent);
    color: var(--ink);
    font-weight: 600;
  }

  .badge.start {
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--ink-muted);
  }

  .badge.start:hover {
    border-color: var(--warn);
    color: var(--ink);
  }

  .badge.paused {
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--ink-faint);
  }

  .badge.late {
    border: 1px solid var(--danger);
    background: color-mix(in srgb, var(--danger) 18%, transparent);
    color: var(--ink);
    font-weight: 600;
  }

  .badge.fix {
    border: 1px solid var(--danger);
    background: var(--surface-1);
    color: var(--danger);
    font-weight: 600;
  }

  .badge.fix:hover {
    background: color-mix(in srgb, var(--danger) 15%, var(--surface-1));
  }

  .switch {
    flex: none;
    position: relative;
    width: 1.6rem;
    height: 0.85rem;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-0);
    cursor: pointer;
    transition: background var(--duration-fast), border-color var(--duration-fast);
  }

  .switch.on {
    border-color: var(--warn);
    background: color-mix(in srgb, var(--warn) 35%, var(--surface-0));
  }

  .switch.inherited {
    opacity: 0.5;
  }

  .knob {
    position: absolute;
    top: 50%;
    left: 0.1rem;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--ink-faint);
    transform: translateY(-50%);
    transition: left var(--duration-fast), background var(--duration-fast);
  }

  .switch.on .knob {
    left: calc(100% - 0.65rem);
    background: var(--warn);
  }

  .remove {
    flex: none;
    border: none;
    background: none;
    color: var(--ink-faint);
    line-height: 1;
    padding: 0 0.15rem;
  }

  .remove:hover {
    color: var(--danger);
  }

  .squad {
    flex: none;
    padding: 0 0.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-xs);
    max-width: 8rem;
    color: var(--ink-muted);
  }

  .squad:hover {
    border-color: var(--accent);
  }
</style>
