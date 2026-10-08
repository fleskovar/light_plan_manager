<script lang="ts">
  import type { Notice } from '$lib/workspace/workspace.svelte.js';

  /**
   * What the app has to say, where it cannot be missed.
   *
   * These used to sit in the bottom-right corner, in the same square as the
   * minimap and a shade off the surface colour — so a failed push looked like
   * part of the furniture and people carried on editing over the top of it. An
   * error is now a red card at the top of the screen, over the canvas, and it
   * stays until it is dismissed. Anything merely informative keeps the quiet
   * treatment and clears itself after a few seconds.
   */
  interface Props {
    notices: Notice[];
    ondismiss: (id: number) => void;
  }

  let { notices, ondismiss }: Props = $props();

  const errors = $derived(notices.filter((notice) => notice.level === 'error'));
</script>

<div class="stack">
  {#if errors.length > 1}
    <button class="clear" type="button" onclick={() => errors.forEach((one) => ondismiss(one.id))}>
      Dismiss {errors.length} errors
    </button>
  {/if}

  {#each notices as notice (notice.id)}
    <div
      class="notice {notice.level}"
      role={notice.level === 'error' ? 'alert' : 'status'}
      aria-live={notice.level === 'error' ? 'assertive' : 'polite'}
    >
      <span class="icon" aria-hidden="true">{notice.level === 'error' ? '⚠' : 'ℹ'}</span>
      <div class="text">
        <strong>{notice.message}</strong>
        {#if notice.details?.length}
          <ul>
            {#each notice.details as detail (detail)}
              <li>{detail}</li>
            {/each}
          </ul>
        {/if}
      </div>
      <button class="dismiss" type="button" aria-label="Dismiss" onclick={() => ondismiss(notice.id)}
        >×</button
      >
    </div>
  {/each}
</div>

<style>
  .stack {
    position: fixed;
    /* Just below the command bar: the top of the screen is the one place an
       error is unmissable, and covering Push while telling somebody the push
       failed would be its own small joke. */
    top: 3.25rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 90;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    width: min(40rem, calc(100vw - 2 * var(--space-4)));
    /* The stack is a strip across the top of the canvas; only the cards in it
       take the pointer, or it would swallow clicks on the graph behind them. */
    pointer-events: none;
  }

  .notice {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    box-shadow: var(--shadow-md);
    font-size: var(--text-sm);
    animation: arrive 180ms ease-out;
  }

  .icon {
    font-size: var(--text-lg);
    line-height: 1.2;
  }

  .info {
    border-left: 3px solid var(--accent);
  }

  .info .icon {
    color: var(--accent);
  }

  /*
   * An error is the one thing here that must interrupt: full red border, a red
   * wash rather than the surface colour, a ring around the whole card and two
   * pulses of it. Everything in this block is doing the same job — being seen.
   */
  .error {
    border: 2px solid var(--danger);
    background: var(--tone-blocked-soft);
    color: var(--ink);
    box-shadow: var(--shadow-lg);
    animation:
      arrive 180ms ease-out,
      pulse 900ms ease-out 2;
  }

  .error strong {
    color: var(--danger);
  }

  .error .icon {
    color: var(--danger);
  }

  .text {
    flex: 1;
    min-width: 0;
  }

  ul {
    margin: var(--space-2) 0 0;
    padding-left: 1.1rem;
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .error ul {
    color: var(--ink);
  }

  .dismiss {
    flex: none;
    padding: 0 var(--space-1);
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-muted);
    font-size: 1.25rem;
    line-height: 1;
  }

  .dismiss:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .clear {
    pointer-events: auto;
    order: 1;
    padding: 0.15rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-1);
    box-shadow: var(--shadow-sm);
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(-0.75rem);
    }
  }

  @keyframes pulse {
    from {
      box-shadow:
        var(--shadow-lg),
        0 0 0 0 color-mix(in srgb, var(--danger) 55%, transparent);
    }
    to {
      box-shadow:
        var(--shadow-lg),
        0 0 0 12px color-mix(in srgb, var(--danger) 0%, transparent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .notice,
    .error {
      animation: none;
    }
  }
</style>
