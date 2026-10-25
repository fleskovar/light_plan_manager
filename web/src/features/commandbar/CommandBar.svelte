<script lang="ts">
  import { useShell } from '$lib/app/shell.svelte.js';
  import { usePreferences } from '$lib/app/preferences.svelte.js';
  import { useTabs } from '$lib/app/tabs.svelte.js';
  import MenuBar from '$lib/ui/menu/MenuBar.svelte';
  import { usePool } from '$lib/workspace/pool.svelte.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import { barMenus, openLibrary } from './menus.js';
  import ModeSwitch from './ModeSwitch.svelte';

  /**
   * The top bar, in two rows. The first row holds the name of the board on
   * the left. On the right it holds the Library button, which opens the
   * Library page in its own window, how far behind `.lpm` the active view is,
   * and the switch between read mode and edit mode. The second row holds the
   * menu bar (File, Edit, View, Help). The component also sets the title of
   * the browser window to the name of the board.
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

<!-- The window title is the name of the board, so a reader with several
     boards open can tell their browser tabs apart. Until the board is read,
     the title stays as `index.html` sets it. -->
<svelte:head>
  {#if workspace.ready}
    <title>{workspace.config.boardName}</title>
  {/if}
</svelte:head>

<header class="bar">
  <!-- The first row: the name of the board on the left, and the status label
       and the mode switch in the top-right corner of the window. -->
  <div class="title-row">
    {#if workspace.ready}
      <span class="board" title="The board that this window shows">{workspace.config.boardName}</span>
      <span class="spacer"></span>
      <button
        type="button"
        class="library"
        title="Open the library of this board in its own window: prompts, summaries and requirement documents"
        onclick={() => openLibrary({ tabs, workspace }, null)}
      >
        Library
      </button>
      <span class="status" class:dirty={workspace.dirty || workspace.unsaved}>{statusLabel}</span>
      <ModeSwitch mode={workspace.canvasMode} />
    {/if}
  </div>

  <!-- The second row: the menus. -->
  <div class="menu-row">
    <MenuBar {menus} />
  </div>
</header>

<style>
  .bar {
    flex: none;
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    /* The row keeps its height while a view loads and has no name to show. */
    min-height: 2.25rem;
    padding: var(--space-1) var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .menu-row {
    display: flex;
    align-items: center;
    padding: 0 var(--space-2);
  }

  .spacer {
    flex: 1;
  }

  /* The name of the board, in the size and weight of a title. */
  .board {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink);
    font-size: var(--text-xl);
    font-weight: 700;
    letter-spacing: 0.01em;
  }

  .library {
    padding: 0.15rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    color: var(--ink);
    font-size: var(--text-sm);
  }

  .library:hover {
    border-color: var(--border-strong);
    background: var(--surface-2);
  }

  .status {
    font-size: var(--text-xs);
    color: var(--ink-muted);
    white-space: nowrap;
  }

  .status.dirty {
    color: var(--warn);
    font-weight: 600;
  }
</style>
