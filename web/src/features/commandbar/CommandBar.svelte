<script lang="ts">
  import { useShell } from '$lib/app/shell.svelte.js';
  import { goHome } from '$lib/app/router.svelte.js';
  import Button from '$lib/ui/Button.svelte';
  import { createNode } from '$lib/workspace/mutations.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';

  /**
   * The top bar: what view is open, and how far behind `.lpm` it is.
   *
   * Every edit pushes itself — `Workspace.record` debounces a push the same
   * way it debounces the view save, so there is nothing here to press. The
   * status label is the only thing left to read: it says "pushing" while
   * one is in flight, and otherwise how many edits are still waiting for the
   * debounce to fire.
   */
  const workspace = useWorkspace();
  const shell = useShell();

  let newOpen = $state(false);

  const rootTypes = $derived(
    Object.values(workspace.config.types).filter((type) => type.kind === 'issue' && type.depth === 0),
  );
  const otherTypes = $derived(
    Object.values(workspace.config.types).filter((type) => type.kind !== 'issue'),
  );

  const statusLabel = $derived(
    workspace.status === 'pushing'
      ? 'Pushing…'
      : workspace.status === 'loading'
        ? 'Loading…'
        : workspace.status === 'saving'
          ? 'Saving…'
          : workspace.dirty
            ? `${workspace.pending.length} unpushed`
            : 'Up to date',
  );

  function add(type: string): void {
    newOpen = false;
    const id = createNode(workspace, { type, parentId: null });
    workspace.selection.focus(id);
  }

  /**
   * Everything about *how this view is drawn*, as opposed to what is on it.
   * The menu machinery is the canvas's, submenus and all, so this stays a
   * description rather than a second dropdown implementation.
   */
  function openOptions(event: MouseEvent): void {
    const button = (event.currentTarget as HTMLElement).getBoundingClientRect();
    shell.openMenuAt({ x: button.left, y: button.bottom + 4 }, [
      {
        label: 'DAG',
        items: [
          {
            label: 'Hierarchy display…',
            onSelect: () => shell.openHierarchy(),
          },
        ],
      },
      {
        label: 'Planning',
        items: [
          {
            label: 'Sprints and increments',
            hint: workspace.planning === 'periods' ? '✓' : undefined,
            disabled: !workspace.config.hasPeriods,
            onSelect: () => workspace.setPlanning('periods'),
          },
          {
            label: 'Queue',
            hint: workspace.planning === 'queue' ? '✓' : undefined,
            onSelect: () => workspace.setPlanning('queue'),
          },
        ],
      },
    ]);
  }
</script>

<header class="bar">
  <button class="home" type="button" onclick={goHome} title="All views">←</button>

  <div class="identity">
    <strong>{workspace.doc.name}</strong>
    <span class="board">{workspace.config.boardName}</span>
  </div>

  <Button size="sm" onclick={openOptions} title="View options">Options ▾</Button>

  <div class="menu">
    <Button size="sm" onclick={() => (newOpen = !newOpen)}>New ▾</Button>
    {#if newOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="dropdown" onmouseleave={() => (newOpen = false)}>
        {#each rootTypes as type (type.name)}
          <button type="button" onclick={() => add(type.name)}>{type.label}</button>
        {/each}
        {#if otherTypes.length}
          <hr />
          {#each otherTypes as type (type.name)}
            <button type="button" onclick={() => add(type.name)}>
              {type.label}
              <span class="kind">{type.kind}</span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>

  <span class="spacer"></span>

  <span class="status" class:dirty={workspace.dirty}>{statusLabel}</span>
</header>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }

  .home {
    border: none;
    background: none;
    color: var(--ink-muted);
    font-size: var(--text-lg);
    line-height: 1;
    padding: 0 var(--space-1);
  }

  .identity {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin-right: var(--space-3);
  }

  .board {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .menu {
    position: relative;
  }

  .dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 40;
    min-width: 11rem;
    padding: var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    box-shadow: var(--shadow-md);
  }

  .dropdown button {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
    padding: 0.3rem 0.5rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    font-size: var(--text-sm);
    text-align: left;
  }

  .dropdown button:hover {
    background: var(--surface-2);
  }

  .kind {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  hr {
    margin: var(--space-1) 0;
    border: none;
    border-top: 1px solid var(--border);
  }

  .spacer {
    flex: 1;
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
