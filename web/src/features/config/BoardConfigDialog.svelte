<script lang="ts">
  import { useShell, type ConfigTab } from '$lib/app/shell.svelte.js';
  import Button from '$lib/ui/Button.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import Tabs from '$lib/ui/Tabs.svelte';
  import { usePool } from '$lib/workspace/pool.svelte.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import { ConfigEditor } from './editor.svelte.js';
  import RemoteBoardTab from './remote/RemoteBoardTab.svelte';
  import StatusesTab from './StatusesTab.svelte';
  import StorageTab from './StorageTab.svelte';
  import TemplatesTab from './TemplatesTab.svelte';
  import TypesTab from './TypesTab.svelte';

  /**
   * The dialog that File ▸ Board configuration opens.
   *
   * The dialog shows what `.lpm/config.yml` declares: the hierarchy of types of
   * each namespace, the attributes of each type, and the statuses. `lpm init`
   * copied that file from a board template, and the board does not record the
   * name of the template, so the dialog shows the file and not a template name.
   *
   * Each change is written at once. `ConfigEditor.apply` sends the change to
   * `POST /api/config/edits`, and the server rewrites the config and every
   * document that holds a renamed name.
   *
   * The dialog is the one place for the settings of the board. Its tabs:
   *
   * - **Types and attributes** and **Statuses** change the vocabulary.
   * - **Remote board** shares the board through git, and on a server started
   *   with `lpm ui --experimental` connects a tracker and maps its items.
   * - **Templates** saves the configuration as a template for new boards and
   *   chooses the default template.
   * - **Storage** shows whether the board is in its project or in the central
   *   store, moves it between the two, backs it up, and restores it from its
   *   backup. The "All projects" page offers the same actions for every board.
   *
   * `shell.configTab` holds the open tab, so a menu entry or the Sync tab of
   * the drawer can open the dialog on a tab. The planning mode, which the
   * switch of the queue panel also writes, has a button beside its value.
   */
  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  const workspace = useWorkspace();
  const shell = useShell();
  const pool = usePool();
  const editor = new ConfigEditor({ workspace, workspaces: () => pool.all() });

  const tab = $derived<ConfigTab>(shell.configTab ?? 'types');

  const config = $derived(workspace.config);

  /** The scrolling pane. A new tab starts at its top, not where the last tab was scrolled. */
  let pane = $state<HTMLElement | null>(null);
  $effect(() => {
    void tab;
    if (pane) pane.scrollTop = 0;
  });
  const otherPlanning = $derived(workspace.planning === 'queue' ? 'periods' : 'queue');
</script>

<Modal title="Board configuration" size="lg" fixedHeight {onclose}>
  <!-- Three rows in a dialog of one height. The top row and the message row
       keep their place, and only the pane of the tab scrolls. So the tabs and
       the buttons above them do not move when the reader changes the tab. -->
  <div class="top">
  <dl class="facts">
    <div><dt>Board</dt><dd>{config.boardName}</dd></div>
    <div>
      <dt>Planning</dt>
      <dd>
        {config.planning}
        {#if workspace.canPlanWithPeriods}
          <button
            type="button"
            class="link"
            title={otherPlanning === 'queue'
              ? 'Ignore every sprint and increment, and order the work by priority and by dependencies'
              : 'Order the work by the sprints and the increments of the board'}
            onclick={() => void workspace.setPlanning(otherPlanning)}
          >
            Switch to {otherPlanning}
          </button>
        {/if}
      </dd>
    </div>
    <div><dt>Default status</dt><dd><code>{config.defaultStatus}</code></dd></div>
    <div>
      <dt>Priority attribute</dt>
      <dd>{#if config.priorityAttribute}<code>{config.priorityAttribute}</code>{:else}none{/if}</dd>
    </div>
    <div>
      <dt>Effort attribute</dt>
      <dd>{#if config.effortAttribute}<code>{config.effortAttribute}</code>{:else}none{/if}</dd>
    </div>
  </dl>
  <p class="lede">
    These values are in the file <code>.lpm/config.yml</code>. Each change in this dialog is written to that
    file at once. A new name for a type, a status or an attribute is also written to every document that
    holds the old name.
  </p>
  <!-- The file holds more than the dialog edits: the flags of a type and of a
       status, the body of a type and the default of an attribute. The two
       buttons take the reader to the file itself. -->
  <div class="file">
    <Button
      size="sm"
      disabled={editor.busy}
      title="Open .lpm/config.yml in the program that this computer uses for a YAML file"
      onclick={() => void editor.openFile()}
    >
      Open
    </Button>
    <Button
      size="sm"
      disabled={editor.busy}
      title="Show .lpm/config.yml in the file manager of this computer"
      onclick={() => void editor.revealFile()}
    >
      Show in explorer
    </Button>
    <span class="hint">Edit the YAML file yourself. The dialog shows what you save.</span>
  </div>

  <Tabs
    tabs={[
      { id: 'types', label: 'Types and attributes' },
      { id: 'statuses', label: 'Statuses' },
      { id: 'remote', label: 'Remote board' },
      { id: 'templates', label: 'Templates' },
      { id: 'storage', label: 'Storage' },
    ]}
    active={tab}
    onselect={(id) => shell.openConfig(id)}
  />
  </div>

  <div class="pane" bind:this={pane}>
    {#if tab === 'types'}
      <TypesTab {editor} />
    {:else if tab === 'statuses'}
      <StatusesTab {editor} />
    {:else if tab === 'remote'}
      <RemoteBoardTab />
    {:else if tab === 'storage'}
      <StorageTab />
    {:else}
      <TemplatesTab {editor} />
    {/if}
  </div>

  <!-- The message of the last action sits under the pane and above the footer.
       There it is on screen wherever the pane is scrolled, and it takes its
       room from the bottom of the pane, so the content of the pane does not
       shift. -->
  {#if editor.problem}
    <div class="strip problem" role="alert">
      <strong>{editor.problem.message}</strong>
      {#if editor.problem.details.length}
        <ul>
          {#each editor.problem.details as detail (detail)}
            <li>{detail}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else if editor.done}
    <div class="strip done" role="status">
      <strong>{editor.done.message}</strong>
      {#if editor.done.notes.length}
        <ul>
          {#each editor.done.notes as note (note)}
            <li>{note}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <Button variant="primary" onclick={onclose}>Done</Button>
  {/snippet}
</Modal>

<style>
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-5);
    margin: 0 0 var(--space-3);
  }

  .facts div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  dt {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  dd {
    margin: 0;
    font-size: var(--text-sm);
  }

  code {
    font-family: var(--font-mono);
    font-size: 0.95em;
  }

  .link {
    margin-left: var(--space-2);
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    font-size: var(--text-xs);
  }

  .lede {
    margin: 0 0 var(--space-2);
    color: var(--ink-muted);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .file {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .hint {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .top {
    flex: none;
  }

  .strip {
    flex: none;
    max-height: 30%;
    overflow: auto;
    margin-top: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .strip ul {
    margin: var(--space-1) 0 0;
    padding-left: var(--space-4);
    font-size: var(--text-xs);
  }

  .problem {
    border: 1px solid var(--danger);
    color: var(--danger);
  }

  .done {
    border: 1px solid var(--tone-done);
    background: var(--tone-done-soft);
  }

  .pane {
    flex: 1;
    min-height: 0;
    overflow: auto;
    margin-top: var(--space-3);
    /* Room for the scroll bar, so it does not cover the buttons at the right edge. */
    padding-right: var(--space-2);
  }
</style>
