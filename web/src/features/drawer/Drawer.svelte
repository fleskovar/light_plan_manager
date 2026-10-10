<script lang="ts">
  import type { DrawerTab } from '$shared';
  import Tabs from '$lib/ui/Tabs.svelte';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import GanttView from './gantt/GanttView.svelte';
  import PeriodsView from './periods/PeriodsView.svelte';
  import RemoteView from './remote/RemoteView.svelte';
  import TableView from './table/TableView.svelte';
  import TeamView from './team/TeamView.svelte';

  /**
   * The bottom drawer: four ways of reading the same board, sharing one
   * selection with the canvas. Its height is owned by the workspace above it, so
   * dragging the splitter is persisted in the view like everything else.
   *
   * Gantt and Periods are the two halves of the timeline: one reads the plan on
   * a date scale, the other fills the increments and sprints that produce it.
   * A board that does not plan with dates — switched to Queue at the top of
   * the queue panel (`lpm planning queue`), or simply a config with no period
   * types — drops both, and leaves the queue down the left edge
   * (`features/queue`) to ask the dependency graph the question the calendar
   * was answering.
   */
  const workspace = useWorkspace();

  /** The calendar tabs are offered only when the board plans with one. */
  const scheduling = $derived(workspace.planning === 'periods');

  /*
   * A registry view has one reading and only one. Periods, Gantt, Queue and
   * Team all answer questions about *this* piece of work — when it happens, who
   * has it, what is ready — and a template is the shape of work rather than a
   * piece of it, so every one of them would be an empty pane.
   */
  const tabs = $derived(
    workspace.mode === 'templates'
      ? [{ id: 'table' as const, label: 'Templates' }]
      : [
          { id: 'table' as const, label: 'Table' },
          ...(scheduling
            ? [
                { id: 'periods' as const, label: 'Periods' },
                { id: 'gantt' as const, label: 'Gantt' },
              ]
            : []),
          { id: 'team' as const, label: 'Team', disabled: !workspace.config.hasResources },
          { id: 'sync' as const, label: 'Sync' },
        ],
  );

  /*
   * A view saved while planning with sprints remembers the Periods tab; opening
   * it in queue mode has to land somewhere that exists.
   */
  const tab = $derived(
    tabs.some((entry) => entry.id === workspace.doc.drawer.tab)
      ? workspace.doc.drawer.tab
      : ('table' as const),
  );

  function select(tab: DrawerTab): void {
    workspace.doc.drawer.tab = tab;
    workspace.scheduleSave();
  }
</script>

<section class="drawer" aria-label="Board details">
  <header>
    <Tabs {tabs} active={tab} onselect={select} />
    <button
      class="collapse"
      type="button"
      title="Hide the drawer"
      onclick={() => {
        workspace.doc.drawer.open = false;
        workspace.scheduleSave();
      }}
    >
      ▾
    </button>
  </header>

  <div class="content">
    {#if tab === 'table'}
      <TableView />
    {:else if tab === 'periods'}
      <PeriodsView />
    {:else if tab === 'gantt'}
      <GanttView />
    {:else if tab === 'sync'}
      <RemoteView />
    {:else}
      <TeamView />
    {/if}
  </div>
</section>

<style>
  .drawer {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    background: var(--surface-1);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .collapse {
    border: none;
    background: none;
    color: var(--ink-muted);
    line-height: 1;
    padding: 0 var(--space-2);
  }

  .content {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
</style>
