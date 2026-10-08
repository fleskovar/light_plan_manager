<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import { coverageRelationInfo, summarizeCoverage, type CoverageGap } from '$shared';
  import { useRemoteState } from './remote.svelte.js';

  /**
   * Coverage: what this remote is missing around what it already holds.
   *
   * Filing a plan one piece at a time is the supported thing to do, and the
   * shape heals when the rest arrives — but nothing said what the piece was
   * missing. This lists exactly that, grouped by what each gap costs, with a
   * tick beside every row and one button that pushes the ticked ones.
   *
   * Presentational, like the rest of the drawer: the analysis is the server's
   * (`src/remote/coverage.ts`), the ticks and the push live in the state
   * machine, and this file only asks what to draw.
   */
  const remote = useRemoteState();

  const report = $derived(remote.coverageReport);
  const picked = $derived(remote.pickedIds);

  /** Gaps by id, so a group can render its rows without a second pass. */
  const byId = $derived(new Map((report?.gaps ?? []).map((gap) => [gap.id, gap])));

  /** Rows are capped: a first push of one feature can leave hundreds behind. */
  const LIMIT = 12;
  let expanded = $state<Record<string, boolean>>({});

  function rowsOf(ids: string[], relation: string): CoverageGap[] {
    const gaps = ids.map((id) => byId.get(id)).filter((gap): gap is CoverageGap => gap !== undefined);
    return expanded[relation] === true ? gaps : gaps.slice(0, LIMIT);
  }

  /** The other reasons a row has, so a gap is never listed twice as a surprise. */
  function alsoBecause(gap: CoverageGap, relation: string): string {
    const others = gap.reasons.filter((reason) => reason.relation !== relation);
    if (others.length === 0) return '';
    return `also ${others.map((reason) => coverageRelationInfo(reason.relation).short).join('; ')}`;
  }

  function anchorsOf(gap: CoverageGap, relation: string): string {
    const reason = gap.reasons.find((entry) => entry.relation === relation);
    if (reason === undefined) return '';
    const names = reason.anchors.join(', ');
    return reason.count > reason.anchors.length ? `${names} +${reason.count - reason.anchors.length}` : names;
  }
</script>

{#if report === null}
  <section class="coverage">
    <header><h3>Coverage</h3></header>
    {#if remote.selected && remote.coverageError[remote.selected]}
      <p class="hint failed">{remote.coverageError[remote.selected]}</p>
      <div class="actions">
        <Button size="sm" onclick={() => void remote.loadCoverage(remote.selected!)}>Try again</Button>
      </div>
    {:else}
      <p class="hint">Checking coverage…</p>
    {/if}
  </section>
{:else}
  <section class="coverage">
    <header>
      <h3>Coverage</h3>
      <span class="muted">{summarizeCoverage(report)}</span>
      <span class="spacer"></span>
      <Button size="sm" onclick={() => void remote.loadCoverage(report.remote.name)} disabled={remote.coverageLoading}>
        {remote.coverageLoading ? 'Reading…' : 'Recheck'}
      </Button>
    </header>

    {#if report.gaps.length === 0}
      <p class="hint">
        Nothing missing.
      </p>
    {:else}
      {#each report.groups as group (group.relation)}
        {@const info = coverageRelationInfo(group.relation)}
        <div class="group">
          <div class="group-head">
            <h4>{info.label} <span class="count">{group.ids.length}</span></h4>
            <button type="button" class="link" onclick={() => remote.pickGroup(group.relation)}>
              select all
            </button>
          </div>
          <p class="consequence">{info.consequence}</p>
          <ul class="rows">
            {#each rowsOf(group.ids, group.relation) as gap (gap.id)}
              <li class="row">
                <label>
                  <input
                    type="checkbox"
                    checked={remote.picked[gap.id] === true}
                    onchange={() => remote.pick(gap.id)}
                    disabled={remote.syncing}
                  />
                  <span class="id">{gap.id}</span>
                  <span class="type">{gap.type}</span>
                  <span class="title">{gap.title}</span>
                </label>
                <span class="why" title={alsoBecause(gap, group.relation)}>
                  {anchorsOf(gap, group.relation)}
                </span>
              </li>
            {/each}
          </ul>
          {#if group.ids.length > LIMIT}
            <button
              type="button"
              class="link"
              onclick={() => (expanded = { ...expanded, [group.relation]: expanded[group.relation] !== true })}
            >
              {expanded[group.relation] === true
                ? 'show fewer'
                : `show all ${group.ids.length}`}
            </button>
          {/if}
        </div>
      {/each}

      <div class="actions">
        <Button
          variant="primary"
          disabled={picked.length === 0 || remote.syncing || remote.syncBlocked}
          onclick={() => void remote.pushPicked()}
        >
          {remote.syncing ? 'Pushing…' : `Push ${picked.length} selected`}
        </Button>
        <Button size="sm" disabled={picked.length === 0} onclick={() => remote.selectPicked()}>
          Show on canvas
        </Button>
        <Button size="sm" disabled={picked.length === 0} onclick={() => remote.pickNone()}>Clear</Button>
      </div>
    {/if}

    {#if report.decoupled.length > 0 || report.outOfScope.length > 0}
      <p class="hint">
        {#if report.decoupled.length > 0}
          {report.decoupled.length} related {report.decoupled.length === 1 ? 'document is' : 'documents are'}
          decoupled from this remote.
        {/if}
        {#if report.outOfScope.length > 0}
          {report.outOfScope.length} {report.outOfScope.length === 1 ? 'is' : 'are'} outside this
          remote's scope.
        {/if}
      </p>
    {/if}
  </section>
{/if}

<style>
  /* A card like the rest of the tab. It used to be a section separated by
     `border-top: 1px solid var(--line)` — and `--line` is not a token this app
     defines, so the rule resolved to nothing and the separator was never drawn
     at all. */
  .coverage {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
  }

  header {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .spacer {
    flex: 1;
  }

  h3 {
    margin: 0;
    font-size: var(--text-sm);
  }

  h4 {
    margin: 0;
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }

  .muted,
  .hint,
  .consequence {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .hint,
  .consequence {
    margin: 0;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .group-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .count {
    color: var(--ink-faint);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 1px 0;
  }

  .row label {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex: 1;
    min-width: 0;
    cursor: pointer;
  }

  .id {
    font-variant-numeric: tabular-nums;
    color: var(--ink-muted);
  }

  .type {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .why {
    color: var(--ink-faint);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .hint.failed {
    color: var(--danger);
  }

  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }
</style>
