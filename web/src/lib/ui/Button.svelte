<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  interface Props extends HTMLButtonAttributes {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md';
    children: Snippet;
  }

  let { variant = 'secondary', size = 'md', children, ...rest }: Props = $props();
</script>

<button class="button {variant} {size}" type="button" {...rest}>
  {@render children()}
</button>

<style>
  .button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--ink);
    white-space: nowrap;
    transition:
      background var(--duration-fast),
      border-color var(--duration-fast);
  }

  .md {
    padding: 0.4rem 0.75rem;
    font-size: var(--text-md);
  }

  .sm {
    padding: 0.2rem 0.5rem;
    font-size: var(--text-sm);
  }

  .button:hover:not(:disabled) {
    background: var(--surface-2);
    border-color: var(--border-strong);
  }

  .primary {
    background: var(--accent);
    border-color: transparent;
    color: var(--accent-ink);
    font-weight: 600;
  }

  .primary:hover:not(:disabled) {
    background: var(--accent);
    filter: brightness(1.08);
  }

  .ghost {
    background: transparent;
    border-color: transparent;
  }

  .danger {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  }

  .button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
