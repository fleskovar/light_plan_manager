<script lang="ts">
  import { configNameFrom } from '$shared';
  import Button from '$lib/ui/Button.svelte';
  import { nameProblem } from './model.js';

  /**
   * The two fields that a type and a status have in common: the label that
   * people read, and the name that `.lpm/config.yml` and the documents store.
   *
   * While the name matches the label, the name follows the label: a reader who
   * changes `Epic` to `Milestone` gets the name `milestone`. A reader who types
   * a name stops that.
   */
  interface Props {
    label?: string;
    name?: string;
    /** The names that the new name must differ from. The own name is not in the list. */
    taken: string[];
    /** `type name` or `status id`, for the field label and the messages. */
    what: string;
    submitLabel: string;
    busy: boolean;
    /** A sentence that says what a submit with this name does, or null. */
    impact?: (name: string) => string | null;
    onsubmit: (label: string, name: string) => void;
    oncancel: () => void;
  }

  let {
    label: initialLabel = '',
    name: initialName = '',
    taken,
    what,
    submitLabel,
    busy,
    impact,
    onsubmit,
    oncancel,
  }: Props = $props();

  // The form is mounted for one type or one status, so each of these reads its prop once.
  // svelte-ignore state_referenced_locally
  let label = $state(initialLabel);
  // svelte-ignore state_referenced_locally
  let name = $state(initialName);
  // svelte-ignore state_referenced_locally
  let follows = $state(initialName === '' || initialName === configNameFrom(initialLabel));
  let input = $state<HTMLInputElement | null>(null);

  const problem = $derived(name === initialName ? null : nameProblem(name, taken, what));
  const unchanged = $derived(label.trim() === initialLabel && name === initialName);
  const consequence = $derived(problem === null && name !== '' ? (impact?.(name) ?? null) : null);

  $effect(() => {
    input?.focus();
    input?.select();
  });

  function onlabel(): void {
    if (follows) name = configNameFrom(label);
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (busy || unchanged || problem !== null || !label.trim() || !name) return;
    onsubmit(label.trim(), name);
  }
</script>

<form onsubmit={submit}>
  <label>
    <span>Label</span>
    <input bind:this={input} bind:value={label} oninput={onlabel} />
  </label>
  <label>
    <span>{what}</span>
    <input class="mono" bind:value={name} oninput={() => (follows = false)} spellcheck="false" />
  </label>
  <span class="actions">
    <Button
      size="sm"
      variant="primary"
      type="submit"
      disabled={busy || unchanged || problem !== null || !label.trim() || !name}
    >
      {submitLabel}
    </Button>
    <Button size="sm" onclick={oncancel}>Cancel</Button>
  </span>
  {#if problem}
    <p class="problem">{problem}</p>
  {:else if consequence}
    <p class="consequence">{consequence}</p>
  {/if}
</form>

<style>
  form {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--accent);
    border-radius: var(--radius-md);
    background: var(--accent-soft);
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 9rem;
    flex: 1;
  }

  label span {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  input {
    padding: 0.25rem 0.45rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-sm);
  }

  .mono {
    font-family: var(--font-mono);
  }

  .actions {
    display: inline-flex;
    gap: var(--space-2);
  }

  p {
    flex-basis: 100%;
    margin: 0;
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .problem {
    color: var(--danger);
  }

  .consequence {
    color: var(--ink-muted);
  }
</style>
