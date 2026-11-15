<script lang="ts">
  import type { HierarchyLevel } from '$lib/board/levels.js';

  /**
   * The level bar: one button for each level of the hierarchy, top first, for
   * example "Epic › Feature › User Story".
   *
   * A click on a level reports the depth of that level. The canvas then folds
   * every node at that depth, and draws the dependencies between the folded
   * items on the nodes that hold them. The deepest level reports null, which
   * folds nothing. A level that the view draws as badges is disabled, because
   * its nodes are not on the canvas to fold.
   */
  interface Props {
    levels: HierarchyLevel[];
    /** The level the canvas shows, or null for the deepest level. */
    current: number | null;
    onselect: (level: number | null) => void;
  }

  let { levels, current, onselect }: Props = $props();

  const deepest = $derived(levels.length - 1);
  const shown = $derived(current ?? deepest);

  function title(level: HierarchyLevel): string {
    if (level.badged) return `This view draws ${level.label} as badges, so the level cannot fold`;
    const count = `${level.members} in this view`;
    if (level.depth === deepest) return `Show every level (${count})`;
    return `Show the canvas down to ${level.label}, with the items below folded inside (${count})`;
  }
</script>

{#if levels.length > 1}
  <div class="level-bar" role="radiogroup" aria-label="Level of detail">
    {#each levels as level (level.depth)}
      {#if level.depth > 0}<span class="separator" aria-hidden="true">›</span>{/if}
      <button
        type="button"
        role="radio"
        aria-checked={level.depth === shown}
        class:current={level.depth === shown}
        disabled={level.badged}
        title={title(level)}
        onclick={() => onselect(level.depth === deepest ? null : level.depth)}
      >
        <span class="label">{level.label}</span>
        <span class="count">{level.members}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .level-bar {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    min-width: 0;
    padding: 2px var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    box-shadow: var(--shadow-sm);
    font-size: var(--text-sm);
    white-space: nowrap;
    overflow: hidden;
  }

  .separator {
    padding: 0 2px;
    color: var(--ink-faint);
  }

  button {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    min-width: 0;
    padding: 1px var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-muted);
    font: inherit;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--ink);
  }

  button.current {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  button:disabled {
    color: var(--ink-faint);
    cursor: default;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .count {
    font-size: var(--text-xs);
    color: var(--ink-faint);
    font-weight: 400;
  }
</style>
