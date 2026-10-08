<script lang="ts">
  import MenuList from './MenuList.svelte';
  import type { MenuAnchor, MenuEntry } from './types.js';

  interface Props {
    anchor: MenuAnchor;
    entries: MenuEntry[];
    onclose: () => void;
  }

  let { anchor, entries, onclose }: Props = $props();

  let element = $state<HTMLDivElement | null>(null);
  let corrected = $state<MenuAnchor | null>(null);
  const position = $derived(corrected ?? anchor);

  // Nudge the menu back inside the viewport once its real size is known.
  $effect(() => {
    if (!element) return;
    const box = element.getBoundingClientRect();
    corrected = {
      x: Math.min(anchor.x, window.innerWidth - box.width - 8),
      y: Math.min(anchor.y, window.innerHeight - box.height - 8),
    };
  });
</script>

<svelte:window
  onpointerdown={(event) => {
    if (element && !element.contains(event.target as Node)) onclose();
  }}
  onkeydown={(event) => event.key === 'Escape' && onclose()}
/>

<div
  bind:this={element}
  class="anchor"
  style="left: {position.x}px; top: {position.y}px"
  oncontextmenu={(event) => event.preventDefault()}
  role="presentation"
>
  <MenuList {entries} onselect={onclose} />
</div>

<style>
  .anchor {
    position: fixed;
    z-index: 70;
  }
</style>
