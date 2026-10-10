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
  const otherPlanning = $derived(workspace.planning === 'queue' ? 'periods' : 'queue');
</script>

<Modal title="Board configuration" size="lg" {onclose}>
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

  <Tabs
    tabs={[
      { id: 'types', label: 'Types and attributes' },
      { id: 'statuses', label: 'Statuses' },
      { id: 'remote', label: 'Remote board' },
      { id: 'templates', label: 'Templates' },
    ]}
    active={tab}
    onselect={(id) => shell.openConfig(id)}
  />

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

  <div class="pane">
    {#if tab === 'types'}
      <TypesTab {editor} />
    {:else if tab === 'statuses'}
      <StatusesTab {editor} />
    {:else if tab === 'remote'}
      <RemoteBoardTab />
    {:else}
      <TemplatesTab {editor} />
    {/if}
  </div>

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
    margin: 0 0 var(--space-3);
    color: var(--ink-muted);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .strip {
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
    margin-top: var(--space-4);
  }
</style>
