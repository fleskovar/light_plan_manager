<script lang="ts">
  import { onDestroy } from 'svelte';
  import { api } from '$lib/api/client.js';
  import { useShell } from '$lib/app/shell.svelte.js';
  import Button from '$lib/ui/Button.svelte';
  import JobProgress from '$features/projects/JobProgress.svelte';
  import { StoragePanel } from './storage.svelte.js';

  /**
   * The Storage tab of the board configuration: where the board is, its
   * backup, and the buttons that move it, back it up and restore it.
   * `StoragePanel` holds the logic. The confirmations open through the shell,
   * above this dialog.
   */
  const shell = useShell();
  const panel = new StoragePanel(
    {
      info: api.storeInfo,
      jobs: api.storeJobs,
      move: api.moveProject,
      backup: api.backupProject,
      restore: api.restoreBackup,
    },
    (confirmation) => shell.confirm(confirmation),
  );
  void panel.load();
  onDestroy(() => panel.dispose());
</script>

<section class="storage">
  {#if panel.loading}
    <p class="muted">Reading where the board is…</p>
  {:else if panel.info}
    {@const info = panel.info}
    <dl class="facts">
      <div>
        <dt>Store</dt>
        <dd>{info.store === 'central' ? 'Central store' : 'Project'}</dd>
      </div>
      <div>
        <dt>Board folder</dt>
        <dd class="mono">{info.lpmDir}</dd>
      </div>
      <div>
        <dt>Project folder</dt>
        <dd class="mono">{info.root}</dd>
      </div>
      <div>
        <dt>Central store</dt>
        <dd class="mono">{info.centralStore ?? 'not set'}</dd>
      </div>
    </dl>

    <div class="block">
      <h3>Move</h3>
      <p class="muted">
        {#if info.store === 'local'}
          The board is in <code>.lpm</code> of the project. A move copies it to the central store, and the project keeps a
          pointer in <code>.lpm/config.yml</code>.
        {:else}
          The board is in the central store. A move copies it back into <code>.lpm</code> of the project.
        {/if}
        Each move backs the board up first, and deletes the original only after the copy matches it.
      </p>
      <Button
        size="sm"
        disabled={!panel.canMove}
        title={panel.canMove ? '' : 'No central store is set. `lpm set central_store` names one.'}
        onclick={() => panel.requestMove()}
      >
        {panel.moveLabel}
      </Button>
    </div>

    <div class="block">
      <h3>Backup</h3>
      <p class="muted">
        {#if panel.backupText}
          The backup is from {panel.backupText}. It is in <code class="mono">{info.backup?.dir}</code>.
        {:else}
          The board has no backup.
        {/if}
        Each board has one backup in the central store.
      </p>
      <div class="buttons">
        <Button size="sm" disabled={!panel.canBackup} onclick={() => panel.requestBackup()}>
          {info.backup ? 'Replace the backup' : 'Back up'}
        </Button>
        <Button variant="danger" size="sm" disabled={!panel.canRestore} onclick={() => panel.requestRestore()}>
          Restore from backup
        </Button>
      </div>
    </div>

    {#if panel.job}
      <div class="block"><JobProgress job={panel.job} /></div>
    {/if}
  {/if}

  {#if panel.error}
    <p class="error" role="alert">{panel.error}</p>
  {/if}
</section>

<style>
  .storage {
    display: grid;
    gap: var(--space-4);
  }

  .facts {
    display: grid;
    gap: var(--space-2);
    margin: 0;
  }

  .facts div {
    display: grid;
    grid-template-columns: 9rem 1fr;
    gap: var(--space-2);
  }

  dt {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  dd {
    margin: 0;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .mono,
  code {
    font-family: var(--font-mono);
    font-size: 0.95em;
  }

  h3 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-md, var(--text-sm));
  }

  .muted {
    margin: 0 0 var(--space-2);
    color: var(--ink-muted);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .error {
    color: var(--danger);
    font-size: var(--text-sm);
  }
</style>
