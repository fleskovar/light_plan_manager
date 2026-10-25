<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { HubInfoDto } from '$shared';
  import { api } from '$lib/api/client.js';
  import ProjectsPage from './ProjectsPage.svelte';
  import { ProjectsPage as ProjectsPageModel } from './projects.svelte.js';

  /**
   * The root of the app on the page `/projects`, and on the hub of `lpm ui`.
   * `main.ts` mounts it instead of `App.svelte`. This is the composition root:
   * it wires the real API and the real navigation into the view-model.
   */
  interface Props {
    /** Set on the hub, which serves no board. */
    readonly hub: HubInfoDto | null;
  }

  let { hub }: Props = $props();

  const page = new ProjectsPageModel(
    {
      list: api.projects,
      open: api.openProject,
      views: api.projectViews,
      reveal: api.revealProject,
      backups: api.backups,
      jobs: api.storeJobs,
      move: api.moveProject,
      backup: api.backupProject,
      restore: api.restoreBackup,
    },
    (url) => window.location.assign(url),
  );
  void page.load();
  onDestroy(() => page.dispose());
</script>

<ProjectsPage {page} {hub} />
