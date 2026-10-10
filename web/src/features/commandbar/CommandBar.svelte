<script lang="ts">
  import { useShell } from '$lib/app/shell.svelte.js';
  import { usePreferences } from '$lib/app/preferences.svelte.js';
  import { useTabs } from '$lib/app/tabs.svelte.js';
  import MenuBar from '$lib/ui/menu/MenuBar.svelte';
  import { usePool } from '$lib/workspace/pool.svelte.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import { barMenus } from './menus.js';

  /**
   * The top bar: the menu bar (File, Edit, View, Help), the name of the board,
   * and how far behind `.lpm` the active view is.
   *
   * The bar is on screen while a view loads and when a view fails to load. An
   * entry that needs the board is disabled until the workspace is ready, and
   * File ▸ New view and File ▸ Open always work.
   *
   * Every edit pushes itself — `Workspace.record` debounces a push the same
   * way it debounces the view save, so there is nothing here to press. The
   * status label says "pushing" while one is in flight, and otherwise how many
   * edits are still waiting for the debounce to fire.
   */
  interface Props {
    /** Lay the graph out again. `Workspace.svelte` passes the function of the canvas. */
    arrange: () => void;
  }

  let { arrange }: Props = $props();

  const workspace = useWorkspace();
  const shell = useShell();
  const preferences = usePreferences();
  const tabs = useTabs();
  const pool = usePool();

  const statusLabel = $derived(
    workspace.status === 'pushing'
      ? 'Pushing…'
      : workspace.status === 'loading'
        ? 'Loading…'
        : workspace.status === 'saving'
          ? 'Saving…'
          : workspace.dirty
            ? `${workspace.pending.length} unpushed`
            : workspace.unsaved
              ? 'Layout not saved'
              : 'Up to date',
  );

  const menus = $derived(
    barMenus({
      tabs,
      shell,
      workspace,
      workspaceOf: (id) => pool.get(id),
      preferences,
      arrange: () => arrange(),
    }),
  );
</script>

<header class="bar">
  <MenuBar {menus} />

  <span class="spacer"></span>

  {#if workspace.ready}
    <span class="board" title="The board that this window shows">{workspace.config.boardName}</span>
    <span class="status" class:dirty={workspace.dirty || workspace.unsaved}>{statusLabel}</span>
  {/if}
</header>

<style>
  .bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 2px var(--space-2);
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }

  .spacer {
    flex: 1;
  }

  .board {
    max-width: 20rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .status {
    margin-right: var(--space-1);
    font-size: var(--text-xs);
    color: var(--ink-muted);
    white-space: nowrap;
  }

  .status.dirty {
    color: var(--warn);
    font-weight: 600;
  }
</style>
