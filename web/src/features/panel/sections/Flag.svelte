<script lang="ts">
  import type { IssueDto } from '$shared';
  import { FLAG_REASONS, flagLabel, isTempId } from '$shared';
  import Button from '$lib/ui/Button.svelte';

  /**
   * Raising and clearing the flag on an issue.
   *
   * Presentational, like every component here: it collects a reason and a note
   * and hands them out. What it will not do is submit without the note — the
   * engine refuses that anyway, but a form that lets you press the button and
   * then tells you off is a worse way to learn the rule than one that does not
   * offer the button.
   */
  interface Props {
    issue: IssueDto;
    onflag: (reason: string | null, comment: string) => void;
  }

  let { issue, onflag }: Props = $props();

  let open = $state(false);
  let reason = $state<string>('blocked');
  let note = $state('');

  // Per issue: clicking to another one closes the form rather than carrying a
  // half-written note across.
  $effect(() => {
    void issue.id;
    open = false;
    note = '';
    reason = 'blocked';
  });

  const unsaved = $derived(isTempId(issue.id));

  function submit(clearing: boolean): void {
    const comment = note.trim();
    if (!comment) return;
    onflag(clearing ? null : reason, comment);
    open = false;
    note = '';
  }
</script>

<h4>Flag</h4>

{#if issue.flag}
  <p class="state">
    <span class="badge">{flagLabel(issue.flag)}</span>
  </p>
{/if}

{#if unsaved}
  <p class="hint">Push this issue before flagging it.</p>
{:else if open}
  <div class="form">
    {#if !issue.flag}
      <label>
        <span>Reason</span>
        <select bind:value={reason}>
          {#each FLAG_REASONS as option (option)}
            <option value={option}>{flagLabel(option)}</option>
          {/each}
        </select>
      </label>
    {/if}
    <textarea
      bind:value={note}
      rows="3"
      placeholder={issue.flag
        ? 'What changed so work can resume?'
        : 'What stopped, and what would fix it?'}
    ></textarea>
    <div class="actions">
      <Button size="sm" onclick={() => (open = false)}>Cancel</Button>
      <Button
        size="sm"
        variant={issue.flag ? 'primary' : 'danger'}
        disabled={!note.trim()}
        onclick={() => submit(Boolean(issue.flag))}
      >
        {issue.flag ? 'Clear flag' : 'Flag'}
      </Button>
    </div>
  </div>
{:else}
  <div class="actions">
    <Button size="sm" variant={issue.flag ? 'primary' : undefined} onclick={() => (open = true)}>
      {issue.flag ? 'Clear flag…' : 'Flag…'}
    </Button>
  </div>
  {#if !issue.flag}
    <p class="hint">
      Mark work as stopped without changing its status.
    </p>
  {/if}
{/if}

<style>
  h4 {
    margin: var(--space-4) 0 var(--space-1);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }

  .state {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0 0 var(--space-2);
    padding: var(--space-2);
    border: 1px solid var(--danger);
    border-left-width: 3px;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--danger) 10%, var(--surface-0));
    font-size: var(--text-sm);
  }

  .badge {
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--danger);
    color: var(--danger-ink);
    font-size: var(--text-xs);
    font-weight: 700;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  label {
    display: grid;
    grid-template-columns: 5.5rem 1fr;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  label > span {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  select,
  textarea {
    width: 100%;
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font: inherit;
    font-size: var(--text-sm);
    color: var(--ink);
  }

  textarea {
    resize: vertical;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .hint {
    margin: var(--space-1) 0 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }
</style>
