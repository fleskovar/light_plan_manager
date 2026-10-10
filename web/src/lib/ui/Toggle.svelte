<script lang="ts">
  /**
   * A switch with two states: on and off.
   *
   * The track is green and shows the text "On" while `checked` is true. The
   * track is grey and shows the text "Off" while `checked` is false. The knob
   * sits at the right end for on and at the left end for off. The component
   * holds no state: a click calls `onchange` with the opposite value, and the
   * parent passes the new `checked`.
   */
  interface Props {
    checked: boolean;
    /** The name that a screen reader announces. Put the visible label beside the switch. */
    label: string;
    disabled?: boolean;
    title?: string;
    onchange: (checked: boolean) => void;
  }

  let { checked, label, disabled = false, title, onchange }: Props = $props();
</script>

<button
  class="toggle"
  class:on={checked}
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  {title}
  onclick={() => onchange(!checked)}
>
  <span class="text">{checked ? 'On' : 'Off'}</span>
  <span class="knob"></span>
</button>

<style>
  .toggle {
    --width: 3.4rem;
    --height: 1.45rem;
    --gap: 2px;

    position: relative;
    flex: none;
    width: var(--width);
    height: var(--height);
    padding: 0;
    border: none;
    border-radius: 999px;
    /* Off is a neutral grey: off is a normal state and not an error. */
    background: var(--ink-faint);
    /* `--danger-ink` is the colour of text on a filled track. It suits the
       grey track and the green track, because all three colours change the
       same way with the theme. */
    color: var(--danger-ink);
    font-size: 0.6875rem;
    font-weight: 700;
    line-height: 1;
    transition: background var(--duration-fast);
  }

  .toggle.on {
    background: var(--tone-done);
  }

  .toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .toggle:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .knob {
    position: absolute;
    top: var(--gap);
    left: var(--gap);
    width: calc(var(--height) - 2 * var(--gap));
    height: calc(var(--height) - 2 * var(--gap));
    border-radius: 50%;
    background: var(--danger-ink);
    box-shadow: var(--shadow-sm);
    transition: transform var(--duration-fast);
  }

  .toggle.on .knob {
    transform: translateX(calc(var(--width) - var(--height)));
  }

  /* The text takes the end of the track that the knob leaves free. */
  .text {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0.45rem;
    display: grid;
    place-items: center;
  }

  .toggle.on .text {
    right: auto;
    left: 0.55rem;
  }
</style>
