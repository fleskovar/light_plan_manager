<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import { breakDown } from '$lib/workspace/mutations.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';

  /**
   * Splitting one issue into several. The two modes answer the same question
   * differently: keep the original as a container, or let the pieces take its
   * place. Either way the upstream and downstream edges follow, which is the
   * part that is tedious to do by hand.
   */
  interface Props {
    id: string;
    onclose: () => void;
  }

  let { id, onclose }: Props = $props();

  const workspace = useWorkspace();
  const issue = $derived(workspace.node(id));
  const effortAttribute = $derived(workspace.config.effortAttribute);
  const effort = $derived(
    effortAttribute && typeof issue?.attributes[effortAttribute] === 'number'
      ? (issue.attributes[effortAttribute] as number)
      : null,
  );

  let count = $state(3);
  let mode = $state<'children' | 'replace'>('children');
  let chain = $state(true);
  let splitEffort = $state(true);
  let titles = $state('');

  const pieces = $derived(
    titles
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );

  function apply(): void {
    breakDown(workspace, id, {
      count: Math.max(1, Math.min(count, 20)),
      mode,
      chain,
      titles: pieces,
      ...(splitEffort && effortAttribute ? { splitAttribute: effortAttribute } : {}),
    });
    onclose();
  }
</script>

<Modal title="Break down {id}" {onclose}>
  {#if !issue}
    <p>This issue no longer exists.</p>
  {:else}
    <p class="lead">{issue.title}</p>

    <div class="field">
      <span>Into</span>
      <input type="number" min="1" max="20" bind:value={count} />
      <span class="unit">pieces</span>
    </div>

    <fieldset>
      <legend>How</legend>
      <label>
        <input type="radio" value="children" bind:group={mode} />
        <span>
          <strong>As children</strong>
          <em>Keep {id} and nest the pieces inside it.</em>
        </span>
      </label>
      <label>
        <input type="radio" value="replace" bind:group={mode} />
        <span>
          <strong>Replace it</strong>
          <em>
            Delete {id} and put the pieces in its place.
          </em>
        </span>
      </label>
    </fieldset>

    <label class="check">
      <input type="checkbox" bind:checked={chain} />
      Chain the pieces in order
    </label>

    {#if effort !== null}
      <label class="check">
        <input type="checkbox" bind:checked={splitEffort} />
        Split {effortAttribute} ({effort}) evenly (~{Math.max(1, Math.round(effort / count))} each)
      </label>
    {/if}

    <label class="titles">
      <span>Titles (one per line, optional)</span>
      <textarea rows="4" bind:value={titles} placeholder="Leave empty to number them"></textarea>
    </label>
  {/if}

  {#snippet footer()}
    <Button onclick={onclose}>Cancel</Button>
    <Button variant="primary" onclick={apply} disabled={!issue}>Break down</Button>
  {/snippet}
</Modal>

<style>
  .lead {
    margin: 0 0 var(--space-3);
    font-weight: 600;
  }

  .field {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
    font-size: var(--text-sm);
  }

  .field input {
    width: 4.5rem;
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
  }

  .unit {
    color: var(--ink-muted);
  }

  fieldset {
    margin: 0 0 var(--space-3);
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  legend {
    padding: 0 var(--space-1);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  fieldset label {
    display: flex;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    font-size: var(--text-sm);
  }

  fieldset em {
    display: block;
    color: var(--ink-muted);
    font-size: var(--text-xs);
    font-style: normal;
    line-height: 1.5;
  }

  .check {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
    font-size: var(--text-sm);
  }

  .titles {
    display: block;
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .titles textarea {
    width: 100%;
    margin-top: var(--space-1);
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font: inherit;
    font-size: var(--text-sm);
    color: var(--ink);
    resize: vertical;
  }
</style>
