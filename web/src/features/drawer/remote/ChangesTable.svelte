<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import type { ChangeFilter, ChangeRow } from './remote.svelte.js';

  /**
   * Every document a sync would touch, and why.
   *
   * The counts above answer "how much"; this answers "which, and why", which is
   * the question anybody has the moment a number is not zero. Purely
   * presentational: the rows, their direction and their field values are all
   * decided in `remote.svelte.ts` off the report's own per-field detail, so a row
   * can never tell a different story from the tile that led the reader here.
   */
  interface Props {
    rows: ChangeRow[];
    /** Why a blocked row cannot land, keyed by local id. */
    reasons: ReadonlyMap<string, string>;
    /** The tile the table is narrowed to, or null for everything. */
    filter?: ChangeFilter | null;
    /** How many rows there are without the filter. */
    total?: number;
    /** Stop narrowing. */
    onclear?: () => void;
    /** Show this document on the canvas. */
    onselect: (id: string) => void;
  }

  let { rows, reasons, filter = null, total, onclear, onselect }: Props = $props();

  /** What the filter is called, in the same words as the tile that set it. */
  const FILTERS: Record<ChangeFilter, string> = {
    pending: 'to push',
    behind: 'to pull',
    conflicted: 'conflicts',
  };

  /** How many rows to draw before the rest are summarised. */
  const PAGE = 40;
  let expanded = $state(false);
  const shown = $derived(expanded ? rows : rows.slice(0, PAGE));

  const LABELS: Record<ChangeRow['direction'], string> = {
    conflict: 'conflict',
    pull: 'to pull',
    create: 'to pull · new',
    push: 'to push',
  };

  /** What the direction means for this row, in one phrase. */
  const WHY: Record<ChangeRow['direction'], string> = {
    conflict: 'changed on both sides since the last sync',
    pull: 'changed on the tracker only',
    create: 'new on the tracker',
    push: 'changed on the board only',
  };
</script>

{#if rows.length > 0 || filter !== null}
  <section class="changes">
    <header class="head">
      <h3>Changes</h3>
      <span class="tally">{rows.length}</span>
      {#if filter !== null}
        <button type="button" class="filter" onclick={() => onclear?.()}>
          {FILTERS[filter]} ×
        </button>
        {#if total !== undefined && total > rows.length}
          <span class="hint">of {total}</span>
        {/if}
      {/if}
      <span class="spacer"></span>
      <span class="hint">what a sync would change</span>
    </header>

    {#if rows.length === 0}
      <p class="empty">
        Nothing {FILTERS[filter!]}.
      </p>
    {/if}
    {#if rows.length > 0}
    <table>
      <thead>
        <tr>
          <th>document</th>
          <th>direction</th>
          <th>what changed</th>
        </tr>
      </thead>
      <tbody>
        {#each shown as row (row.key)}
          <tr class:blocked={row.blocked}>
            <td class="doc">
              {#if row.localId}
                <button type="button" class="link" onclick={() => onselect(row.localId!)}>
                  {row.localId}
                </button>
              {:else}
                <span class="id">{row.remoteKey}</span>
              {/if}
              <span class="title">{row.title}</span>
            </td>
            <td class="dir">
              <span class="pill pill-{row.direction}" title={WHY[row.direction]}>
                {LABELS[row.direction]}
              </span>
              {#if row.blocked}<span class="tag">blocked</span>{/if}
            </td>
            <td class="what">
              {#if row.blocked && row.localId && reasons.has(row.localId)}
                <span class="reason">{reasons.get(row.localId)}</span>
              {:else if row.fields.length === 0}
                <span class="reason">{WHY[row.direction]}</span>
              {:else}
                {#each row.fields as field (field.field)}
                  <span class="field">
                    <span class="name">{field.field}</span>
                    <span class="was">{field.local}</span>
                    <span class="arrow">{row.direction === 'pull' || row.direction === 'create' ? '←' : '→'}</span>
                    <span class="now">{field.remote}</span>
                  </span>
                {/each}
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {/if}

    {#if rows.length > PAGE}
      <p class="more">
        <Button size="sm" onclick={() => (expanded = !expanded)}>
          {expanded ? `Show the first ${PAGE}` : `Show all ${rows.length}`}
        </Button>
      </p>
    {/if}
  </section>
{/if}

<style>
  .filter {
    padding: 0.1rem 0.5rem;
    border: 1px solid var(--accent);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--accent);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .empty {
    margin: 0;
    padding: var(--space-3) 0;
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }

  .changes {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .head h3 {
    margin: 0;
    font-size: var(--text-sm);
  }

  .tally {
    min-width: 1.1rem;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--surface-2);
    text-align: center;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--ink-muted);
  }

  .spacer {
    flex: 1;
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--ink-faint);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  th {
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--surface-2);
    background: var(--surface-2);
    text-align: left;
    font-size: var(--text-xs);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ink-faint);
  }

  td {
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--surface-2);
    vertical-align: top;
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  tbody tr {
    transition: background var(--duration-fast);
  }

  tbody tr:hover {
    background: var(--surface-2);
  }

  /* A blocked row is evidence, not an action — it is drawn quieter, and it must
     not be so quiet that a reader cannot read the reason beside it. */
  tr.blocked td {
    color: var(--ink-faint);
  }

  .doc {
    white-space: nowrap;
  }

  .doc .link,
  .doc .id {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .doc .link {
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 2px;
  }

  .doc .link:hover {
    color: var(--accent);
  }

  .doc .title {
    margin-left: var(--space-2);
    color: var(--ink);
  }

  .dir {
    white-space: nowrap;
  }

  /* The direction is the one thing a reader scans for, so it is a pill rather
     than a word in a column of words. Soft fills, because three saturated
     badges per screen is a warning light, not a table. */
  .pill {
    display: inline-block;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    font-size: var(--text-xs);
    font-weight: 500;
    white-space: nowrap;
  }

  .pill-conflict {
    background: var(--tone-blocked-soft);
    color: var(--sync-conflicted);
  }

  .pill-pull,
  .pill-create {
    background: var(--highlight-soft);
    color: var(--sync-behind);
  }

  .pill-push {
    background: var(--tone-done-soft);
    color: var(--sync-ahead);
  }

  .tag {
    margin-left: var(--space-1);
    font-size: var(--text-xs);
    color: var(--ink-faint);
  }

  .what {
    font-size: var(--text-xs);
    color: var(--ink-muted);
    /* The diff column takes whatever is left and never pushes the table wider
       than the drawer; `table-layout: fixed` would be the other half of this,
       but the first two columns want to size to their content. */
    max-width: 0;
    width: 100%;
  }

  /* One field per line, the name in a fixed gutter, so a column of rows lines
     up and the values can be compared down the page rather than hunted for. */
  .field {
    display: grid;
    grid-template-columns: 7rem 1fr auto 1fr;
    align-items: baseline;
    gap: var(--space-2);
  }

  .field .name {
    font-family: var(--font-mono);
    color: var(--ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    /* A grid child's default `min-width: auto` refuses to shrink below its
       content, so without this a body diff — a whole markdown document on one
       line — blows the row out instead of ellipsing. */
    min-width: 0;
  }

  .field .was,
  .field .now {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .field .was {
    color: var(--ink-faint);
  }

  .field .now {
    color: var(--ink);
  }

  .field .arrow {
    color: var(--ink-faint);
  }

  .reason {
    color: var(--ink-faint);
  }

  .more {
    margin: 0;
    padding: var(--space-2);
    border-top: 1px solid var(--surface-2);
    text-align: center;
  }
</style>
