import { flushSync } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { FlagForm } from '$features/panel/sections/flag-form.svelte.js';

/**
 * `FlagForm` runs an effect, so each test creates it inside `$effect.root` and
 * calls `flushSync` to run the effects. `selected.issue` stands for the `issue`
 * prop that `SidePanel.svelte` passes to `Flag.svelte`.
 */
let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function setup(id: string) {
  const selected = $state({ issue: { id, flag: 'blocked' as string | null } });
  let form!: FlagForm;
  cleanup = $effect.root(() => {
    form = new FlagForm(() => selected.issue.id);
  });
  flushSync();
  return { selected, form };
}

describe('FlagForm', () => {
  it('keeps the open form and the note when the auto-pull replaces the issue object', () => {
    const { selected, form } = setup('LP-1');
    form.open = true;
    form.note = 'The API key arrived';
    flushSync();

    // `Workspace.#backgroundPull` builds new node objects with the same ids.
    selected.issue = { id: 'LP-1', flag: 'blocked' };
    flushSync();

    expect(form.open).toBe(true);
    expect(form.note).toBe('The API key arrived');
  });

  it('closes and clears the form when another issue is selected', () => {
    const { selected, form } = setup('LP-1');
    form.open = true;
    form.reason = 'paused';
    form.note = 'Half-written note';
    flushSync();

    selected.issue = { id: 'LP-2', flag: null };
    flushSync();

    expect(form.open).toBe(false);
    expect(form.note).toBe('');
    expect(form.reason).toBe('blocked');
  });

  it('returns null and keeps the form open when the note is empty', () => {
    const { form } = setup('LP-1');
    form.open = true;
    form.note = '   ';

    expect(form.submit(true)).toBeNull();
    expect(form.open).toBe(true);
  });

  it('returns a null reason to clear the flag, and closes the form', () => {
    const { form } = setup('LP-1');
    form.open = true;
    form.reason = 'paused';
    form.note = '  The API key arrived  ';

    expect(form.submit(true)).toEqual({ reason: null, comment: 'The API key arrived' });
    expect(form.open).toBe(false);
    expect(form.note).toBe('');
  });

  it('returns the chosen reason to raise a flag', () => {
    const { form } = setup('LP-1');
    form.open = true;
    form.reason = 'paused';
    form.note = 'Waiting for the API key';

    expect(form.submit(false)).toEqual({ reason: 'paused', comment: 'Waiting for the API key' });
  });
});
