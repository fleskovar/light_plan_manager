<script lang="ts">
  import type { CanvasMode, CanvasModeName } from '$lib/workspace/canvas-mode.svelte.js';

  /**
   * The switch between read mode and edit mode, at the right end of the top
   * bar. It writes `mode` of the `CanvasMode` that it receives. The key E
   * runs the same switch.
   */
  interface Props {
    mode: CanvasMode;
  }

  let { mode }: Props = $props();

  const options: { value: CanvasModeName; label: string; title: string }[] = [
    { value: 'read', label: 'Read', title: 'Read mode: the whole view (E)' },
    {
      value: 'edit',
      label: 'Edit',
      title: 'Edit mode: work inside one item and add items quickly (E)',
    },
  ];
</script>

<div class="switch" role="radiogroup" aria-label="Canvas mode">
  {#each options as option (option.value)}
    <button
      type="button"
      role="radio"
      aria-checked={mode.mode === option.value}
      class:on={mode.mode === option.value}
      title={option.title}
      onclick={() => mode.setMode(option.value)}
    >
      {option.label}
    </button>
  {/each}
</div>

<style>
  .switch {
    display: inline-flex;
    flex: none;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2);
  }

  button {
    padding: 1px var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-muted);
    font-size: var(--text-xs);
    font-weight: 600;
    cursor: pointer;
  }

  button:hover {
    color: var(--ink);
  }

  button.on {
    background: var(--surface-0);
    color: var(--ink);
    box-shadow: var(--shadow-sm);
  }

  button.on:last-child {
    background: var(--accent);
    color: var(--accent-ink);
  }
</style>
