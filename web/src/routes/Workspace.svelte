<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { SvelteFlowProvider } from '@xyflow/svelte';
  import { DEFAULT_DRAWER_HEIGHT } from '$shared';
  import { Shell, provideShell } from '$lib/app/shell.svelte.js';
  import { goHome } from '$lib/app/router.svelte.js';
  import { findBinding, isTyping } from '$lib/shortcuts/bindings.js';
  import Button from '$lib/ui/Button.svelte';
  import ConfirmDialog from '$lib/ui/ConfirmDialog.svelte';
  import ContextMenu from '$lib/ui/menu/ContextMenu.svelte';
  import Notices from '$lib/ui/Notices.svelte';
  import ReadinessDialog from '$features/drawer/remote/ReadinessDialog.svelte';
  import { paneFit, paneScale } from '$lib/ui/scale.js';
  import Splitter from '$lib/ui/Splitter.svelte';
  import { api } from '$lib/api/client.js';
  import { Workspace, provideWorkspace } from '$lib/workspace/workspace.svelte.js';
  import CommandBar from '$features/commandbar/CommandBar.svelte';
  import Drawer from '$features/drawer/Drawer.svelte';
  import QueuePanel from '$features/queue/QueuePanel.svelte';
  import { RemoteState, provideRemoteState } from '$features/drawer/remote/remote.svelte.js';
  import { ConnectionsState, provideConnectionsState } from '$features/drawer/remote/connections.svelte.js';
  import { GitState, provideGitState } from '$features/drawer/remote/git.svelte.js';
  import ResourceDialog from '$features/drawer/team/ResourceDialog.svelte';
  import NewResourceDialog from '$features/drawer/team/NewResourceDialog.svelte';
  import BreakdownDialog from '$features/panel/BreakdownDialog.svelte';
  import SidePanel from '$features/panel/SidePanel.svelte';
  import Canvas from '$features/canvas/Canvas.svelte';
  import HierarchyDialog from '$features/canvas/HierarchyDialog.svelte';
  import ReparentDialog from '$features/canvas/ReparentDialog.svelte';

  /**
   * The main screen. It owns the two stores and the layout, and hands both down
   * through context; every panel below reads from them rather than from props,
   * which is what keeps the tree shallow.
   */
  interface Props {
    viewId: string;
  }

  let { viewId }: Props = $props();

  const workspace = provideWorkspace(new Workspace());
  const shell = provideShell(new Shell());
  const remote = provideRemoteState(
    new RemoteState(api, {
      setSyncBadges: (badges) => {
        workspace.syncBadges = { ...badges };
      },
      // The board already knows what a document is called; a table row showing
      // only `LP-509` makes a reader go and look it up.
      titleOf: (id) => workspace.node(id)?.title ?? id,
      select: (ids) => {
        workspace.selection.set(ids);
        // Travel the canvas to the selection without replacing it — `focus`
        // would narrow it back to one node, and a count means all of them.
        if (ids.length > 0) workspace.selection.focusRequest += 1;
      },
      notify: (level, message, details) => workspace.notify(level, message, details),
      report: (error) => workspace.report(error),
      dirty: () => workspace.dirty,
      refresh: async () => {
        await workspace.pull(true);
      },
      push: async () => {
        await workspace.push();
      },
    }),
  );

  // Connecting a remote from the Sync tab. When the set of remotes changes, the
  // remote state re-reads its list rather than running a full load, which a
  // slow drift report can hold busy for minutes.
  provideConnectionsState(
    new ConnectionsState(api, {
      notify: (level, message, details) => workspace.notify(level, message, details),
      report: (error) => workspace.report(error),
      remotesChanged: (name) => remote.refreshRemotes(name),
    }),
  );

  // Sharing the board through its own git repository: the other thing the
  // Sync tab can hold. After a sync or a setup the board on disk has moved, so
  // it is re-read straight away rather than at the next poll.
  provideGitState(
    new GitState(api, {
      notify: (level, message, details) => workspace.notify(level, message, details),
      report: (error) => workspace.report(error),
      boardChanged: async () => {
        await workspace.pull(true);
      },
      remotesChanged: () => remote.refreshRemotes(),
    }),
  );

  let failed = $state(false);
  let arrange = $state<() => void>(() => {});

  /**
   * The drawer is a wish bounded by the window it is opened in.
   *
   * A height saved on a big screen is replayed on whatever screen is here now,
   * and replayed unchecked it is destructive rather than merely large: 865px
   * saved, opened in an 808px window, left the canvas at **zero** height and
   * hung the drawer 100px below the bottom of the screen. Collapsing it and
   * pressing the button again did exactly the same thing, which is how it came
   * to be reported as a button that does not work.
   *
   * So the saved height is honoured up to the room there is, `MIN_CANVAS` is
   * what the board keeps whatever happens, and the splitter cannot be dragged
   * past the same bound. What is *saved* is left alone — the same view opened
   * on a taller screen should be tall again.
   */
  const MIN_CANVAS = 140;
  let stackHeight = $state(0);
  const drawerRoom = $derived(Math.max(stackHeight - MIN_CANVAS, 120));
  const drawerHeight = $derived(paneFit(workspace.doc.drawer.height, stackHeight, MIN_CANVAS));

  /**
   * The queue down the left edge, on every board view whichever way it plans:
   * "what is next?" is a fair question in the middle of a sprint too. A
   * registry view has none, because a template is not work anybody picks up.
   * Its width is a wish bounded the same way the drawer's height is: whatever
   * the details panel on the other side has taken, the canvas keeps
   * `MIN_CANVAS_WIDTH` between them.
   */
  const MIN_CANVAS_WIDTH = 320;
  const MIN_QUEUE = 220;
  let middleWidth = $state(0);
  const queueOffered = $derived(workspace.mode === 'board');
  const panelShown = $derived(workspace.doc.panel.open || workspace.doc.panel.pinned);
  const queueAvailable = $derived(middleWidth - (panelShown ? workspace.doc.panel.width : 0));
  const queueRoom = $derived(Math.max(queueAvailable - MIN_CANVAS_WIDTH, MIN_QUEUE));
  const queueWidth = $derived(paneFit(workspace.doc.queue.width, queueAvailable, MIN_CANVAS_WIDTH));

  /**
   * What the reveal button says it will show. Taken from the tab that is
   * actually open rather than a written-out list, which went stale the moment
   * the Sync tab was added and said "Table · Periods · Gantt · Team" over a
   * drawer that would open on Sync.
   */
  const DRAWER_TABS: Record<string, string> = {
    table: 'Table',
    periods: 'Periods',
    gantt: 'Gantt',
    team: 'Team',
    sync: 'Sync',
  };
  const drawerTabLabel = $derived(
    `Show ${DRAWER_TABS[workspace.doc.drawer.tab] ?? 'the board details'}`,
  );

  // App.svelte keys this component on the id, so opening once is correct.
  // svelte-ignore state_referenced_locally
  void workspace.open(viewId).catch(() => (failed = true));

  // `open` starts the poll that keeps the board pulled; nothing here stops
  // it, so a workspace that outlived its component would poll forever.
  onDestroy(() => workspace.dispose());

  /**
   * Read the remotes and their drift once the board is open, so the canvas can
   * badge it.
   *
   * **Once**, and the latch is what makes that true. `workspace.ready` is a
   * getter over the snapshot, so this effect depends on the snapshot *signal*
   * rather than on the boolean: every background pull replaces the snapshot
   * and re-ran the whole bootstrap — `listRemotes`, a status read per remote
   * and `autoCheck` — every five seconds, which is how a tracker check that
   * had just answered "5 to push" was replaced by a locally-derived 48 a
   * moment later. The board changing is a reason to re-read the *local* half
   * (below); it is never a reason to start the bootstrap again.
   */
  let remotesStarted = false;
  $effect(() => {
    if (!workspace.ready || remotesStarted) return;
    remotesStarted = true;
    untrack(() => {
      void startRemotes();
    });
  });

  /**
   * The tracker remotes are an experimental feature: offered only when the
   * server was started with `lpm ui --experimental`. Until the server says so
   * `remote.enabled` stays false, nothing tracker-related is fetched, and the
   * Sync tab holds git sharing alone. A server too old to answer counts as off.
   */
  async function startRemotes(): Promise<void> {
    const info = await api.serverInfo().catch(() => null);
    remote.enabled = info?.experimental === true;
    if (!remote.enabled) return;
    await remote.load();
    // Opening a view is asking about the mirror, so the tracker read starts
    // here rather than waiting for somebody to press a button — it is one
    // paginated listing now, not one request per twin. Deliberately not
    // awaited: the panel and the canvas are usable while it runs, and it
    // keeps its own clock, error surface and Stop.
    void remote.autoCheck();
  }

  /**
   * Keep the Sync tab's local half following the board.
   *
   * This one *does* want to re-run whenever the snapshot changes — a poll, a
   * push, a popup window's write — because "what has been edited here since
   * the last sync" is a question about the board, and answering it costs no
   * tracker request and no credential. It is also what replaced the Refresh
   * button: re-reading the board's own half is a step with no decision in it.
   * Whatever the tracker last said is blended back in by `loadStatus`, so this
   * can never widen a checked count.
   */
  $effect(() => {
    if (workspace.snapshot === null) return;
    untrack(() => {
      const name = remote.selected;
      if (name !== null && !remote.loading) void remote.loadStatus(name);
    });
  });

  // The panel opens on selection unless it has been closed and left unpinned.
  $effect(() => {
    if (workspace.selection.primary && workspace.doc.panel.pinned) {
      workspace.doc.panel.open = true;
    }
  });

  function onkeydown(event: KeyboardEvent): void {
    if (isTyping(event.target)) return;
    const binding = findBinding(event);
    if (!binding) return;
    event.preventDefault();
    binding.run({ workspace, shell, arrange: () => arrange() });
  }

  function onbeforeunload(event: BeforeUnloadEvent): void {
    if (workspace.dirty) event.preventDefault();
  }

  /** Pull when a popup window pushed changes, so the canvas stays in sync. */
  function onMessage(event: MessageEvent): void {
    if (event.data?.type === 'lpm:pushed' && event.origin === window.location.origin) {
      void workspace.pull(true);
    }
    if (event.data?.type === 'lpm:open' && event.origin === window.location.origin) {
      const id = event.data.nodeId as string;
      if (id) workspace.selection.focus(id);
    }
  }
</script>

<svelte:window {onkeydown} {onbeforeunload} onmessage={onMessage} />

{#if failed}
  <div class="failure">
    <h1>Could not open “{viewId}”</h1>
    <Button variant="primary" onclick={goHome}>Back to all views</Button>
  </div>
{:else if !workspace.ready}
  <p class="loading">Loading the board…</p>
{:else}
  <div class="shell">
    <CommandBar />

    <div class="middle" bind:clientWidth={middleWidth}>
      {#if queueOffered}
        {#if workspace.doc.queue.open}
          <QueuePanel width={queueWidth} />
          <Splitter
            orientation="vertical"
            pane="before"
            size={queueWidth}
            min={MIN_QUEUE}
            max={queueRoom}
            label="Resize the queue"
            onresize={(width) => {
              workspace.doc.queue.width = width;
              workspace.scheduleSave();
            }}
          />
        {:else}
          <button
            class="reveal side start"
            type="button"
            title={workspace.planning === 'queue'
              ? 'Show the queue — the board is one continuous queue'
              : 'Show the queue'}
            onclick={() => {
              workspace.doc.queue.open = true;
              workspace.scheduleSave();
            }}
          >
            Queue
          </button>
        {/if}
      {/if}

      <div class="stack" bind:clientHeight={stackHeight}>
        <SvelteFlowProvider>
          <Canvas bind:arrange />
        </SvelteFlowProvider>

        {#if workspace.doc.drawer.open}
          <Splitter
            size={drawerHeight}
            min={120}
            max={drawerRoom}
            label="Resize the drawer"
            onresize={(height) => {
              workspace.doc.drawer.height = height;
              workspace.scheduleSave();
            }}
          />
          <!-- `ui-scale` is what makes a taller drawer show bigger rows rather
               than more empty space; the factor comes from its own height. -->
          <div
            class="drawer ui-scale"
            style="height: {drawerHeight}px; --ui-scale: {paneScale(
              drawerHeight,
              DEFAULT_DRAWER_HEIGHT,
            )}"
          >
            <Drawer />
          </div>
        {:else}
          <button
            class="reveal"
            type="button"
            title="Show the board details"
            onclick={() => {
              workspace.doc.drawer.open = true;
              workspace.scheduleSave();
            }}
          >
            ▴ {drawerTabLabel}
          </button>
        {/if}
      </div>

      {#if panelShown}
        <Splitter
          orientation="vertical"
          size={workspace.doc.panel.width}
          min={260}
          max={900}
          label="Resize the details panel"
          onresize={(width) => {
            workspace.doc.panel.width = width;
            workspace.scheduleSave();
          }}
        />
        <SidePanel />
      {:else}
        <button
          class="reveal side"
          type="button"
          onclick={() => {
            workspace.doc.panel.open = true;
            workspace.scheduleSave();
          }}
        >
          Details
        </button>
      {/if}
    </div>
  </div>

  {#if shell.menu}
    <ContextMenu
      anchor={shell.menu.anchor}
      entries={shell.menu.entries}
      onclose={() => shell.closeMenu()}
    />
  {/if}

  {#if shell.hierarchyOpen}
    <HierarchyDialog onclose={() => shell.closeHierarchy()} />
  {/if}

  <!-- A dialog opened on a document nobody has pushed yet holds its temporary
       id, and the push that follows every edit allocates a real one; `resolve`
       is what keeps the dialog on the same document across that. -->
  {#if shell.breakdownTarget}
    <BreakdownDialog
      id={workspace.resolve(shell.breakdownTarget)}
      onclose={() => shell.closeBreakdown()}
    />
  {/if}

  {#if shell.resourceTarget}
    <ResourceDialog
      id={workspace.resolve(shell.resourceTarget)}
      onclose={() => shell.closeResource()}
    />
  {:else if shell.newResourceType}
    <NewResourceDialog
      type={shell.newResourceType}
      onclose={(created) => {
        shell.closeResource();
        if (created) workspace.selection.set([created]);
      }}
    />
  {/if}

  {#if shell.reparentRequest}
    <ReparentDialog request={shell.reparentRequest} onclose={() => shell.closeReparent()} />
  {/if}

  {#if shell.confirmation}
    {#key shell.confirmation}
      <ConfirmDialog
        confirmation={shell.confirmation}
        onresolve={(accepted, choice) => shell.resolveConfirmation(accepted, choice)}
      />
    {/key}
  {/if}
{/if}

<!-- The readiness gate lives here rather than in the Sync tab, because a push
     starts from four places — the tab, the Coverage list, the side panel and
     the canvas menu — and a dialog mounted inside one of them would leave the
     other three pressing Push and watching nothing happen. -->
{#if remote.enabled}
  <ReadinessDialog />
{/if}

<Notices notices={workspace.notices} ondismiss={(id) => workspace.dismiss(id)} />

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    /* Nothing inside may push the page taller than the window: a pane that
       overflows takes its own controls off the bottom of the screen, where
       they can only be reached by scrolling a document nobody expects to
       scroll. `paneFit` keeps that from happening; this is the backstop. */
    overflow: hidden;
  }

  .middle {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  .stack {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .drawer {
    flex: none;
    min-height: 0;
    border-top: 1px solid var(--border);
  }

  .reveal {
    flex: none;
    padding: var(--space-1) var(--space-3);
    border: none;
    border-top: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--ink-muted);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .reveal:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .reveal.side {
    border-top: none;
    border-left: 1px solid var(--border);
    writing-mode: vertical-rl;
    padding: var(--space-3) var(--space-1);
  }

  .reveal.side.start {
    border-left: none;
    border-right: 1px solid var(--border);
  }

  .loading,
  .failure {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    height: 100%;
    color: var(--ink-muted);
  }
</style>
