<script lang="ts">
  import type { ViewMode } from '$shared';
  import { api } from '$lib/api/client.js';
  import type { ViewDialogKind, ViewDialogRequest } from '$lib/app/shell.svelte.js';
  import { useTabs } from '$lib/app/tabs.svelte.js';
  import Button from '$lib/ui/Button.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import { usePool } from '$lib/workspace/pool.svelte.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import { currentDetails, saveDetails, type ViewDetailsHost } from './view-details.js';

  /**
   * The dialog that asks for the name and the description of a view.
   *
   * `new` creates a view and shows it in a new tab. `save-as` copies the open
   * view to a new view file and shows the copy in the same tab. `edit` changes
   * the name and the description of the view of any open tab and keeps its id.
   */
  interface Props {
    request: ViewDialogRequest;
    onclose: () => void;
  }

  let { request, onclose }: Props = $props();

  const tabs = useTabs();
  const pool = usePool();
  const workspace = useWorkspace();

  const host: ViewDetailsHost = {
    tabs,
    workspaceOf: (id) => pool.get(id),
    loadView: api.loadView,
    saveView: api.saveView,
  };

  const TITLES: Record<ViewDialogKind, string> = {
    new: 'New view',
    'save-as': 'Save view as',
    edit: 'Edit view',
  };
  const ACTIONS: Record<ViewDialogKind, string> = {
    new: 'Create',
    'save-as': 'Save',
    edit: 'Save',
  };

  // The dialog is mounted for one request, so each of these reads its prop once.
  // svelte-ignore state_referenced_locally
  const kind = request.kind;
  // svelte-ignore state_referenced_locally
  const target = request.kind === 'edit' ? request.id : null;
  const current = kind === 'save-as' ? workspace.doc : null;
  const initial =
    target !== null
      ? currentDetails(host, target)
      : { name: current ? `${current.name} copy` : '', description: current?.description ?? '' };

  let name = $state(initial.name);
  let description = $state(initial.description);
  let mode = $state<ViewMode>('board');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let input = $state<HTMLInputElement | null>(null);

  const trimmed = $derived(name.trim());
  const taken = $derived(trimmed !== '' && tabs.nameTaken(trimmed, target));
  const unchanged = $derived(
    kind === 'edit' && trimmed === initial.name && description.trim() === initial.description.trim(),
  );
  const problem = $derived(taken ? `A view called "${trimmed}" already exists.` : error);

  $effect(() => {
    input?.focus();
    input?.select();
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!trimmed || taken || unchanged || busy) return;
    busy = true;
    error = null;
    try {
      if (kind === 'new') {
        await tabs.create(trimmed, mode, description.trim());
      } else if (target !== null) {
        // A refusal of a workspace is already in its notices.
        if (!(await saveDetails(host, target, { name: trimmed, description }))) return;
      } else {
        const id = await workspace.saveCopy(trimmed, description.trim());
        if (id === null) return;
        await tabs.refresh();
        tabs.replace(current!.id, id);
      }
      onclose();
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    } finally {
      busy = false;
    }
  }
</script>

<Modal title={TITLES[kind]} size="sm" {onclose}>
  <form id="view-dialog" onsubmit={submit}>
    <label class="name">
      <span>Name</span>
      <input
        bind:this={input}
        bind:value={name}
        placeholder={mode === 'templates'
          ? 'Delivery patterns, Release checklists…'
          : 'Roadmap, Sprint 12, Payments…'}
      />
    </label>

    <label class="name">
      <span>Description</span>
      <textarea
        bind:value={description}
        rows="3"
        placeholder="What this view shows, and for whom. The tab tooltip and the All projects page show this text."
      ></textarea>
    </label>

    {#if kind === 'new'}
      <fieldset class="modes">
        <legend>The view shows</legend>
        <label>
          <input type="radio" bind:group={mode} value="board" />
          The board
        </label>
        <label>
          <input type="radio" bind:group={mode} value="templates" />
          The template registry
        </label>
      </fieldset>
    {:else if kind === 'save-as'}
      <p class="hint">
        The copy holds the issues and the layout of this view. Unpushed changes stay with this view.
      </p>
    {:else}
      <p class="hint">The file name of the view stays the same.</p>
    {/if}

    {#if problem}
      <p class="problem">{problem}</p>
    {/if}
  </form>

  {#snippet footer()}
    <Button onclick={onclose}>Cancel</Button>
    <Button
      variant="primary"
      type="submit"
      form="view-dialog"
      disabled={!trimmed || taken || unchanged || busy}
    >
      {ACTIONS[kind]}
    </Button>
  {/snippet}
</Modal>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .name {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .name span,
  legend {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .name input,
  .name textarea {
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    font-size: var(--text-md);
    font-family: inherit;
  }

  .name textarea {
    resize: vertical;
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .modes {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    margin: 0;
    padding: 0;
    border: none;
    font-size: var(--text-sm);
  }

  legend {
    padding: 0;
    margin-bottom: var(--space-1);
  }

  .modes label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .hint {
    margin: 0;
    color: var(--ink-muted);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .problem {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-sm);
  }
</style>
