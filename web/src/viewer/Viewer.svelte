<script lang="ts">
  import { SvelteFlowProvider } from '@xyflow/svelte';
  import { createRouter, goToView } from '$lib/app/router.svelte.js';
  import { ViewerBoard } from './board.svelte.js';
  import { fetchStaticBoard, resolveLocation, type BoardLocation } from './source.js';
  import Inspector from './Inspector.svelte';
  import ViewerCanvas from './ViewerCanvas.svelte';

  /**
   * The whole viewer: fetch one file, draw the graph, get out of the way.
   *
   * There is no server behind this and nothing to save, so the screen has no
   * state worth persisting beyond the address bar — `#/view/<id>` names the
   * view, which makes any picture on screen a link somebody else can open.
   */
  const board = new ViewerBoard();
  const router = createRouter();

  let location = $state<BoardLocation | null>(null);
  let showInspector = $state(true);

  void load();

  async function load(): Promise<void> {
    const requested = router.route.name === 'view' ? router.route.id : undefined;
    try {
      const resolved = resolveLocation(window.location.search, window.location.href);
      location = resolved;
      board.load(await fetchStaticBoard(resolved), requested);
    } catch (error) {
      board.fail(error instanceof Error ? error.message : String(error));
    }
  }

  // The address bar drives the view, so a Back press moves between views and a
  // pasted link opens the one it names.
  $effect(() => {
    const route = router.route;
    if (!board.ready) return;
    const wanted = route.name === 'view' ? route.id : board.viewId;
    if (wanted !== board.viewId) board.open(wanted);
  });

  const exported = $derived.by(() => {
    const at = board.data?.generated;
    if (!at) return '';
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  });

  const errors = $derived(
    board.data?.board.problems.filter((problem) => problem.level === 'error').length ?? 0,
  );
</script>

<svelte:head>
  <title>{board.data ? `${board.data.board.config.boardName} — light-plan` : 'light-plan'}</title>
</svelte:head>

{#if board.loading}
  <p class="notice">Loading the board…</p>
{:else if board.error}
  <div class="notice failure">
    <h1>Board not found</h1>
    <p>{board.error}</p>
    {#if location}
      <p class="dim">Tried <code>{location.url}</code></p>
    {/if}
    <p class="dim">
      To open another repository's board, add <code>?repo=owner/name</code> to the URL.
    </p>
  </div>
{:else if board.data}
  <div class="shell">
    <header>
      <strong>{board.data.board.config.boardName}</strong>

      <label>
        <span class="sr">View</span>
        <select value={board.viewId} onchange={(event) => goToView(event.currentTarget.value)}>
          {#each board.views as view (view.id)}
            <option value={view.id}>{view.name}</option>
          {/each}
        </select>
      </label>

      <span class="count">
        {board.members.length} of {board.data.board.issues.length} issues
      </span>

      <span class="spacer"></span>

      {#if errors}
        <span class="problems" title="Run `lpm check` to list them">
          {errors} board problem{errors === 1 ? '' : 's'}
        </span>
      {/if}
      {#if exported}
        <span class="dim" title={board.data.generated}>exported {exported}</span>
      {/if}
      {#if location?.homepage}
        <a class="dim" href={location.homepage} rel="noreferrer noopener">{location.repo}</a>
      {/if}
      {#if !showInspector}
        <button type="button" class="reveal" onclick={() => (showInspector = true)}>Details</button>
      {/if}
    </header>

    <div class="middle">
      <SvelteFlowProvider>
        <ViewerCanvas {board} />
      </SvelteFlowProvider>
      {#if showInspector}
        <Inspector {board} onclose={() => (showInspector = false)} />
      {/if}
    </div>
  </div>
{/if}

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex: none;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    font-size: var(--text-sm);
  }

  .spacer {
    flex: 1;
  }

  select {
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: inherit;
    font-size: var(--text-sm);
  }

  .count,
  .dim {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  a.dim:hover {
    text-decoration: underline;
  }

  .problems {
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: var(--tone-blocked-soft);
    color: var(--tone-blocked);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .reveal {
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--ink-muted);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .middle {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  .notice {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    height: 100%;
    padding: var(--space-4);
    text-align: center;
    color: var(--ink-muted);
  }

  .failure h1 {
    margin: 0;
    font-size: var(--text-xl);
    color: var(--ink);
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
