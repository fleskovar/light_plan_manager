<script lang="ts">
  import { useCanvasEditing } from '../editing.js';

  /**
   * A one-line field for a title on the canvas. The canvas uses it to rename
   * a node, to name the item that **Add new…** created, and to type the title
   * on the card of a new item.
   *
   * The field takes the focus and selects its text when it opens. Enter
   * submits with `next: true` and Escape cancels. A press of the pointer
   * outside the field, or a move of the focus to another element, submits
   * with `next: false`. The field reports one outcome only.
   *
   * A blur with no new focus target and no press outside the field does not
   * submit. SvelteFlow causes that blur: it removes a node element and adds it
   * again when the visible part of the canvas changes, for example while the
   * canvas travels to a new node. The field then takes the focus back. When
   * the node was unmounted, `renaming` still names it, and the field opens
   * again when the node is drawn again.
   *
   * The classes `nodrag`, `nopan` and `nowheel` tell SvelteFlow that a
   * pointer or wheel event on the field belongs to the field.
   */
  interface Props {
    value: string;
    placeholder?: string;
    label: string;
    onsubmit: (text: string, next: boolean) => void;
    oncancel: () => void;
  }

  let { value, placeholder = '', label, onsubmit, oncancel }: Props = $props();

  // While the field is on screen, the workspace holds the automatic push. A
  // push would give a new item its real id and close this field. The viewer
  // provides no editing context and has no field.
  const editing = useCanvasEditing();
  $effect(() => editing?.openField());

  // The field edits a copy of the title, so the prop is read once.
  // svelte-ignore state_referenced_locally
  let text = $state(value);
  let done = false;
  let input: HTMLInputElement | undefined;
  let mounted = true;

  // A press anywhere outside the field submits it. A listener on the window
  // sees the press first, so SvelteFlow cannot stop it, and a press on the
  // pane counts although the pane takes no focus.
  $effect(() => {
    const onPress = (event: PointerEvent): void => {
      if (input && event.target instanceof Node && input.contains(event.target)) return;
      finish(() => onsubmit(text, false));
    };
    window.addEventListener('pointerdown', onPress, true);
    return () => {
      mounted = false;
      window.removeEventListener('pointerdown', onPress, true);
    };
  });

  function onblur(event: FocusEvent): void {
    // The focus moved to another element: the reader left the field.
    if (event.relatedTarget !== null) {
      finish(() => onsubmit(text, false));
      return;
    }
    // The focus moved to nothing. SvelteFlow moved or removed the node.
    requestAnimationFrame(() => {
      if (!mounted || done || !input?.isConnected) return;
      if (document.activeElement === document.body || document.activeElement === null) {
        input.focus();
      }
    });
  }

  function finish(action: () => void): void {
    if (done) return;
    done = true;
    action();
  }

  function focusOnOpen(element: HTMLInputElement): void {
    input = element;
    // The node that holds the field can mount during a pointer event that
    // moves the focus back to the pane, so the focus waits one frame.
    requestAnimationFrame(() => {
      element.focus();
      element.select();
    });
  }
</script>

<input
  class="title-field nodrag nopan nowheel"
  type="text"
  aria-label={label}
  {placeholder}
  bind:value={text}
  use:focusOnOpen
  onkeydown={(event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(() => onsubmit(text, true));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(oncancel);
    }
  }}
  {onblur}
  onpointerdown={(event) => event.stopPropagation()}
  ondblclick={(event) => event.stopPropagation()}
/>

<style>
  .title-field {
    width: 100%;
    margin: 0.15rem 0 0;
    padding: 0.15rem 0.3rem;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
    user-select: text;
    pointer-events: all;
  }

  .title-field:focus {
    outline: 2px solid var(--accent-soft);
  }
</style>
