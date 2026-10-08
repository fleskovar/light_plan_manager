<script lang="ts">
  import { createRouter } from '$lib/app/router.svelte.js';
  import IssueView from './routes/IssueView.svelte';
  import Welcome from './routes/Welcome.svelte';
  import Workspace from './routes/Workspace.svelte';

  const router = createRouter();
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
