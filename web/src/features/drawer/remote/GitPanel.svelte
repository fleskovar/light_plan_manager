<script lang="ts">
  import { useShell } from '$lib/app/shell.svelte.js';
  import Button from '$lib/ui/Button.svelte';
  import GitSetupDialog from './GitSetupDialog.svelte';
  import { gitSummary, nameList, useGitState } from './git.svelte.js';

  /**
   * The Sync tab when the board is shared through its own git repository: where
   * it is shared, what state it is in, and the few things a person can do about
   * it — sync now, settle a conflict, set it up again, turn it off.
   *
   * There is no Push or Pull here because there is nothing to push or pull by
   * hand: every change the editor makes is committed and pushed by the server as
   * it lands, and the board poll brings everybody else's in. Sync now exists for
   * what that cannot cover — edits made outside light-plan, work committed
   * offline, a conflict.
   *
   * Presentational: every decision is in `git.svelte.ts`. The bands and tokens
   * are the tracker panel's own, so the tab reads as one place whichever panel
   * it holds.
   */
  const git = useGitState();
  const shell = useShell();

  const status = $derived(git.status);
  const summary = $derived(status ? gitSummary(status) : null);
  const working = $derived(git.busy !== null);

  function turnOff(): void {
    // The trackers sharing turned off come back with one tick — the other
    // half of the swap the setup warning promised.
    const off = status?.remotesOff ?? [];
    shell.confirm({
      title: 'Turn off git sync?',
      message: 'Turns off git sync for everyone. The repository is not changed.',
      confirmLabel: 'Turn off',
      danger: true,
      ...(off.length
        ? {
            choice: {
              label: `Turn ${nameList(off)} back on`,
              checked: true,
            },
          }
        : {}),
      onConfirm: (turnOn) => void git.disable(turnOn),
    });
  }
</script>

<div class="git">
  {#if status}
    <header class="bar">
      <strong class="only">git</strong>
      {#if status.url}
        <span class="target" title={status.url}>
          {status.host?.label ?? 'git'} · {status.url} · {status.branch}
        </span>
      {/if}
      <span class="spacer"></span>
      <Button size="sm" onclick={() => void git.load(true)} disabled={working}>Check remote</Button>
      <Button size="sm" onclick={() => git.openSetup()} disabled={working}>Set up…</Button>
      <Button size="sm" variant="ghost" onclick={turnOff} disabled={working}>Turn off</Button>
    </header>

    <div class="body">
      {#if summary}
        <section class="card status">
          <div class="line">
            <span
              class="dot"
              class:ok={summary.tone === 'ok'}
              class:warn={summary.tone === 'warn'}
              class:bad={summary.tone === 'error'}
              class:live={working}
            ></span>
            <div class="what">
              <p class="head" aria-live="polite">
                {git.busy === 'syncing' ? 'Syncing…' : summary.headline}
              </p>
              <p class="sub" class:bad={summary.tone === 'error'}>{summary.detail}</p>
            </div>
          </div>

          {#if working}
            <div class="progress" role="presentation"><span class="sweep"></span></div>
          {/if}

          <div class="actions">
            {#if status.conflict?.reason === 'diverged'}
              <Button variant="primary" onclick={() => void git.sync('ours')} disabled={working}>
                Keep mine
              </Button>
              <Button variant="primary" onclick={() => void git.sync('theirs')} disabled={working}>
                Take theirs
              </Button>
            {:else}
              <Button variant="primary" onclick={() => void git.sync()} disabled={working || !!status.problem}>
                Sync now
              </Button>
            {/if}
          </div>
        </section>
      {/if}

      {#if status.conflict}
        <section class="card list">
          <h4>{status.conflict.reason === 'diverged' ? 'Changed on both sides' : 'Uncommitted edits'}</h4>
          <ul>
            {#each status.conflict.documents as document (document)}
              <li><code>{document}</code></li>
            {/each}
          </ul>
        </section>
      {/if}

      <section class="card facts">
        <dl>
          <dt>Repository</dt>
          <dd>
            {status.url ?? '—'}
            {#if status.usesProjectRepository}<span class="faint"> · project repository</span>{/if}
          </dd>
          <dt>Branch</dt>
          <dd>{status.branch}</dd>
          <dt>To push</dt>
          <dd>{status.ahead} {status.ahead === 1 ? 'commit' : 'commits'}</dd>
          <dt>To pull</dt>
          <dd>{status.behind} {status.behind === 1 ? 'commit' : 'commits'}</dd>
          <dt>Last checked</dt>
          <dd>
            {status.lastFetch ? new Date(status.lastFetch.at).toLocaleTimeString() : 'never'}
            {#if status.lastFetch?.error}<span class="bad"> · {status.lastFetch.error}</span>{/if}
          </dd>
        </dl>
        {#if status.uncommitted.length}
          <p class="faint">
            {status.uncommitted.length} uncommitted {status.uncommitted.length === 1 ? 'file' : 'files'}. Sync
            commits them.
          </p>
        {/if}
      </section>
    </div>
  {:else}
    <p class="placeholder">Loading…</p>
  {/if}
</div>

{#if git.draft}
  <GitSetupDialog onclose={() => git.closeSetup()} />
{/if}

<style>
  .git {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

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

  .bar .target {
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--ink-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .spacer {
    flex: 1;
  }

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
    padding: var(--space-3);
  }

  .placeholder {
    margin: 0;
    padding: var(--space-4) var(--space-3);
    font-size: var(--text-sm);
    color: var(--ink-muted);
  }

  .faint {
    margin: var(--space-2) 0 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .bad {
    color: var(--danger);
  }

  .status {
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

  .dot.warn {
    background: var(--warn);
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

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  h4 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }

  .list ul {
    margin: 0;
    padding-left: var(--space-4);
    font-size: var(--text-sm);
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    font-size: var(--text-sm);
  }

  dt {
    color: var(--ink-muted);
  }

  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  code {
    padding: 0.05rem 0.3rem;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
</style>
