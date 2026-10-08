<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import Modal from '$lib/ui/Modal.svelte';

  /**
   * A sprint ended and the work in it did not.
   *
   * There are exactly two honest answers, and the dialog offers both rather
   * than picking one: either the team decided that what is open is not being
   * done — so it is closed — or the work is still wanted, and it moves one
   * sprint along. Nothing here invents a timebox: the increment is as long as
   * it was, which is why carrying over makes the last sprint's backlog grow,
   * and why the dialog says so instead of hiding it.
   *
   * Presentational: it renders what it is handed and calls back.
   */
  interface Props {
    /** What ran late, for the heading. */
    title: string;
    ends: string;
    /** How many issues are still open in it. */
    open: number;
    /** The period the work would move to; null when this is the last one. */
    nextTitle: string | null;
    /** The status "mark it all done" would write, for the label. */
    doneLabel: string;
    oncomplete: () => void;
    oncarry: () => void;
    onclose: () => void;
  }

  let { title, ends, open, nextTitle, doneLabel, oncomplete, oncarry, onclose }: Props = $props();
</script>

<Modal title="{title} ended with open work" size="sm" {onclose}>
  <p>
    <strong>{title}</strong> ended on {ends} with
    {open} open issue{open === 1 ? '' : 's'}.
  </p>

  <div class="choices">
    <section>
      <h3>Close it out</h3>
      <p>
        Use when the remaining work is dropped.
      </p>
      <Button variant="primary" onclick={oncomplete}>
        Mark {open} issue{open === 1 ? '' : 's'} {doneLabel}
      </Button>
    </section>

    <section>
      <h3>Carry over</h3>
      {#if nextTitle}
        <p>
          Finished work stays in {title}.
        </p>
        <Button variant="primary" onclick={oncarry}>Move them to {nextTitle}</Button>
      {:else}
        <p class="none">
          No period after {title}. Add one, or close this one out.
        </p>
      {/if}
    </section>
  </div>

  {#snippet footer()}
    <Button onclick={onclose}>Cancel</Button>
  {/snippet}
</Modal>

<style>
  p {
    margin: 0;
    line-height: 1.55;
  }

  /* Two answers side by side down the dialog, each with its own button, so
     neither reads as the default one. */
  .choices {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }

  section {
    display: flex;
    flex-direction: column;
    align-items: start;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
  }

  h3 {
    margin: 0;
    font-size: var(--text-sm);
  }

  section p {
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }

  .none {
    color: var(--ink-faint);
  }
</style>
