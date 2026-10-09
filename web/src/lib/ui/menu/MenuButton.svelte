<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from '../Button.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import type { MenuAnchor, MenuEntry } from './types.js';

  /**
   * A button that drops a menu down from under itself — a toolbar dropdown,
   * built from the same menu machinery as the canvas's right-click menus, so
   * submenus, ticks and edge-flipping come for free.
   */
  interface Props {
    entries: MenuEntry[];
    title?: string;
    children: Snippet;
  }

  let { entries, title, children }: Props = $props();

  let anchor = $state<MenuAnchor | null>(null);

  function toggle(event: MouseEvent): void {
    if (anchor) {
      anchor = null;
      return;
    }
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    anchor = { x: box.left, y: box.bottom + 4 };
  }
</script>

<!-- The menu closes on any pointerdown outside it, this button included; held
     back here, so a second click closes the menu rather than reopening it. -->
<Button
  size="sm"
  {title}
  aria-haspopup="menu"
  aria-expanded={anchor !== null}
  onpointerdown={(event: PointerEvent) => {
    if (anchor) event.stopPropagation();
  }}
  onclick={toggle}
>
  {@render children()}
</Button>

{#if anchor}
  <ContextMenu {anchor} {entries} onclose={() => (anchor = null)} />
{/if}
