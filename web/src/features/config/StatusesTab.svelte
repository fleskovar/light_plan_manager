<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import type { ConfigEditor } from './editor.svelte.js';
  import LabelNameForm from './LabelNameForm.svelte';
  import type { StatusRow } from './model.js';
  import { count, statusRows } from './model.js';

  /**
   * The statuses of the board, in the order of the key `statuses` in
   * `.lpm/config.yml`. The tab changes the label and the id of a status, adds a
   * status at a position, and removes a status that no issue holds.
   */
  interface Props {
    editor: ConfigEditor;
  }

  let { editor }: Props = $props();

  const rows = $derived(statusRows(editor.config, editor.nodes));
  const ids = $derived(rows.map((row) => row.id));

  let open = $state<{ form: 'rename' | 'remove'; status: string } | { form: 'add' } | null>(null);
  /** The index that a new status gets. The first terminal status is the default position. */
  let position = $state(0);

  function startAdd(): void {
    const terminal = rows.findIndex((row) => row.terminal);
    position = terminal === -1 ? rows.length : terminal;
    open = { form: 'add' };
  }

  async function add(label: string, id: string): Promise<void> {
    if (await editor.apply([{ op: 'add-status', id, label, index: position }], `Added the status "${id}".`)) {
      open = null;
    }
  }

  async function rename(row: StatusRow, label: string, id: string): Promise<void> {
    const done = await editor.apply(
      [
        {
          op: 'update-status',
          status: row.id,
          ...(label !== row.label ? { label } : {}),
          ...(id !== row.id ? { id } : {}),
        },
      ],
      id !== row.id
        ? `Renamed the status "${row.id}" to "${id}".`
        : `Changed the label of the status "${row.id}" to "${label}".`,
    );
    if (done) open = null;
  }

  async function remove(row: StatusRow): Promise<void> {
    if (await editor.apply([{ op: 'remove-status', status: row.id }], `Removed the status "${row.id}".`)) {
      open = null;
    }
  }

  const removeTitle = (row: StatusRow): string =>
    row.issues > 0
      ? `${count(row.issues, 'issue')} in this status. Move them to another status first.`
      : row.isDefault
        ? 'Each new issue gets this status. Change default_status in .lpm/config.yml first.'
        : 'Remove this status';
</script>

<ol>
  {#each rows as row (row.id)}
    <li>
      <div class="row">
        <span class="label">{row.label}</span>
        <code>{row.id}</code>
        {#if row.isDefault}<span class="flag" title="Each new issue gets this status">default</span>{/if}
        {#if row.active}<span class="flag" title="Work in this status is in progress">active</span>{/if}
        {#if row.terminal}<span class="flag" title="Work in this status is finished">terminal</span>{/if}
        <span class="uses">{count(row.issues, 'issue')}</span>
        <span class="grow"></span>
        <Button size="sm" disabled={editor.busy} onclick={() => (open = { form: 'rename', status: row.id })}>
          Rename
        </Button>
        <Button
          size="sm"
          disabled={editor.busy || row.issues > 0 || row.isDefault}
          title={removeTitle(row)}
          onclick={() => (open = { form: 'remove', status: row.id })}
        >
          Remove
        </Button>
      </div>

      {#if open?.form === 'rename' && open.status === row.id}
        <LabelNameForm
          label={row.label}
          name={row.id}
          taken={ids.filter((id) => id !== row.id)}
          what="status id"
          submitLabel="Save"
          busy={editor.busy}
          impact={(id) =>
            id === row.id
              ? null
              : `The id changes from "${row.id}" to "${id}". This rewrites the field "status" of ${count(row.issues, 'issue')}.`}
          onsubmit={(label, id) => rename(row, label, id)}
          oncancel={() => (open = null)}
        />
      {:else if open?.form === 'remove' && open.status === row.id}
        <p class="confirm">
          <span>Remove the status "{row.id}"? No issue holds this status.</span>
          <Button size="sm" variant="danger" disabled={editor.busy} onclick={() => remove(row)}>Remove</Button>
          <Button size="sm" onclick={() => (open = null)}>Cancel</Button>
        </p>
      {/if}
    </li>
  {/each}
</ol>

{#if open?.form === 'add'}
  <label class="position">
    <span>Position of the new status</span>
    <select bind:value={position}>
      <option value={0}>First</option>
      {#each rows as row, index (row.id)}
        <option value={index + 1}>After {row.label}</option>
      {/each}
    </select>
  </label>
  <LabelNameForm
    taken={ids}
    what="status id"
    submitLabel="Add the status"
    busy={editor.busy}
    onsubmit={add}
    oncancel={() => (open = null)}
  />
{:else}
  <button type="button" class="link" disabled={editor.busy} onclick={startAdd}>+ Add a status</button>
{/if}

<p class="note">
  The flags <code>active</code> and <code>terminal</code> and the key <code>default_status</code> are edited in
  <code>.lpm/config.yml</code>.
</p>

<style>
  ol {
    margin: 0 0 var(--space-3);
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  li {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .label {
    font-weight: 600;
    font-size: var(--text-md);
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .flag {
    padding: 0 0.4rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .uses {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .grow {
    flex: 1;
  }

  .confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--danger);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }

  .confirm span {
    flex: 1;
    min-width: 14rem;
  }

  .position {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
    font-size: var(--text-sm);
  }

  .position span {
    color: var(--ink-muted);
  }

  select {
    padding: 0.25rem 0.45rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-sm);
  }

  .link {
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    font-size: var(--text-xs);
  }

  .link:disabled {
    color: var(--ink-faint);
  }

  .note {
    margin: var(--space-3) 0 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    line-height: 1.5;
  }
</style>
