<script lang="ts">
  import { BINDINGS, GESTURES, shortcutLabel } from '$lib/shortcuts/bindings.js';
  import Modal from '$lib/ui/Modal.svelte';

  /**
   * The list of keyboard shortcuts that Help ▸ Keyboard shortcuts, the
   * Shortcuts button of the top bar and the key ? open. The rows come from
   * `BINDINGS` and `GESTURES`, so the list always matches what works.
   */
  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();
</script>

<Modal title="Keyboard shortcuts" size="sm" {onclose}>
  <p class="hint">A shortcut does not run while the cursor is in a text field.</p>
  <h3>Keys</h3>
  <dl>
    {#each BINDINGS as binding (binding.id)}
      <div>
        <dt><kbd>{shortcutLabel(binding)}</kbd></dt>
        <dd>{binding.description}</dd>
      </div>
    {/each}
  </dl>
  <h3>Canvas: mouse and held keys</h3>
  <dl>
    {#each GESTURES as gesture (gesture.keys)}
      <div>
        <dt><kbd>{gesture.keys}</kbd></dt>
        <dd>{gesture.description}</dd>
      </div>
    {/each}
  </dl>
</Modal>

<style>
  .hint {
    margin: 0 0 var(--space-3);
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }

  h3 {
    margin: var(--space-3) 0 var(--space-1);
    font-size: var(--text-sm);
  }

  h3:first-of-type {
    margin-top: 0;
  }

  dl {
    display: flex;
    flex-direction: column;
    margin: 0;
  }

  div {
    display: grid;
    grid-template-columns: 7.5rem 1fr;
    align-items: baseline;
    gap: var(--space-3);
    padding: 0.3rem 0;
    border-top: 1px solid var(--surface-2);
  }

  div:first-child {
    border-top: none;
  }

  dd {
    margin: 0;
    font-size: var(--text-sm);
  }

  kbd {
    padding: 0.05rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
</style>
