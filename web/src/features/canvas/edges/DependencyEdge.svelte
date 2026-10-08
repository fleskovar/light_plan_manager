<script lang="ts">
  import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/svelte';
  import type { StatusTone } from '$lib/board/selectors.js';

  /**
   * A dependency. Its colour follows the downstream issue's status, and it
   * animates while that work is in progress — so a glance at the canvas shows
   * where the flow actually is. A dashed edge stands for several dependencies
   * folded into a collapsed subflow.
   *
   * The route is orthogonal rather than curved: a plan is read by following one
   * line among dozens, and a right angle is far easier to keep your eye on than
   * a curve that shares its slope with three others. `offset` keeps the first
   * turn clear of the node it leaves, which is what stops parallel edges from
   * lying on top of each other.
   */
  interface Data extends Record<string, unknown> {
    tone: StatusTone;
    animated: boolean;
    aggregated: boolean;
    /** The blocker at the far end is flagged: drawn red, selected or not. */
    stalled?: boolean;
    /** Touches the current selection: drawn heavier. */
    related?: boolean;
    /** Something else is selected: drawn back. */
    faded?: boolean;
  }

  let {
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    markerEnd,
    selected,
    data,
  }: EdgeProps & { data?: Data } = $props();

  const path = $derived(
    getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      borderRadius: 0,
      offset: 18,
    })[0],
  );

  /**
   * Lit up because of what is selected. It takes a colour of its own rather
   * than a heavier version of the status tone: the question "what does this
   * touch?" has nothing to do with whether the work is blocked or done, and
   * answering both in red would make the graph harder to read, not easier.
   */
  const live = $derived(Boolean(selected || data?.related));

  /**
   * A stalled edge is drawn a little heavier than an ordinary one and lighter
   * than a live one. Colour alone would not carry it: `tone-blocked` is the
   * same red, so a graph with blocked work in it would hide the flagged part
   * among lines that merely have a blocked status.
   */
  const width = $derived(live ? 3 : data?.stalled ? 2.4 : 1.8);
</script>

<BaseEdge
  path={path}
  {markerEnd}
  class="edge tone-{data?.tone ?? 'todo'} {data?.stalled ? 'stalled' : ''} {live ? 'live' : ''}"
  style="
    stroke-width: {width}px;
    opacity: {data?.faded ? 0.25 : 1};
    {data?.aggregated && !live ? 'stroke-dasharray: 2 4;' : ''}
  "
/>
{#if data?.animated && !data?.faded}
  <circle class="pulse tone-{data.tone}" r="3">
    <animateMotion dur="2.2s" repeatCount="indefinite" path={path} />
  </circle>
{/if}

<style>
  :global(.edge) {
    stroke: var(--tone);
  }

  :global(.tone-todo) {
    --tone: var(--tone-todo);
  }
  :global(.tone-active) {
    --tone: var(--tone-active);
  }
  :global(.tone-blocked) {
    --tone: var(--tone-blocked);
  }
  :global(.tone-review) {
    --tone: var(--tone-review);
  }
  :global(.tone-done) {
    --tone: var(--tone-done);
  }

  /*
   * The blocker at the far end is flagged, so everything downstream of this
   * line has stopped. Red, always, whatever is selected — the reach of a flag
   * is the thing a plan owner opens the canvas to find, and it must not need a
   * click to appear.
   *
   * It overrides `--tone` rather than `stroke`, which is the same device
   * `NodeShell` uses for a flagged node — so the two say the same thing in the
   * same colour, and the selection highlight below still wins by setting
   * `stroke` outright rather than by out-specifying this rule.
   */
  :global(.edge.stalled) {
    --tone: var(--danger);
  }

  /*
   * The highlight: a contrasting colour and a dash that travels along the edge,
   * in the direction the dependency runs. Movement is what separates it from
   * the static lines behind it — a colour alone disappears in a graph of a
   * hundred edges, and this is the one thing on screen that has to be findable
   * at a glance after a click.
   */
  :global(.edge.live) {
    stroke: var(--highlight);
    stroke-dasharray: 9 5;
    animation: edge-flow 600ms linear infinite;
  }

  /* Declared global: the rule that uses it is `:global` too, and a scoped
     keyframe name would never be found from there. */
  @keyframes -global-edge-flow {
    to {
      stroke-dashoffset: -14;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.edge.live) {
      animation: none;
    }
  }

  .pulse {
    fill: var(--tone);
  }
</style>
