import type { Shell } from '$lib/app/shell.svelte.js';
import { duplicate, removeNodes } from '$lib/workspace/mutations.js';
import type { Workspace } from '$lib/workspace/workspace.svelte.js';

/**
 * Keyboard shortcuts, as data.
 *
 * Declared here rather than scattered through components so the set can be
 * listed in one place. The menu bar reads this list: an entry of the Edit
 * menu runs a binding through `runBinding`, and Help ▸ Keyboard shortcuts
 * shows every binding. A binding never fires while the user is typing — see
 * `isTyping`.
 */
export type BindingId =
  | 'save'
  | 'push'
  | 'arrange'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'delete'
  | 'remove'
  | 'clear';

export interface Binding {
  /** The name that a menu entry uses to find this binding. */
  id: BindingId;
  /** Lowercase `event.key`. */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  description: string;
  run: (context: ShortcutContext) => void;
}

export interface ShortcutContext {
  workspace: Workspace;
  shell: Shell;
  arrange: () => void;
}

export const BINDINGS: Binding[] = [
  {
    id: 'save',
    key: 's',
    ctrl: true,
    description: 'Save the view',
    run: ({ workspace }) => void workspace.save(),
  },
  {
    id: 'push',
    key: 'enter',
    ctrl: true,
    description: 'Push pending changes to the board',
    run: ({ workspace }) => void workspace.push(),
  },
  {
    id: 'arrange',
    key: 'l',
    ctrl: true,
    description: 'Arrange the graph',
    run: ({ arrange }) => arrange(),
  },
  {
    id: 'copy',
    key: 'c',
    ctrl: true,
    description: 'Copy the selection',
    run: ({ workspace }) => {
      workspace.clipboard = [...workspace.selection.ids];
      if (workspace.clipboard.length) {
        workspace.notify('info', `Copied ${workspace.clipboard.length}`);
      }
    },
  },
  {
    id: 'paste',
    key: 'v',
    ctrl: true,
    description: 'Paste as new documents',
    run: ({ workspace }) => {
      if (!workspace.clipboard.length) return;
      workspace.selection.set(duplicate(workspace, workspace.clipboard));
    },
  },
  {
    id: 'duplicate',
    key: 'd',
    ctrl: true,
    description: 'Duplicate the selection',
    run: ({ workspace }) => {
      if (!workspace.selection.size) return;
      workspace.selection.set(duplicate(workspace, workspace.selection.ids));
    },
  },
  {
    id: 'delete',
    key: 'delete',
    description: 'Delete the selection from the board',
    run: ({ workspace, shell }) => {
      const ids = [...workspace.selection.ids];
      if (!ids.length) return;
      shell.confirm({
        title: 'Delete from the board?',
        message: `${ids.length} document${ids.length === 1 ? '' : 's'} and their children will be deleted on push.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: () => removeNodes(workspace, ids),
      });
    },
  },
  {
    id: 'remove',
    key: 'backspace',
    description: 'Remove the selection from the view',
    run: ({ workspace }) => workspace.removeMembers([...workspace.selection.ids]),
  },
  {
    id: 'clear',
    key: 'escape',
    description: 'Clear the selection',
    run: ({ workspace }) => workspace.selection.clear(),
  },
];

/** True when the event came from a field the user is typing into. */
export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
  );
}

export function findBinding(event: KeyboardEvent): Binding | undefined {
  const key = event.key.toLowerCase();
  const ctrl = event.ctrlKey || event.metaKey;
  return BINDINGS.find(
    (binding) =>
      binding.key === key &&
      Boolean(binding.ctrl) === ctrl &&
      (binding.shift === undefined || binding.shift === event.shiftKey),
  );
}

export function bindingOf(id: BindingId): Binding {
  const binding = BINDINGS.find((entry) => entry.id === id);
  if (!binding) throw new Error(`No binding "${id}"`);
  return binding;
}

/** Run the action of a binding, for a menu entry that offers the same action. */
export function runBinding(id: BindingId, context: ShortcutContext): void {
  bindingOf(id).run(context);
}

const KEY_LABELS: Record<string, string> = {
  enter: 'Enter',
  delete: 'Delete',
  backspace: 'Backspace',
  escape: 'Esc',
};

/** The keys of a binding as a menu shows them, for example `Ctrl+S`. */
export function shortcutLabel(binding: Binding): string {
  const key = KEY_LABELS[binding.key] ?? binding.key.toUpperCase();
  return `${binding.ctrl ? 'Ctrl+' : ''}${binding.shift ? 'Shift+' : ''}${key}`;
}
