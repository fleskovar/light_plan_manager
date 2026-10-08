<script lang="ts">
  import { tick } from 'svelte';
  import Button from '$lib/ui/Button.svelte';
  import BlockedDialog from './BlockedDialog.svelte';
  import ChangesTable from './ChangesTable.svelte';
  import ConnectDialog from './ConnectDialog.svelte';
  import CoverageSection from './CoverageSection.svelte';
  import ConnectionPanel from './ConnectionPanel.svelte';
  import GitPanel from './GitPanel.svelte';
  import GitSetupDialog from './GitSetupDialog.svelte';
  import { panelMode, useGitState } from './git.svelte.js';
  import { useConnectionsState } from './connections.svelte.js';
  import {
    formatLastSync,
    formatLastSyncExact,
    formatValue,
    summarizeSync,
    useRemoteState,
    type ChangeFilter,
  } from './remote.svelte.js';

  /**
   * The Sync drawer tab: a remote, how far it has drifted, and the two buttons
   * that move work between the board and the tracker.
   *
   * The tracker half is experimental and drawn only when `remote.enabled`
   * (`lpm ui --experimental`). Without it the tab is git sharing alone — the
   * git panel, or the offer to set it up — and no tracker is named anywhere.
   *
   * Every decision lives in `remote.svelte.ts`; this component only asks the
   * state machine what to show and tells it what was clicked, which is what keeps
   * the tests DOM-free.
   *
   * ## The shape of the panel
   *
   * It used to be a flat stack of loose paragraphs — a scope line, two rows of
   * buttons, a status line, a denominator sentence — each one true and none of
   * them grouped, so a reader had to assemble the meaning themselves. It is now
   * three bands, in the order somebody reads them:
   *
   *   1. **the bar** — which remote, where it points, and the controls that are
   *      about the *connection* rather than about syncing;
   *   2. **the status card** — what state the mirror is in and the two buttons
   *      that change it, so the primary action is never below the evidence;
   *   3. **the evidence** — the counts and the table of documents behind them.
   *
   * The visual language is the drawer's own — a sticky toolbar over a scrolling
   * body, hairline borders, `--surface-1` cards — rather than a second one
   * invented here, and every colour is a token so light and dark both work.
   */
  const remote = useRemoteState();
  const connections = useConnectionsState();
  const git = useGitState();

  /**
   * A board is shared through git *or* mirrored onto trackers, never both, so
   * the tab holds one panel or the other. Until the git status has been read
   * it is the tracker panel, which is what a board with no git sync shows.
   */
  const mode = $derived(panelMode(git.status, remote.remotes.length));
  $effect(() => {
    void git.load();
  });

  /** Remote names already declared — the connect form will not reuse one. */
  const taken = $derived(remote.remotes.map((summary) => summary.name));
  /** Whether the selected remote's connection panel is open. */
  let showConnection = $state(false);
  /**
   * The evidence behind a count, brought to where the reader is looking.
   *
   * The panel is a scrolling body — on a 1440×760 screen it is 755px of content
   * in a 382px window — so the table sits well below the counts. Narrowing it
   * from up here changed something nobody could see, which is indistinguishable
   * from a button that does nothing, and was reported as exactly that twice.
   * The click filters *and* scrolls; clearing the filter does not scroll,
   * because the reader is already there.
   */
  let changesEl = $state<HTMLElement | null>(null);

  async function focusChanges(id: ChangeFilter): Promise<void> {
    remote.focusChanges(id);
    await tick();
    if (remote.changeFilter !== null) {
      changesEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /** Whether the window explaining what this remote cannot store is open. */
  let showBlocked = $state(false);

  // A remote that was just connected is tested straight away, and that result
  // is only any use on screen — so a completed connect opens its panel.
  $effect(() => {
    if (connections.lastConnect !== null) showConnection = true;
  });

  const name = $derived(remote.selected);
  const checked = $derived(name !== null && remote.hasDrift(name));
  const reading = $derived(name !== null && remote.driftState[name] === 'reading');
  const failed = $derived(name !== null && remote.driftState[name] === 'failed');
  const twins = $derived(name === null ? 0 : remote.twinCount(name));
  /**
   * When the full report on screen was actually checked — absent only while
   * `checked` is false. Shown beside "Checked against the tracker" so a
   * cached answer from an earlier session reads as exactly that rather than
   * passing for a check that just happened.
   */
  const checkedAt = $derived(name === null ? null : remote.driftCachedAt[name] ?? null);

  /**
   * A clock, so a long read shows that it is still going. Without one, silence is
   * indistinguishable from a hang — which is exactly how this panel used to read.
   */
  let now = $state(Date.now());
  $effect(() => {
    if (!reading) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const elapsed = $derived.by(() => {
    if (name === null) return '';
    const started = remote.driftStarted[name] ?? now;
    const seconds = Math.max(0, Math.round((now - started) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  });
</script>

<!--
  Sharing through git is offered whatever the server was started with; the
  tracker half below it only with `lpm ui --experimental`, which is the one
  thing `remote.enabled` says.
-->
{#snippet shareThroughGit(lead: string)}
  <p class="lead">{lead}</p>
  <p class="prose">
    Commit and push every board change to a git repository.
  </p>
  <Button variant={remote.enabled ? 'secondary' : 'primary'} onclick={() => git.openSetup()}>
    Set up git sync…
  </Button>
  <p class="prose faint">CLI: <code>lpm git setup</code></p>
{/snippet}

{#if mode === 'git'}
  <GitPanel />
{:else if !remote.enabled}
<div class="remote">
  <div class="welcome">
    {@render shareThroughGit('Git sync')}
  </div>
</div>
{:else}
<div class="remote">
  {#if remote.loading && !remote.remotes.length}
    <p class="placeholder">Loading remotes…</p>
  {:else if !remote.remotes.length}
    <div class="welcome">
      <p class="lead">No remotes</p>
      <p class="prose">
        Mirror this board to an issue tracker.
      </p>
      <Button variant="primary" onclick={() => void connections.openConnect(taken)}>
        Connect a remote…
      </Button>
      <p class="prose faint">CLI: <code>lpm remote connect</code></p>

      {#if git.status?.remotesOff.length}
        <!-- Turned off to share the board through git, and kept whole: one
             click puts a mirror back exactly as it was. -->
        <p class="lead">Turned off</p>
        <ul class="off">
          {#each git.status.remotesOff as name (name)}
            <li>
              <strong>{name}</strong>
              <span class="prose faint">settings and links kept</span>
              <Button size="sm" disabled={git.busy !== null} onclick={() => void git.turnOn(name)}>
                Turn on
              </Button>
            </li>
          {/each}
        </ul>
        <p class="prose faint">CLI: <code>lpm remote on &lt;name&gt;</code></p>
      {/if}

      {@render shareThroughGit('Or use git sync')}
    </div>
  {:else}
    <!--
      The bar carries what the panel is *about* and the controls that change the
      connection rather than the board. Sticky and hairline-bordered like every
      other drawer toolbar, so the tab reads as part of the app.
    -->
    <header class="bar">
      {#if remote.remotes.length > 1}
        <div class="segmented" role="tablist" aria-label="Remotes">
          {#each remote.remotes as summary (summary.name)}
            <button
              type="button"
              class="segment"
              class:selected={remote.selected === summary.name}
              role="tab"
              aria-selected={remote.selected === summary.name}
              onclick={() => remote.select(summary.name)}
            >
              {summary.name}
            </button>
          {/each}
        </div>
      {:else if remote.selected}
        <strong class="only">{remote.selected}</strong>
      {/if}

      {#if remote.report}
        <span class="target" title={remote.report.remote.target}>
          {remote.report.remote.provider} · {remote.report.remote.target}
        </span>
      {/if}

      <span class="spacer"></span>

      <span class="stamp" title={formatLastSyncExact(remote.report?.remote.lastSync ?? null)}>
        {remote.report?.remote.lastSync ? `synced ${formatLastSync(remote.report.remote.lastSync)}` : 'never synced'}
      </span>
      <!--
        There is deliberately no Refresh here. It re-read the board's own half
        of the report — which now happens on its own whenever the board
        changes — so next to "Check the tracker" it was a second button for
        one job that appeared to do nothing, and the only control that reaches
        the tracker should be the one that says so.
      -->
      <Button
        size="sm"
        onclick={() => (showConnection = !showConnection)}
        aria-expanded={showConnection}
      >
        Connection
      </Button>
      <Button size="sm" onclick={() => void connections.openConnect(taken)}>Connect…</Button>
    </header>

    <div class="body">
      {#if showConnection && remote.selected}
        <ConnectionPanel name={remote.selected} />
      {/if}

      {#if !remote.selected}
        <p class="placeholder">Select a remote.</p>
      {:else if !remote.report}
        <p class="placeholder">Loading…</p>
      {:else}
        <!--
          The status card: what state the mirror is in, and the two buttons that
          change it. It comes first so the primary action is never below the
          counts — the old panel put Preview and Sync after four blocks of
          evidence, which is the wrong way round for somebody who already knows
          what they want to do.
        -->
        <section class="card status">
          <div class="line">
            <span
              class="dot"
              class:live={reading || remote.syncing}
              class:bad={failed}
              class:ok={checked && !failed && !reading && !remote.syncing}
            ></span>
            <div class="what">
              {#if reading}
                <p class="head" aria-live="polite">Checking the tracker</p>
                <p class="sub">
                  {twins}
                  linked {twins === 1 ? 'issue' : 'issues'} · {elapsed}
                </p>
              {:else if remote.syncing}
                <p class="head" aria-live="polite">Syncing</p>
                <p class="sub">
                  {#if remote.progress}
                    {remote.progress.kind}
                    {remote.progress.localId} — {remote.progress.index} of {remote.progress.total}
                  {:else}
                    Working…
                  {/if}
                </p>
              {:else if failed}
                <p class="head">Could not read the tracker</p>
                <p class="sub bad">{remote.driftError[remote.selected]}</p>
              {:else if checked}
                <p class="head">Checked</p>
                <p class="sub">
                  {remote.remoteRead === null
                    ? 'Board and tracker compared.'
                    : `Read ${remote.remoteRead} remote ${remote.remoteRead === 1 ? 'issue' : 'issues'}.`}
                  {#if checkedAt}
                    · checked {formatLastSync(checkedAt)}
                  {/if}
                </p>
              {:else}
                <p class="head">Not checked yet</p>
                <p class="sub">Showing local changes only</p>
              {/if}
            </div>
            <span class="spacer"></span>
            {#if reading}
              <Button size="sm" onclick={() => remote.cancelDrift(remote.selected!)}>Stop</Button>
            {:else if failed}
              <Button size="sm" onclick={() => void remote.checkDrift(remote.selected!)}>
                Try again
              </Button>
            {:else}
              <Button
                size="sm"
                onclick={() => void remote.checkDrift(remote.selected!)}
                disabled={remote.syncing}
              >
                {checked ? 'Check again' : 'Check tracker'}
              </Button>
            {/if}
          </div>

          {#if reading || remote.syncing}
            <div class="progress" role="presentation"><span class="sweep"></span></div>
          {/if}

          <div class="actions">
            <Button
              variant="primary"
              onclick={() => remote.pull(remote.selected!)}
              disabled={remote.syncing || remote.previewing || remote.syncBlocked}
            >
              {remote.syncing && remote.syncDirection === 'pull' ? 'Pulling…' : 'Pull'}
            </Button>
            <Button
              variant="primary"
              onclick={() => remote.push(remote.selected!)}
              disabled={remote.syncing || remote.previewing || remote.syncBlocked}
            >
              {remote.syncing && remote.syncDirection === 'push' ? 'Pushing…' : 'Push'}
            </Button>
            <Button
              onclick={() => remote.preview(remote.selected!)}
              disabled={remote.previewing || remote.syncing}
            >
              {remote.previewing ? 'Planning…' : 'Preview'}
            </Button>
            {#if remote.syncResult}
              <span class="result" aria-live="polite">{summarizeSync(remote.syncResult)}</span>
            {/if}
          </div>

          {#if remote.syncBlocked}
            <div class="warn">
              <p>
                Push this view's edits to the board before syncing.
              </p>
              <Button size="sm" variant="primary" onclick={() => remote.pushFirst()}>
                Push edits
              </Button>
            </div>
          {/if}
        </section>

        <!--
          The three numbers somebody acts on, then the three that are true and not
          today's problem. Which row a number is in is decided in
          `remote.svelte.ts`; this only draws them.
        -->
        <div class="stats">
          {#each remote.primaryTiles as tile (tile.id)}
            <button
              type="button"
              class="stat stat-{tile.id}"
              class:unknown={tile.count === null}
              class:empty={tile.count === 0}
              title={tile.count === null
                ? `${tile.hint} (check tracker first)`
                : tile.hint}
              disabled={tile.count === null || tile.count === 0}
              aria-pressed={remote.changeFilter === tile.id}
              class:on={remote.changeFilter === tile.id}
              onclick={() => void focusChanges(tile.id)}
            >
              <span class="n">{tile.count ?? '—'}</span>
              <span class="l">{tile.label}</span>
            </button>
          {/each}
        </div>

        <div class="chips">
          {#each remote.secondaryTiles as tile (tile.id)}
            <button
              type="button"
              class="chip"
              class:empty={tile.count === 0}
              title={tile.hint}
              disabled={tile.count === null || tile.count === 0}
              aria-haspopup={tile.id === 'blocked' ? 'dialog' : undefined}
              onclick={() => {
                // `blocked` opens a window of its own. It used to expand a
                // section here, and a section here is a standing reminder of
                // things that are often not defects at all — a board that
                // assigns work to pools, a tracker with nowhere to put a field.
                // Most will not be closed this week and some never will, so the
                // number stays on the panel and the explanation is one click
                // away. Selecting its ids on the canvas was the behaviour before
                // that, and it looked broken: a view holds a few dozen nodes, so
                // selecting 428 documents lit up almost nothing.
                if (tile.id === 'blocked') showBlocked = true;
                else remote.selectBucket(tile.id);
              }}
            >
              <span class="n">{tile.count ?? '—'}</span>
              <span class="l">{tile.label}</span>
            </button>
          {/each}
        </div>

        <!--
          Which documents, and why. The counts answer "how much"; this answers the
          question a reader actually has the moment one of them is not zero.
        -->
        <div bind:this={changesEl}>
          <ChangesTable
            rows={remote.changeRows}
          reasons={remote.blockedReasons}
            filter={remote.changeFilter}
            total={remote.changeTotal}
            onclear={() => remote.clearChangeFilter()}
            onselect={(id) => remote.selectDocument(id)}
          />
        </div>
      {/if}

      <!-- Coverage reads the board and the link store, so it answers whether or
           not the drift report above has come back from the tracker. -->
      {#if remote.selected}
        <CoverageSection />
      {/if}

      {#if remote.previewResult}
        <section class="card preview">
          <header class="preview-head">
            <h3>Preview</h3>
            <span class="faint">nothing is written</span>
          </header>

          {#if remote.previewResult.preflight.length}
            <div class="group">
              <h4>preflight <span class="tally">{remote.previewResult.preflight.length}</span></h4>
              <ul class="problems">
                {#each remote.previewResult.preflight as problem (problem.message)}
                  <li class="problem {problem.level}">{problem.message}</li>
                {/each}
              </ul>
            </div>
          {/if}

          {#each remote.previewResult.renders as render (render.direction)}
            <div class="group">
              <h4>{render.direction} <span class="tally">{render.total}</span></h4>
              {#if render.sections.length === 0}
                <p class="faint">Nothing to do.</p>
              {/if}
              {#each render.sections as section (section.kind)}
                <h5>{section.label} <span class="tally">{section.count}</span></h5>
                <ul class="docs">
                  {#each section.documents as doc (section.kind + doc.localId)}
                    <li class="doc">
                      <p class="doc-head">
                        <span class="doc-id">{doc.localId}</span>
                        {#if doc.title}<span class="doc-title">{doc.title}</span>{/if}
                        {#if doc.remoteId}<span class="faint">({doc.remoteId})</span>{/if}
                      </p>
                      {#if doc.fields.length}
                        <table class="fields">
                          <tbody>
                            {#each doc.fields as field (`${section.kind}-${doc.localId}-${field.field}`)}
                              <tr>
                                <th>{field.field}</th>
                                <td class="from">{formatValue(field.local)}</td>
                                <td class="to">{formatValue(field.remote)}</td>
                                <td class="outcome">{field.outcome}</td>
                              </tr>
                            {/each}
                          </tbody>
                        </table>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/each}
            </div>
          {/each}
        </section>
      {/if}
    </div>
  {/if}
</div>
{/if}

{#if git.draft && mode !== 'git'}
  <GitSetupDialog onclose={() => git.closeSetup()} />
{/if}

{#if remote.enabled && showBlocked}
  <BlockedDialog onclose={() => (showBlocked = false)} />
{/if}

{#if remote.enabled && connections.draft}
  <ConnectDialog {taken} onclose={() => connections.closeConnect()} />
{/if}

<style>
  .remote {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  /* ---------------------------------------------------------------- the bar */

  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .bar .only {
    font-size: var(--text-sm);
  }

  .bar .target,
  .bar .stamp {
    font-size: var(--text-xs);
    color: var(--ink-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bar .target {
    min-width: 0;
  }

  .spacer {
    flex: 1;
  }

  /* A segmented control, the shape the other drawers use for a mode. */
  .segmented {
    display: inline-flex;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2);
  }

  .segment {
    padding: 0.1rem 0.5rem;
    border: none;
    border-radius: calc(var(--radius-md) - 3px);
    background: none;
    font-size: var(--text-xs);
    color: var(--ink-muted);
    cursor: pointer;
    transition:
      background var(--duration-fast),
      color var(--duration-fast);
  }

  .segment:hover {
    color: var(--ink);
  }

  .segment.selected {
    background: var(--surface-1);
    box-shadow: var(--shadow-sm);
    color: var(--ink);
    font-weight: 600;
  }

  /* --------------------------------------------------------------- the body */

  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
  }

  .placeholder {
    margin: 0;
    padding: var(--space-4) var(--space-3);
    font-size: var(--text-sm);
    color: var(--ink-muted);
  }

  .faint {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  /* ------------------------------------------------------- the status card */

  .status {
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .status .line {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .status .what {
    min-width: 0;
  }

  .status .head {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .status .sub {
    margin: 0.1rem 0 0;
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .status .sub.bad {
    color: var(--danger);
  }

  /* One dot carries the state, so the card needs no coloured banner. */
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    margin-top: 0.3rem;
    border-radius: 50%;
    background: var(--ink-faint);
  }

  .dot.ok {
    background: var(--tone-done);
  }

  .dot.bad {
    background: var(--danger);
  }

  .dot.live {
    background: var(--accent);
    animation: pulse 1.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }

  /* An indeterminate sweep: the read is a handful of requests, so a percentage
     would be invented — but silence reads as a hang. */
  .progress {
    height: 2px;
    border-radius: 1px;
    background: var(--surface-3);
    overflow: hidden;
  }

  .progress .sweep {
    display: block;
    width: 35%;
    height: 100%;
    border-radius: 1px;
    background: var(--accent);
    animation: sweep 1.1s ease-in-out infinite;
  }

  @keyframes sweep {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(340%);
    }
  }

  .status .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .status .result {
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .status .warn {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--highlight-soft);
  }

  .status .warn p {
    margin: 0;
    flex: 1;
    font-size: var(--text-xs);
    color: var(--ink);
  }

  /* ------------------------------------------------------------- the counts */

  /* Capped, not stretched: three numbers spread across a wide drawer read as
     three mostly-empty billboards. They cluster from the left and grow only as
     far as they need, then wrap on a narrow panel. */
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(7rem, 11rem));
    gap: var(--space-2);
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    text-align: left;
    cursor: pointer;
    transition:
      border-color var(--duration-fast),
      box-shadow var(--duration-fast),
      transform var(--duration-fast);
  }

  /* The accent edge is what makes three numbers read as three *kinds* of number
     without colouring a whole card. */
  .stat::before {
    content: '';
    display: block;
    width: 1.5rem;
    height: 2px;
    border-radius: 1px;
    margin-bottom: 0.25rem;
    background: currentColor;
    opacity: 0.85;
  }

  .stat .n {
    font-size: var(--text-xl);
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    line-height: 1.05;
    color: var(--ink);
  }

  .stat .l {
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .stat:hover:not(:disabled) {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-sm);
    transform: translateY(-1px);
  }

  .stat:disabled {
    cursor: default;
  }

  /* An empty or unknown count keeps its place — the row must not reflow as a
     sync lands — but stops asking for attention. */
  .stat.empty,
  .stat.unknown {
    color: var(--ink-faint);
  }

  .stat.empty .n,
  .stat.unknown .n {
    color: var(--ink-faint);
    font-weight: 500;
  }

  .stat-pending {
    color: var(--sync-ahead);
  }

  .stat-behind {
    color: var(--sync-behind);
  }

  .stat-conflicted {
    color: var(--sync-conflicted);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3rem;
    padding: 0.1rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-1);
    font-size: var(--text-xs);
    color: var(--ink-muted);
    cursor: pointer;
    transition:
      border-color var(--duration-fast),
      color var(--duration-fast);
  }

  .chip:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--ink);
  }

  .chip:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .chip .n {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--ink);
  }

  .chip.empty .n {
    font-weight: 500;
    color: var(--ink-faint);
  }



















  /* ------------------------------------------------------------ the welcome */

  .welcome {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-5) var(--space-4);
    max-width: 30rem;
  }

  .welcome .lead {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
  }

  .welcome .prose {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--ink-muted);
    line-height: 1.5;
  }

  .off {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-self: stretch;
  }

  .off li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  .off .prose {
    flex: 1;
  }

  code {
    padding: 0.05rem 0.3rem;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  /* ------------------------------------------------------------ the preview */

  .preview {
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .preview-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .preview h3 {
    margin: 0;
    font-size: var(--text-sm);
  }

  .preview h4,
  .preview h5 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ink-faint);
    font-weight: 600;
  }

  .preview h5 {
    margin-top: var(--space-2);
    text-transform: none;
    letter-spacing: 0;
    color: var(--ink-muted);
  }

  .tally {
    display: inline-block;
    min-width: 1.1rem;
    padding: 0 0.3rem;
    border-radius: 999px;
    background: var(--surface-2);
    text-align: center;
    font-variant-numeric: tabular-nums;
    color: var(--ink-muted);
  }

  .group {
    display: flex;
    flex-direction: column;
  }

  .problems,
  .docs {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .problem {
    padding: 0.15rem 0;
    font-size: var(--text-xs);
  }

  .problem.error {
    color: var(--danger);
  }

  .problem.warn {
    color: var(--warn);
  }

  .doc {
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--surface-2);
  }

  .doc:last-child {
    border-bottom: none;
  }

  .doc-head {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  .doc-id {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .fields {
    width: 100%;
    margin-top: var(--space-1);
    border-collapse: collapse;
    font-size: var(--text-xs);
  }

  .fields th {
    width: 7rem;
    padding: 0.1rem var(--space-2) 0.1rem 0;
    text-align: left;
    font-weight: 400;
    color: var(--ink-faint);
  }

  .fields td {
    padding: 0.1rem var(--space-2) 0.1rem 0;
    color: var(--ink-muted);
  }

  .fields .to {
    color: var(--ink);
  }

  .fields .outcome {
    width: 4rem;
    text-align: right;
    color: var(--ink-faint);
  }
</style>
