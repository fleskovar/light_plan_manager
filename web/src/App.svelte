<script lang="ts">
  import { onDestroy } from 'svelte';
  import { browserPreferences, providePreferences } from '$lib/app/preferences.svelte.js';
  import { createRouter } from '$lib/app/router.svelte.js';
  import IssueView from './routes/IssueView.svelte';
  import Welcome from './routes/Welcome.svelte';
  import Workspace from './routes/Workspace.svelte';

  const router = createRouter();

  // Appearance belongs to the reader, not to a view, so it is read once here
  // for every screen — and applied before the first paint, not after it.
  const preferences = providePreferences(browserPreferences());
  onDestroy(() => preferences.dispose());
</script>

{#if router.route.name === 'issue'}
  {#key router.route.nodeId}
    <IssueView nodeId={router.route.nodeId} viewId={router.route.viewId} />
  {/key}
{:else if router.route.name === 'view'}
  {#key router.route.id}
    <Workspace viewId={router.route.id} />
  {/key}
{:else}
  <Welcome />
{/if}
