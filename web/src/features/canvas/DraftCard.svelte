<script lang="ts">
  import { ViewportPortal } from '@xyflow/svelte';
  import { NODE_HEIGHT, NODE_WIDTH } from './model.js';
  import TitleField from './nodes/TitleField.svelte';

  /**
   * The card of a new item that has no title yet, drawn where the item will
   * go. The board receives nothing until the title is submitted, so a card
   * that is cancelled leaves no change in the queue.
   *
   * The card is drawn in the viewport layer of SvelteFlow, so `position` is
   * in canvas coordinates and the card moves with a pan or a zoom.
   */
  interface Props {
    position: { x: number; y: number };
    typeLabel: string;
    /** `next` is true when Enter submitted the title. */
    onsubmit: (text: string, next: boolean) => void;
    oncancel: () => void;
  }

  let { position, typeLabel, onsubmit, oncancel }: Props = $props();
</script>

<ViewportPortal target="front">
  <div
    class="draft nodrag nopan nowheel"
    style="transform: translate({position.x}px, {position.y}px); width: {NODE_WIDTH}px; min-height: {NODE_HEIGHT}px;"
  >
    <span class="type">New {typeLabel}</span>
    <TitleField
      value=""
      placeholder="Title"
      label="Title of the new {typeLabel}"
      {onsubmit}
      {oncancel}
    />
    <span class="hint">Enter adds the next one · Esc cancels</span>
  </div>
</ViewportPortal>

<style>
  .draft {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: var(--space-2);
    border: 1px dashed var(--accent);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    box-shadow: var(--shadow-sm);
    pointer-events: all;
  }

  .type {
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .hint {
    margin-top: auto;
    font-size: var(--text-xs);
    color: var(--ink-faint);
  }
</style>
