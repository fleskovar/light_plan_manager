<script lang="ts">
  /**
   * A draggable divider. It reports the size it would like the pane below (or
   * beside) it to be and lets the parent own that number, so the size can be
   * persisted in the view without this component knowing what a view is.
   */
  interface Props {
    orientation?: 'horizontal' | 'vertical';
    size: number;
    min?: number;
    max?: number;
    onresize: (size: number) => void;
    label?: string;
  }

  let {
    orientation = 'horizontal',
    size,
    min = 120,
    max = Infinity,
    onresize,
    label = 'Resize',
  }: Props = $props();

  let dragging = $state(false);

  const clamp = (value: number): number => Math.min(Math.max(value, min), max);

  function start(event: PointerEvent): void {
    dragging = true;
    const origin = orientation === 'horizontal' ? event.clientY : event.clientX;
    const initial = size;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);

    const move = (moved: PointerEvent): void => {
      const delta =
        orientation === 'horizontal' ? origin - moved.clientY : origin - moved.clientX;
      onresize(clamp(initial + delta));
    };
    const stop = (): void => {
      dragging = false;
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
  }

  function onkeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 12;
    const grow = orientation === 'horizontal' ? 'ArrowUp' : 'ArrowLeft';
    const shrink = orientation === 'horizontal' ? 'ArrowDown' : 'ArrowRight';
    if (event.key === grow) onresize(clamp(size + step));
    else if (event.key === shrink) onresize(clamp(size - step));
    else return;
    event.preventDefault();
  }
</script>

<!--
  A focusable `separator` is the ARIA pattern for a window splitter, and the
  arrow keys are what make it usable without a pointer. Svelte's a11y rules
  model separators as always non-interactive, so they are silenced here rather
  than the markup being made less correct.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="splitter {orientation}"
  class:dragging
  role="separator"
  aria-label={label}
  aria-orientation={orientation}
  aria-valuenow={Math.round(size)}
  tabindex="0"
  onpointerdown={start}
  {onkeydown}
></div>

<style>
  .splitter {
    flex: none;
    padding: 0;
    border: none;
    background: var(--border);
    transition: background var(--duration-fast);
  }

  .splitter:hover,
  .dragging {
    background: var(--accent);
  }

  .horizontal {
    height: 3px;
    cursor: row-resize;
  }

  .vertical {
    width: 3px;
    cursor: col-resize;
  }
</style>
