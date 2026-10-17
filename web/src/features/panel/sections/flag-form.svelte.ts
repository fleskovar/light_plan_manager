import { untrack } from 'svelte';

const DEFAULT_REASON = 'blocked';

/** What `FlagForm.submit` hands to the caller: `reason` is null to clear the flag. */
export interface FlagSubmission {
  reason: string | null;
  comment: string;
}

/**
 * The state of the flag form in `Flag.svelte`: whether it is open, the reason
 * and the note.
 *
 * The form closes and clears when the selected issue changes. The constructor
 * takes a function that returns the id, and the effect reads that id through a
 * `$derived` string. The auto-pull in `Workspace` replaces every node object
 * every 5 seconds. An effect that reads `issue.id` from the object re-runs on
 * each new object and closes the form while the person types. A `$derived`
 * string notifies its readers only when the id changes.
 *
 * Create it during component setup or inside `$effect.root`, because the
 * constructor registers an effect.
 */
export class FlagForm {
  open = $state(false);
  reason = $state<string>(DEFAULT_REASON);
  note = $state('');

  constructor(issueId: () => string) {
    const id = $derived(issueId());
    $effect(() => {
      void id;
      untrack(() => this.reset());
    });
  }

  reset(): void {
    this.open = false;
    this.note = '';
    this.reason = DEFAULT_REASON;
  }

  /**
   * Return the values to send and close the form. Returns null and keeps the
   * form open when the note is empty, because the engine refuses a flag
   * without a note.
   */
  submit(clearing: boolean): FlagSubmission | null {
    const comment = this.note.trim();
    if (!comment) return null;
    const submission = { reason: clearing ? null : this.reason, comment };
    this.open = false;
    this.note = '';
    return submission;
  }
}
