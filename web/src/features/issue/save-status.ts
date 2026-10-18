/**
 * The text beside the Save button of the issue window.
 *
 * The issue window writes in two ways. A change to a field (status, assignee,
 * an attribute) is recorded in the workspace, and the workspace pushes it
 * `AUTOSAVE_DELAY` later with nobody pressing anything. A change to the
 * description waits in a draft until the reader presses Save. This function
 * turns the state of both into one short label, so the reader can see whether
 * closing the window loses anything.
 */

/** Who started the last write: the workspace debounce, or the Save button. */
export type SavedBy = 'auto' | 'manual';

export type SaveTone = 'saving' | 'unsaved' | 'saved' | 'idle';

export interface SaveState {
  /** True while a push runs. */
  saving: boolean;
  /** True while the draft or the workspace queue holds a change that no push wrote. */
  unsaved: boolean;
  /** The time of the last write, in milliseconds since the epoch, or null when nothing was written. */
  savedAt: number | null;
  savedBy: SavedBy;
}

export interface SaveLabel {
  tone: SaveTone;
  text: string;
  /** The full time of the last write, for the tooltip. */
  title?: string;
}

/**
 * How long ago a write happened, in words. Under 10 seconds is "just now".
 * Under a minute counts in steps of 5 seconds, so the label does not change
 * every second.
 */
export function ago(elapsed: number): string {
  const seconds = Math.max(0, Math.floor(elapsed / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds - (seconds % 5)} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

export function saveLabel(state: SaveState, now: number): SaveLabel {
  if (state.saving) return { tone: 'saving', text: 'Saving…' };
  if (state.unsaved) return { tone: 'unsaved', text: 'Unsaved changes' };
  if (state.savedAt === null) return { tone: 'idle', text: 'No changes' };
  const when = ago(now - state.savedAt);
  return {
    tone: 'saved',
    text: state.savedBy === 'auto' ? `Saved automatically ${when}` : `Saved ${when}`,
    title: `Written to the board at ${new Date(state.savedAt).toLocaleTimeString()}`,
  };
}
