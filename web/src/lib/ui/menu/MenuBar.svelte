<script lang="ts">
  import ContextMenu from './ContextMenu.svelte';
  import type { MenuAnchor, MenuEntry } from './types.js';

  /**
   * A menu bar: a row of menu names, as a desktop app has under its title.
   *
   * A click on a name opens its menu under the name. While a menu is open, the
   * pointer moving onto another name opens that menu, so the reader can sweep
   * along the bar. The menus use the same machinery as the right-click menus
   * of the canvas, so submenus, ticks and edge-flipping work the same way.
   */
  interface Menu {
    label: string;
    entries: MenuEntry[];
    /** Called each time the menu opens, for a menu that lists data to read again. */
    onopen?: () => void;
  }

  interface Props {
    menus: Menu[];
  }

  let { menus }: Props = $props();

  let open = $state<{ index: number; anchor: MenuAnchor } | null>(null);
  const entries = $derived(open ? (menus[open.index]?.entries ?? []) : []);

  function show(index: number, name: HTMLElement): void {
    const box = name.getBoundingClientRect();
    open = { index, anchor: { x: box.left, y: box.bottom + 2 } };
    menus[index]?.onopen?.();
  }
</script>

<div class="menubar" role="menubar" aria-label="Menu bar">
  {#each menus as menu, index (menu.label)}
    <!-- The open menu closes on any pointerdown outside it, the names included.
         The pointerdown is held back here, so a click on the name of the open
         menu closes it and does not open it again. -->
    <button
      class="name"
      class:open={open?.index === index}
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={open?.index === index}
      onpointerdown={(event) => {
        if (open) event.stopPropagation();
      }}
      onclick={(event) => {
        if (open?.index === index) open = null;
        else show(index, event.currentTarget);
      }}
      onmouseenter={(event) => {
        if (open && open.index !== index) show(index, event.currentTarget);
      }}
    >
      {menu.label}
    </button>
  {/each}
</div>

{#if open}
  <!-- Keyed, so the position that one menu corrected does not move the next. -->
  {#key open.index}
    <ContextMenu anchor={open.anchor} {entries} onclose={() => (open = null)} />
  {/key}
{/if}

<style>
  .menubar {
    display: flex;
    align-items: center;
  }

  .name {
    padding: 0.2rem 0.55rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink);
    font-size: var(--text-sm);
  }

  .name:hover,
  .name.open {
    background: var(--surface-3);
  }
</style>
