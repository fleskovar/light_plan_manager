import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import { Selection } from '$lib/workspace/selection.svelte.js';

/**
 * `Selection.set` keeps the order of the ids that stay selected, so it reads
 * the current selection before it writes a new one. The canvas calls `set`
 * from code that an effect runs. If that read were tracked, the effect would
 * depend on the selection that it writes, and Svelte would stop it with
 * `effect_update_depth_exceeded`.
 */
describe('Selection.set inside an effect', () => {
  it('runs the effect once', () => {
    const selection = new Selection();
    let runs = 0;
    const stop = $effect.root(() => {
      $effect(() => {
        runs += 1;
        selection.set(['A', 'B']);
      });
    });
    flushSync();
    expect(runs).toBe(1);
    expect(selection.ids).toEqual(['A', 'B']);
    stop();
  });
});
