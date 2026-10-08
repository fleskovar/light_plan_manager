<script lang="ts" generics="T extends string">
  interface Tab<Id extends string> {
    id: Id;
    label: string;
    disabled?: boolean;
  }

  interface Props {
    tabs: Tab<T>[];
    active: T;
    onselect: (id: T) => void;
  }

  let { tabs, active, onselect }: Props = $props();
</script>

<div class="tabs" role="tablist">
  {#each tabs as tab (tab.id)}
    <button
      class="tab"
      class:active={tab.id === active}
      type="button"
      role="tab"
      aria-selected={tab.id === active}
      disabled={tab.disabled}
      onclick={() => onselect(tab.id)}
    >
      {tab.label}
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    gap: var(--space-1);
  }

  .tab {
    padding: 0.25rem 0.7rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-muted);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .tab:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--ink);
  }

  .tab.active {
    background: var(--surface-3);
    border-color: var(--border);
    color: var(--ink);
  }

  .tab:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
