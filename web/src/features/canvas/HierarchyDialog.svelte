<script lang="ts">
  import type { TypeDisplay } from '$shared';
  import Button from '$lib/ui/Button.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';

  /**
   * How deep the canvas draws.
   *
   * A board four levels deep drawn as boxes inside boxes is a picture of the
   * hierarchy, not of the work: the dependencies that matter run between the
   * stories at the bottom, and every level above them is a frame around the
   * part you are reading. Turning a level into a badge takes its boxes off the
   * canvas and writes their ids onto the issues underneath, which leaves the
   * graph and keeps the labelling.
   *
   * One choice per *level*, not per type: a story and a bug sit at the same
   * depth, and a level half drawn and half badged is a picture nobody asked for.
   */
  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  const workspace = useWorkspace();

  const levels = $derived(
    workspace.config.hierarchy.issue.map((types, depth) => ({
      depth,
      types,
      labels: types.map((name) => workspace.config.types[name]?.label ?? name),
      // Mixed settings can only come from a hand-edited file; treat anything
      // short of "all badged" as nodes, and the next click normalises it.
      mode: (types.every((name) => workspace.display[name] === 'badge')
        ? 'badge'
        : 'node') satisfies TypeDisplay as TypeDisplay,
    })),
  );

  /** The deepest level is what everything else is a frame around. */
  const deepest = $derived(levels.length - 1);

  const badged = $derived(levels.filter((level) => level.mode === 'badge').length);
</script>

<Modal title="Hierarchy display" size="md" {onclose}>
  <p class="lede">
    Draw each level as nodes, or as badges on its children.
  </p>

  <ul class="levels">
    {#each levels as level (level.depth)}
      <li>
        <span class="what">
          <span class="icon"><TypeIcon type={level.types[0]!} depth={level.depth} /></span>
          <span class="name">{level.labels.join(' / ')}</span>
        </span>

        <span class="choice" role="group" aria-label="How {level.labels.join(' / ')} is drawn">
          <button
            type="button"
            class:active={level.mode === 'node'}
            title="Draw as nodes"
            onclick={() => workspace.setDisplay(level.types, 'node')}
          >
            Nodes
          </button>
          <button
            type="button"
            class:active={level.mode === 'badge'}
            disabled={level.depth === deepest}
            title={level.depth === deepest
              ? 'Not available for the lowest level'
              : 'Show as badges on children'}
            onclick={() => workspace.setDisplay(level.types, 'badge')}
          >
            Badges
          </button>
        </span>
      </li>
    {/each}
  </ul>

  <p class="note">
    {#if badged}Issues with no children stay as nodes.{/if}
  </p>

  {#snippet footer()}
    <Button size="sm" onclick={() => workspace.setDisplay(Object.keys(workspace.display), 'node')}>
      Reset
    </Button>
    <Button size="sm" variant="primary" onclick={onclose}>Done</Button>
  {/snippet}
</Modal>

<style>
  .lede {
    margin: 0 0 var(--space-3);
    color: var(--ink-muted);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .levels {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
  }

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-top: 1px solid var(--border);
  }

  li:first-child {
    border-top: none;
  }

  .what {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .icon {
    display: inline-flex;
    color: var(--ink-muted);
  }

  .name {
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .choice {
    display: inline-flex;
    flex: none;
  }

  .choice button {
    border: 1px solid var(--border);
    background: var(--surface-1);
    padding: 0.15rem 0.6rem;
    font-size: var(--text-xs);
  }

  .choice button:first-child {
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
  }

  .choice button:last-child {
    border-left: none;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }

  .choice button.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }

  .choice button:disabled {
    color: var(--ink-faint);
    background: var(--surface-2);
  }

  .note {
    margin: var(--space-3) 0 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    line-height: 1.5;
  }
</style>
