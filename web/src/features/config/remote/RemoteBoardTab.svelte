<script lang="ts">
  import { onMount } from 'svelte';
  import { useShell } from '$lib/app/shell.svelte.js';
  import Button from '$lib/ui/Button.svelte';
  import ConnectionPanel from '$features/drawer/remote/ConnectionPanel.svelte';
  import { useConnectionsState } from '$features/drawer/remote/connections.svelte.js';
  import { gitSummary, nameList, useGitState } from '$features/drawer/remote/git.svelte.js';
  import { useRemoteState } from '$features/drawer/remote/remote.svelte.js';
  import MappingEditor from './MappingEditor.svelte';

  /**
   * The Remote board tab of the board configuration dialog: the two ways that a
   * board reaches other people, and the setup of each.
   *
   * **Git sync** is always offered. The tab shows whether the board is shared,
   * opens the setup form (`GitSetupDialog`, which `Workspace.svelte` mounts),
   * syncs now and turns sharing off.
   *
   * **Trackers** are experimental. The section is drawn only when the server
   * runs with the experimental features on, which `remote.enabled` reports.
   * The key `experimental` in `.lpm/config.yml` or the flag `lpm ui
   * --experimental` turns them on. While they are off, one line names the
   * command `lpm experimental on`. The section lists
   * each tracker remote, connects another one, opens the connection of one, and
   * opens the mapping editor of one.
   *
   * A board syncs through git or mirrors onto trackers, never both. While git
   * sync is on, the tracker section lists the trackers that sharing turned off
   * and offers no action.
   *
   * Presentational. The three state machines of the Sync tab hold every
   * decision, so the Sync tab and this tab cannot disagree.
   */
  const git = useGitState();
  const remote = useRemoteState();
  const connections = useConnectionsState();
  const shell = useShell();

  /** The remote whose mapping editor replaces the tab, or null. */
  let mappingOf = $state<string | null>(null);
  /** The remote whose connection panel is open, or null. */
  let connectionOf = $state<string | null>(null);

  onMount(() => {
    void git.load();
  });

  const status = $derived(git.status);
  const summary = $derived(status?.enabled ? gitSummary(status) : null);
  const working = $derived(git.busy !== null);
  const names = $derived(remote.remotes.map((entry) => entry.name));
  const turnedOff = $derived(status?.remotesOff ?? []);

  // A remote that was removed takes its open panel with it.
  $effect(() => {
    if (connectionOf !== null && !names.includes(connectionOf)) connectionOf = null;
    if (mappingOf !== null && !names.includes(mappingOf)) mappingOf = null;
  });

  function turnOffGit(): void {
    shell.confirm({
      title: 'Turn off git sync?',
      message: 'Turns off git sync for everyone. The repository is not changed.',
      confirmLabel: 'Turn off',
      danger: true,
      ...(turnedOff.length
        ? { choice: { label: `Turn ${nameList(turnedOff)} back on`, checked: true } }
        : {}),
      onConfirm: (turnOn) => void git.disable(turnOn),
    });
  }
</script>

{#if mappingOf}
  <MappingEditor name={mappingOf} onback={() => (mappingOf = null)} />
{:else}
  <section>
    <h3>Git sync</h3>
    <p class="lede">
      Git sync commits each change of the board to a git repository and pushes it. Every person who shares
      the repository works on the same board.
    </p>

    {#if !status}
      <p class="note">Reading the git state…</p>
    {:else if status.enabled && summary}
      <div class="card">
        <div class="line">
          <span class="dot" class:ok={summary.tone === 'ok'} class:warn={summary.tone === 'warn'} class:bad={summary.tone === 'error'}></span>
          <div class="what">
            <strong>{git.busy === 'syncing' ? 'Syncing…' : summary.headline}</strong>
            <span class="detail">{summary.detail}</span>
          </div>
        </div>
        <dl>
          <dt>Repository</dt>
          <dd>
            {status.url ?? 'not set'}
            {#if status.usesProjectRepository}<span class="faint"> (the repository of this project)</span>{/if}
          </dd>
          <dt>Branch</dt>
          <dd><code>{status.branch}</code></dd>
        </dl>
        <div class="actions">
          {#if status.conflict?.reason === 'diverged'}
            <Button size="sm" variant="primary" disabled={working} onclick={() => void git.sync('ours')}>
              Keep mine
            </Button>
            <Button size="sm" variant="primary" disabled={working} onclick={() => void git.sync('theirs')}>
              Take theirs
            </Button>
          {:else}
            <Button size="sm" variant="primary" disabled={working || !!status.problem} onclick={() => void git.sync()}>
              Sync now
            </Button>
          {/if}
          <Button size="sm" disabled={working} onclick={() => git.openSetup()}>Set up again…</Button>
          <Button size="sm" disabled={working} onclick={turnOffGit}>Turn off…</Button>
        </div>
      </div>
    {:else}
      <div class="card">
        <strong>Git sync is off.</strong>
        {#if status.trackers.length}
          <p class="note">
            This board mirrors onto {nameList(status.trackers)}. Git sync turns
            {status.trackers.length === 1 ? 'that tracker' : 'those trackers'} off. The setup form asks before
            it does so.
          </p>
        {/if}
        <div class="actions">
          <Button size="sm" variant="primary" disabled={working} onclick={() => git.openSetup()}>
            Set up git sync…
          </Button>
        </div>
        <p class="note">
          The setup form asks for the repository and the branch, and checks that git can reach them. The
          command line has the same setup: <code>lpm git setup</code>.
        </p>
      </div>
    {/if}
  </section>

  {#if !remote.enabled}
    <!-- No tracker is named while the experimental features are off. The line
         says only that more exists and which command shows it. -->
    <p class="note more">
      Other ways to share a board are experimental and are off. Run <code>lpm experimental on</code>, then
      start <code>lpm ui</code> again.
    </p>
  {:else}
    <section>
      <h3>Trackers <span class="flag">experimental</span></h3>
      <p class="lede">
        A tracker remote mirrors this board onto an issue tracker. The mapping says which tracker type,
        status and sprint each item of the board becomes.
      </p>

      {#if status?.enabled}
        <p class="note">
          A board syncs through git or mirrors onto trackers, and not both. Turn off git sync to use a
          tracker.
          {#if turnedOff.length}
            Git sync turned off {nameList(turnedOff)}. The settings and the links of
            {turnedOff.length === 1 ? 'that tracker' : 'those trackers'} are kept.
          {/if}
        </p>
      {:else}
        {#if remote.remotes.length}
          <ul class="remotes">
            {#each remote.remotes as entry (entry.name)}
              <li>
                <div class="row">
                  <strong>{entry.name}</strong>
                  <span class="faint">{entry.provider} · {entry.target}</span>
                  <span class="grow"></span>
                  <Button size="sm" variant="primary" onclick={() => (mappingOf = entry.name)}>Mapping…</Button>
                  <Button
                    size="sm"
                    aria-expanded={connectionOf === entry.name}
                    onclick={() => (connectionOf = connectionOf === entry.name ? null : entry.name)}
                  >
                    Connection
                  </Button>
                </div>
                {#if connectionOf === entry.name}
                  <ConnectionPanel name={entry.name} />
                {/if}
              </li>
            {/each}
          </ul>
        {:else if !remote.loading}
          <p class="note">This board has no tracker remote.</p>
        {/if}

        {#each turnedOff as name (name)}
          <div class="row off">
            <strong>{name}</strong>
            <span class="faint">turned off, settings and links kept</span>
            <span class="grow"></span>
            <Button size="sm" disabled={working} onclick={() => void git.turnOn(name)}>Turn on</Button>
          </div>
        {/each}

        <div class="actions">
          <Button size="sm" onclick={() => void connections.openConnect(names)}>Connect a tracker…</Button>
        </div>
      {/if}
    </section>
  {/if}
{/if}

<style>
  section + section {
    margin-top: var(--space-5);
  }

  h3 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 var(--space-1);
    font-size: var(--text-md);
  }

  .lede {
    margin: 0 0 var(--space-3);
    color: var(--ink-muted);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    font-size: var(--text-sm);
  }

  .line {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .dot {
    flex: none;
    width: 0.6rem;
    height: 0.6rem;
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

  .what {
    display: flex;
    flex-direction: column;
  }

  .detail {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px var(--space-3);
    margin: 0;
    font-size: var(--text-xs);
  }

  dt {
    color: var(--ink-muted);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .remotes {
    margin: 0 0 var(--space-3);
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .remotes li {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  .row.off {
    margin-bottom: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
  }

  .grow {
    flex: 1;
  }

  .faint {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .flag {
    padding: 0 0.4rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--ink-muted);
    font-size: var(--text-xs);
    font-weight: 400;
  }

  .note.more {
    margin-top: var(--space-5);
  }

  .note {
    margin: 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  code {
    font-family: var(--font-mono);
    font-size: 0.95em;
  }
</style>
