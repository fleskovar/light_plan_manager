<script lang="ts">
  import type { BoardSnapshot, ViewMode, ViewSummary } from '$shared';
  import { ApiError, api } from '$lib/api/client.js';
  import { goToView } from '$lib/app/router.svelte.js';
  import { appearanceEntries } from '$lib/app/options.js';
  import { usePreferences } from '$lib/app/preferences.svelte.js';
  import Button from '$lib/ui/Button.svelte';
  import MenuButton from '$lib/ui/menu/MenuButton.svelte';
  import Digest from '$features/welcome/Digest.svelte';
  import ViewCard from '$features/welcome/ViewCard.svelte';

  /**
   * The first screen: pick up a saved view, or start a new one. Views are files
   * in `.lpm/views`, so this list is the same one a teammate sees after a pull.
   */
  let views = $state<ViewSummary[]>([]);
  let board = $state<BoardSnapshot | null>(null);
  let loading = $state(true);
  let error = $state<{ message: string; details: string[] } | null>(null);
  let newName = $state('');
  let newMode = $state<ViewMode>('board');
  let creating = $state(false);

  // No view is open here, so Options is only about how the app looks.
  const preferences = usePreferences();
  const options = $derived(preferences ? appearanceEntries(preferences) : []);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      [views, board] = await Promise.all([api.listViews(), api.board()]);
    } catch (thrown) {
      error =
        thrown instanceof ApiError
          ? { message: thrown.message, details: thrown.details }
          : { message: String(thrown), details: [] };
    } finally {
      loading = false;
    }
  }

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    creating = true;
    try {
      const view = await api.createView(name, newMode);
      goToView(view.id);
    } catch (thrown) {
      error =
        thrown instanceof ApiError
          ? { message: thrown.message, details: thrown.details }
          : { message: String(thrown), details: [] };
    } finally {
      creating = false;
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm(`Delete the view "${id}"? The board itself is not touched.`)) return;
    await api.deleteView(id);
    await load();
  }

  const when = (iso: string): string => new Date(iso).toLocaleString();

  void load();
</script>

<main>
  {#if options.length}
    <div class="options">
      <MenuButton entries={options} title="Appearance">Options ▾</MenuButton>
    </div>
  {/if}

  {#if error}
    <div class="error">
      <strong>{error.message}</strong>
      {#each error.details as detail (detail)}
        <div>{detail}</div>
      {/each}
      <Button size="sm" onclick={load}>Retry</Button>
    </div>
  {/if}

  <!--
    A mosaic rather than a column: the state of the board is what someone
    opening this wants, and it is three readings of different sizes, so they get
    tiles of different sizes. `Digest` places its own three (`now`, `added`,
    `paths`) into the areas named below — those names are the contract between
    the two files.
  -->
  <div class="mosaic">
    <header class="card hero">
      <p class="eyebrow">light-plan</p>
      <h1>{board?.config.boardName ?? 'Loading…'}</h1>
      {#if board}
        <dl class="stats">
          <div>
            <dt>Issues</dt>
            <dd>{board.issues.length}</dd>
          </div>
          {#if board.config.hasPeriods}
            <div>
              <dt>Periods</dt>
              <dd>{board.periods.length}</dd>
            </div>
          {/if}
          {#if board.config.hasResources}
            <div>
              <dt>Roster</dt>
              <dd>{board.resources.length}</dd>
            </div>
          {/if}
          <div>
            <dt>Templates</dt>
            <dd>{board.templates.filter((template) => template.root).length}</dd>
          </div>
          <div>
            <dt>Views</dt>
            <dd>{views.length}</dd>
          </div>
        </dl>
      {/if}
    </header>

    {#if board}
      <Digest {board} />
    {/if}

    <section class="card views">
      <h2>Views</h2>
      {#if loading}
        <p class="hint">Loading…</p>
      {:else if !views.length}
        <p class="hint">No views yet. Create one below.</p>
      {:else}
        <ul>
          {#each views as view (view.id)}
            <ViewCard {view} when={when(view.updated)} onopen={goToView} onremove={remove} />
          {/each}
        </ul>
      {/if}
    </section>

    <section class="card start">
      <h2>New view</h2>
      <p class="hint">
        {#if newMode === 'templates'}
          Edit reusable templates on a canvas.
        {:else}
          A saved set of issues and their layout.
        {/if}
      </p>
      <fieldset class="modes">
        <legend class="sr-only">What this view is over</legend>
        <label>
          <input type="radio" bind:group={newMode} value="board" />
          Board
        </label>
        <label>
          <input type="radio" bind:group={newMode} value="templates" />
          Template registry
        </label>
      </fieldset>
      <form onsubmit={create}>
        <input
          bind:value={newName}
          placeholder={newMode === 'templates'
            ? 'Delivery patterns, Release checklists…'
            : 'Roadmap, Sprint 12, Payments…'}
          aria-label="View name"
        />
        <Button variant="primary" type="submit" disabled={!newName.trim() || creating}>
          Create
        </Button>
      </form>
    </section>
  </div>
</main>

<style>
  /*
   * The rest of the app is a working surface and is typed small on purpose. A
   * landing page is read, not operated, so it raises the scale for everything
   * inside it — including `Digest` and the shared chips, which take their sizes
   * from these same custom properties.
   */
  main {
    --text-xs: 0.8125rem;
    --text-sm: 0.9375rem;
    --text-md: 1.0625rem;
    --text-lg: 1.25rem;
    --text-xl: 2rem;

    max-width: 96rem;
    margin: 0 auto;
    padding: var(--space-6) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  /*
   * Three columns at full width, two when there is less room, one on a phone.
   * The tiles are deliberately unequal: what is running now is the big one, the
   * views beside it are tall, and the two readings underneath are wide.
   */
  /*
   * Every width names its areas, including this one. A tile carries
   * `grid-area: views` unconditionally, and an area name with nothing to match
   * does not fall back to auto-placement — the tiles would all land in the same
   * cell, stacked on top of each other.
   */
  .options {
    display: flex;
    justify-content: flex-end;
    margin-bottom: calc(-1 * var(--space-2));
  }

  .mosaic {
    display: grid;
    gap: var(--space-4);
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'hero'
      'now'
      'views'
      'start'
      'added'
      'paths';
  }

  @media (min-width: 50rem) {
    .mosaic {
      /* Each tile is its own height. A short one leaves a gap rather than
         acres of empty card, which is what makes this read as a mosaic and
         not as a table of boxes. */
      align-items: start;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-template-areas:
        'hero  now'
        'start now'
        'views added'
        'views paths';
    }
  }

  @media (min-width: 78rem) {
    .mosaic {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      grid-template-areas:
        'hero  now   now'
        'start now   now'
        'views added added'
        'views paths paths';
    }
  }

  .hero {
    grid-area: hero;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: var(--space-3);
    background: linear-gradient(140deg, var(--accent-soft), var(--surface-1) 65%);
  }

  .views {
    grid-area: views;
  }

  .start {
    grid-area: start;
  }

  h1 {
    margin: 0;
    font-size: var(--text-xl);
    line-height: 1.1;
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }

  .eyebrow {
    margin: 0;
    color: var(--accent);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
    margin: 0;
  }

  .stats div {
    display: flex;
    flex-direction: column-reverse;
  }

  .stats dt {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .stats dd {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .card {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: var(--space-4) var(--space-5);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
  }

  h2 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-lg);
    letter-spacing: -0.01em;
  }

  .hint {
    margin: 0 0 var(--space-3);
    color: var(--ink-muted);
    font-size: var(--text-sm);
    line-height: 1.5;
  }


  form {
    display: flex;
    gap: var(--space-2);
  }

  .modes {
    display: flex;
    gap: var(--space-4);
    margin: 0 0 var(--space-3);
    padding: 0;
    border: none;
    font-size: var(--text-sm);
  }

  .modes label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  input {
    flex: 1;
    min-width: 0;
    padding: 0.45rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    font-size: var(--text-md);
  }

  /* A tall tile with a long list scrolls rather than stretching the mosaic. */
  .views ul {
    min-height: 0;
    overflow: auto;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .error {
    padding: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    border-radius: var(--radius-md);
    background: var(--tone-blocked-soft);
    font-size: var(--text-sm);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: flex-start;
  }
</style>
