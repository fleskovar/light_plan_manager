<script lang="ts">
  import { useShell } from '$lib/app/shell.svelte.js';
  import { usePreferences } from '$lib/app/preferences.svelte.js';
  import { useTabs } from '$lib/app/tabs.svelte.js';
  import { usePool } from '$lib/workspace/pool.svelte.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import TabStrip from './TabStrip.svelte';
  import { closeTab, tabMenu, type ViewContext } from './menus.js';

  /**
   * The tabs of the open views, wired to the stores.
   *
   * `Workspace.svelte` places this row in the column of the canvas, above the
   * canvas, so the row is as wide as the canvas. `TabStrip` draws the tabs.
   * This component supplies the tabs and the actions.
   */
  const tabs = useTabs();
  const pool = usePool();
  const shell = useShell();
  const workspace = useWorkspace();
  const preferences = usePreferences();

  const context = $derived<ViewContext>({
    tabs,
    shell,
    workspace,
    workspaceOf: (id) => pool.get(id),
    preferences,
  });

  const items = $derived(
    tabs.open.map((id) => ({
      id,
      label: tabs.name(id),
      unsaved: pool.get(id)?.unsaved === true,
    })),
  );
</script>

<TabStrip
  tabs={items}
  active={tabs.active}
  onselect={(id) => tabs.activate(id)}
  onclose={(id) => closeTab(context, id)}
  onmenu={(event, id) => shell.openMenu(event, tabMenu(context, id))}
  onadd={() => (shell.viewDialog = 'new')}
/>
