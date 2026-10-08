<script lang="ts">
  import type { Confirmation } from '$lib/app/shell.svelte.js';
  import Button from './Button.svelte';
  import Modal from './Modal.svelte';

  interface Props {
    confirmation: Confirmation;
    onresolve: (accepted: boolean, choice: boolean) => void;
  }

  let { confirmation, onresolve }: Props = $props();

  // Seeded once: the dialog is remounted for each confirmation.
  // svelte-ignore state_referenced_locally
  let choice = $state(confirmation.choice?.checked ?? false);
</script>

<Modal title={confirmation.title} size="sm" onclose={() => onresolve(false, choice)}>
  <p>{confirmation.message}</p>
  {#if confirmation.details?.length}
    <ul>
      {#each confirmation.details as detail (detail)}
        <li>{detail}</li>
      {/each}
    </ul>
  {/if}
  {#if confirmation.choice}
    <label class="choice">
      <input type="checkbox" bind:checked={choice} />
      <span>{confirmation.choice.label}</span>
    </label>
  {/if}

  {#snippet footer()}
    <Button onclick={() => onresolve(false, choice)}>Cancel</Button>
    <Button
      variant={confirmation.danger ? 'danger' : 'primary'}
      onclick={() => onresolve(true, choice)}
    >
      {confirmation.confirmLabel ?? 'Confirm'}
    </Button>
  {/snippet}
</Modal>

<style>
  p {
    margin: 0;
    line-height: 1.55;
  }

  .choice {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin-top: var(--space-3);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .choice input {
    margin-top: 0.2rem;
  }

  ul {
    margin: var(--space-3) 0 0;
    padding-left: 1.1rem;
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }
</style>
