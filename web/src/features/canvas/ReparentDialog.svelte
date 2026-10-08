<script lang="ts">
  import type { ReparentRequest } from '$lib/app/shell.svelte.js';
  import Button from '$lib/ui/Button.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import { reparent, reparentChoices, reparentWithBridge } from '$lib/workspace/mutations.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';

  /**
   * "That does not fit here — what did you mean?"
   *
   * A drop onto a node the hierarchy will not take has two honest readings:
   * the dragged document changes into something that belongs at that level, or
   * the levels it is missing get built for it. Guessing between them is how a
   * board quietly ends up with epics that are really stories, so both are
   * offered and the reader picks. `reparentChoices` decides which are on the
   * table; nothing here re-derives a depth rule.
   */
  interface Props {
    request: ReparentRequest;
    onclose: () => void;
  }

  let { request, onclose }: Props = $props();

  const workspace = useWorkspace();

  const node = $derived(workspace.node(request.id));
  const parent = $derived(workspace.node(request.parentId));
  const choices = $derived(reparentChoices(workspace, request.id, request.parentId));

  const label = (type: string): string => workspace.config.types[type]?.label ?? type;

  const canConvert = $derived(choices.convert.allowed && choices.convert.type !== node?.type);
  const canBridge = $derived(choices.bridge.length > 0);

  let mode = $state<'convert' | 'bridge' | null>(null);
  const chosen = $derived(mode ?? (canConvert ? 'convert' : 'bridge'));

  // One field per container, so "Epic for Login form" can be renamed before it
  // exists rather than hunted down afterwards.
  let titles = $state<string[]>([]);
  const containerTitles = $derived(
    choices.bridge.map(
      (type, index) => titles[index] ?? `${label(type)} for ${node?.title ?? request.id}`,
    ),
  );

  function setTitle(index: number, value: string): void {
    const next = [...containerTitles];
    next[index] = value;
    titles = next;
  }

  const bridgeSummary = $derived(
    choices.bridge.map((type) => label(type)).join(' › '),
  );

  function apply(): void {
    if (chosen === 'convert') reparent(workspace, request.id, request.parentId);
    else reparentWithBridge(workspace, request.id, request.parentId, containerTitles);
    onclose();
  }
</script>

<Modal title="Invalid move" onclose={onclose}>
  {#if node && parent}
    <p class="lead">
      A {label(node.type)} can't be a child of a {label(parent.type)}.
    </p>

    <div class="options" role="radiogroup" aria-label="How to fix the move">
      {#if canConvert}
        <label class="option" class:picked={chosen === 'convert'}>
          <input
            type="radio"
            name="reparent"
            checked={chosen === 'convert'}
            onchange={() => (mode = 'convert')}
          />
          <span>
            <strong>Change its type</strong>
            <span class="detail">
              {node.id} becomes a {label(choices.convert.type)} under {parent.id}.
            </span>
          </span>
        </label>
      {/if}

      {#if canBridge}
        <label class="option" class:picked={chosen === 'bridge'}>
          <input
            type="radio"
            name="reparent"
            checked={chosen === 'bridge'}
            onchange={() => (mode = 'bridge')}
          />
          <span>
            <strong>
              Add {choices.bridge.length === 1 ? 'a container' : 'containers'} between them
            </strong>
            <span class="detail">
              {parent.id} › {bridgeSummary} › {node.id}. {node.id} stays a {label(node.type)}.
            </span>
          </span>
        </label>

        {#if chosen === 'bridge'}
          <div class="titles">
            {#each choices.bridge as type, index (index)}
              <label class="title">
                <span>{label(type)}</span>
                <input
                  value={containerTitles[index]}
                  onchange={(event) => setTitle(index, event.currentTarget.value)}
                />
              </label>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <Button onclick={onclose}>Cancel</Button>
    <Button variant="primary" onclick={apply} disabled={!canConvert && !canBridge}>Move</Button>
  {/snippet}
</Modal>

<style>
  .lead {
    margin: 0 0 var(--space-3);
    line-height: 1.55;
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .option {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    cursor: pointer;
  }

  .option.picked {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .option strong {
    display: block;
    font-size: var(--text-sm);
  }

  .detail {
    display: block;
    margin-top: 0.1rem;
    color: var(--ink-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .titles {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0 var(--space-2) var(--space-1) 1.6rem;
  }

  .title {
    display: grid;
    grid-template-columns: 6rem 1fr;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .title input {
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    font-size: var(--text-sm);
    color: var(--ink);
  }
</style>
