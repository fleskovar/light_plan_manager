<script lang="ts">
  import type { HubInfoDto } from '$shared';
  import Button from '$lib/ui/Button.svelte';
  import type { ProjectsPage } from './projects.svelte.js';

  /**
   * The "All projects" page: one row for each project of the project index.
   * `page` holds the state and the actions. `hub` is set on the hub of
   * `lpm ui`, which has no board to go back to.
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

  {#if page.error}
    <p class="error" role="alert">{page.error}</p>
  {/if}

  {#if page.loading}
    <p class="muted">Loading the projects…</p>
  {:else if page.emptyText}
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
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  .projects {
    max-width: 64rem;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4);
    color: var(--ink);
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }

  h1 {
    font-size: var(--text-xl);
    margin: 0;
  }

  .muted {
    color: var(--ink-muted);
    font-size: var(--text-sm);
    margin: var(--space-1) 0 0;
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
  .used {
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

  .actions {
    display: flex;
    gap: var(--space-2);
  }

  @media (max-width: 44rem) {
    .row {
      grid-template-columns: 1fr;
    }
  }
</style>
