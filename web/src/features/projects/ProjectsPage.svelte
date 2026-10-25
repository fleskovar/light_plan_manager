<script lang="ts">
  import type { HubInfoDto } from '$shared';
  import Button from '$lib/ui/Button.svelte';
  import ConfirmDialog from '$lib/ui/ConfirmDialog.svelte';
  import Tabs from '$lib/ui/Tabs.svelte';
  import JobProgress from './JobProgress.svelte';
  import type { ProjectsPage } from './projects.svelte.js';

  /**
   * The "All projects" page. The tab Projects has one row for each project of
   * the project index, and the tab Backups has one row for each backup in the
   * central store. `page` holds the state and the actions. `hub` is set on the
   * hub of `lpm ui`, which has no board to go back to.
   */
  interface Props {
    readonly page: ProjectsPage;
    readonly hub: HubInfoDto | null;
  }

  let { page, hub }: Props = $props();
</script>

<main class="projects">
  <header>
    <div>
      <h1>All projects</h1>
      <p class="muted">
        {#if hub}Central store: <span class="mono">{hub.store}</span>{:else}Every project that lpm worked on, on this computer{/if}
      </p>
    </div>
    {#if !hub}
      <a class="back" href="/">← Back to the board</a>
    {/if}
  </header>

  <div class="tabs">
    <Tabs
      tabs={[
        { id: 'projects', label: 'Projects' },
        { id: 'backups', label: `Backups${page.backupList.backups.length ? ` (${page.backupList.backups.length})` : ''}` },
      ]}
      active={page.tab}
      onselect={(id) => page.selectTab(id)}
    />
  </div>

  {#if page.error}
    <p class="error" role="alert">{page.error}</p>
  {/if}
  {#if page.notice}
    <div class="notice {page.notice.kind}" role={page.notice.kind === 'failed' ? 'alert' : 'status'}>
      <strong>{page.notice.message}</strong>
      {#if page.notice.notes.length}
        <ul>
          {#each page.notice.notes as note (note)}
            <li>{note}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if page.loading}
    <p class="muted">Loading the projects…</p>
  {:else if page.tab === 'projects'}
    {#if page.emptyText}
      <p class="muted">{page.emptyText}</p>
    {:else}
      <ul class="rows">
        {#each page.rows as row (row.lpmDir)}
          <li class="row" class:dim={row.state === 'missing'}>
            <div class="identity">
              <span class="name">{row.name}</span>
              <span class="tag">{row.store}</span>
              {#if row.keyPrefix}<span class="prefix">{row.keyPrefix}</span>{/if}
              {#if row.label}<span class="label">{row.label}</span>{/if}
            </div>
            <div class="folder" title={row.lpmDir}>{row.folder}</div>
            <div class="used">{row.lastUsedText}</div>
            <div class="actions">
              <Button
                variant="primary"
                size="sm"
                disabled={!row.canOpen || page.busy !== null}
                onclick={() => page.open(row.lpmDir)}
              >
                {page.busy === row.lpmDir ? 'Opening…' : 'Open'}
              </Button>
              <Button
                size="sm"
                disabled={!row.canReveal || page.busy !== null}
                title={row.canReveal ? `Show ${row.folder}/.lpm in the file manager` : 'The project folder is not known or is gone'}
                onclick={() => page.reveal(row.lpmDir)}
              >
                Reveal
              </Button>
              <Button size="sm" disabled={!row.canMove} title={row.moveTitle} onclick={() => page.requestMove(row.lpmDir)}>
                {row.moveLabel}
              </Button>
              <Button
                size="sm"
                disabled={!row.canBackup}
                title={row.backup ? `Replace the backup of ${row.backup.createdAt.slice(0, 10)}` : 'Copy the board to a backup in the central store'}
                onclick={() => page.requestBackup(row.lpmDir)}
              >
                Back up
              </Button>
            </div>
            {#if row.job}
              <div class="progress"><JobProgress job={row.job} /></div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {:else if page.backupsEmptyText}
    <p class="muted">{page.backupsEmptyText}</p>
  {:else}
    {#if page.backupList.backupsDir}
      <p class="muted">In <span class="mono">{page.backupList.backupsDir}</span>. Each board has one backup.</p>
    {/if}
    <ul class="rows">
      {#each page.backupRows as backup (backup.name)}
        <li class="row backup">
          <div class="identity">
            <span class="name">{backup.projectName}</span>
            <span class="tag">from {backup.source}</span>
            {#if backup.keyPrefix}<span class="prefix">{backup.keyPrefix}</span>{/if}
          </div>
          <div class="folder" title={backup.dir}>{backup.projectPath}</div>
          <div class="when">
            <span>{backup.dateText}</span>
            <span class="age">{backup.ageText} old</span>
            <span class="age">{backup.files} files, {backup.sizeText}</span>
          </div>
          <div class="actions">
            <Button
              variant="danger"
              size="sm"
              disabled={!backup.canRestore}
              title="Overwrite the board of {backup.projectName} with this backup"
              onclick={() => page.requestRestore(backup.name)}
            >
              Restore
            </Button>
          </div>
          {#if backup.job}
            <div class="progress"><JobProgress job={backup.job} /></div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</main>

{#if page.confirmation}
  {#key page.confirmation}
    <ConfirmDialog confirmation={page.confirmation} onresolve={(accepted) => page.resolveConfirmation(accepted)} />
  {/key}
{/if}

<style>
  .projects {
    max-width: 72rem;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4);
    color: var(--ink);
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }

  h1 {
    font-size: var(--text-xl);
    margin: 0;
  }

  .tabs {
    margin-bottom: var(--space-4);
  }

  .muted {
    color: var(--ink-muted);
    font-size: var(--text-sm);
    margin: var(--space-1) 0 var(--space-3);
  }

  .mono,
  .folder,
  .prefix {
    font-family: var(--font-mono);
  }

  .back {
    color: var(--accent);
    font-size: var(--text-sm);
    white-space: nowrap;
  }

  .error {
    color: var(--tone-blocked);
    background: var(--tone-blocked-soft);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
  }

  .notice {
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
    font-size: var(--text-sm);
  }

  .notice ul {
    margin: var(--space-1) 0 0;
    padding-left: var(--space-4);
    font-size: var(--text-xs);
  }

  .notice.done {
    border: 1px solid var(--tone-done);
    background: var(--tone-done-soft);
  }

  .notice.failed {
    border: 1px solid var(--danger);
    color: var(--danger);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-2);
  }

  .row {
    display: grid;
    grid-template-columns: minmax(11rem, 15rem) 1fr auto auto;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  .row.dim {
    opacity: 0.65;
  }

  .progress {
    grid-column: 1 / -1;
  }

  .identity {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
  }

  .name {
    font-weight: 600;
  }

  .tag,
  .prefix,
  .used,
  .age {
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .tag {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-1);
  }

  .label {
    font-size: var(--text-xs);
    color: var(--tone-blocked);
  }

  .folder {
    font-size: var(--text-sm);
    color: var(--ink-muted);
    overflow-wrap: anywhere;
  }

  .when {
    display: flex;
    flex-direction: column;
    font-size: var(--text-sm);
    white-space: nowrap;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  @media (max-width: 52rem) {
    .row {
      grid-template-columns: 1fr;
    }
  }
</style>
