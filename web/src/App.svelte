<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { browserPreferences, providePreferences } from '$lib/app/preferences.svelte.js';
  import { createRouter } from '$lib/app/router.svelte.js';
  import { browserTabs, provideTabs } from '$lib/app/tabs.svelte.js';
  import Button from '$lib/ui/Button.svelte';
  import { WorkspacePool, providePool } from '$lib/workspace/pool.svelte.js';
  import { Workspace as WorkspaceStore } from '$lib/workspace/workspace.svelte.js';
  import IssueView from './routes/IssueView.svelte';
  import Workspace from './routes/Workspace.svelte';

  /**
   * The app has one screen: a view, with one tab for each open view. The
   * address names the active tab. An address that names no view sends the
   * window to the view that this browser showed last.
   *
   * The popup for one issue (`#/issue/...`) is the exception. It has no tabs
   * and loads its own workspace.
   */
  const router = createRouter();

  // Appearance belongs to the reader, not to a view, so it is read once here
  // for every screen — and applied before the first paint, not after it.
  const preferences = providePreferences(browserPreferences());
  onDestroy(() => preferences.dispose());

  // One workspace for each open tab. A tab that closes disposes its workspace.
  const pool = providePool(
    new WorkspacePool(() => new WorkspaceStore({ autoSave: () => preferences.values.autoSave })),
  );
  const tabs = provideTabs(browserTabs((id, deleted) => pool.release(id, deleted)));

  const initial = router.route;
  if (initial.name !== 'issue') void tabs.start(initial.name === 'view' ? initial.id : null);

  // The address is what the reader, the Back button and a bookmark change, so
  // the tabs follow it. The writes are untracked: this effect reacts to the
  // route and to the end of `start`, and to nothing that it changes itself.
  $effect(() => {
    const route = router.route;
    if (!tabs.ready) return;
    untrack(() => {
      if (route.name === 'view') {
        pool.acquire(route.id);
        tabs.show(route.id);
      } else if (route.name === 'home') {
        void tabs.land();
      }
    });
  });

  // When the preference `autoSave` changes to `true`, each open view that
  // holds an unsaved layout is saved.
  $effect(() => {
    if (!preferences.values.autoSave) return;
    untrack(() => {
      for (const workspace of pool.all()) if (workspace.viewDirty) void workspace.save();
    });
  });

  const shown = $derived(router.route.name === 'view' ? pool.get(router.route.id) : undefined);

  /** Ask before the window closes while a tab holds work that is not on disk. */
  function onbeforeunload(event: BeforeUnloadEvent): void {
    if (pool.all().some((workspace) => workspace.dirty || workspace.unsaved)) event.preventDefault();
  }
</script>

<svelte:window {onbeforeunload} />

{#if router.route.name === 'issue'}
  {#key router.route.nodeId}
    <IssueView nodeId={router.route.nodeId} viewId={router.route.viewId} />
  {/key}
{:else if tabs.failure}
  <div class="center">
    <h1>{tabs.failure.message}</h1>
    {#each tabs.failure.details as detail (detail)}
      <p>{detail}</p>
    {/each}
    <Button
      variant="primary"
      onclick={() => void tabs.start(router.route.name === 'view' ? router.route.id : null)}
    >
      Try again
    </Button>
  </div>
{:else if router.route.name === 'view' && shown}
  {#key router.route.id}
    <Workspace workspace={shown} viewId={router.route.id} />
  {/key}
{:else}
  <p class="center">Loading the board…</p>
{/if}

<style>
  .center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    height: 100%;
    margin: 0;
    color: var(--ink-muted);
  }

  .center h1 {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-lg);
  }

  .center p {
    margin: 0;
  }
</style>
