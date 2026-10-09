import { getContext, setContext } from 'svelte';
import type { MenuAnchor, MenuEntry } from '$lib/ui/menu/types.js';

/**
 * Transient UI state: the open context menu, the open dialog, the pending
 * confirmation. It lives beside the workspace rather than inside it because
 * none of it is board state — closing a menu is not an edit — and because half
 * the features on screen need to open one of these.
 */
export interface Confirmation {
  title: string;
  message: string;
  details?: string[];
  confirmLabel?: string;
  danger?: boolean;
  /**
   * One optional extra the confirm can carry out at the same time — a
   * checkbox under the message. Its final state is what `onConfirm` receives.
   */
  choice?: { label: string; checked: boolean };
  onConfirm: (choice: boolean) => void;
}

/** A drop the hierarchy will not take as it stands, waiting for an answer. */
export interface ReparentRequest {
  id: string;
  parentId: string;
  /** Called with nothing when the reader cancels, so the canvas can redraw. */
  onDone: () => void;
}

export class Shell {
  menu = $state<{ anchor: MenuAnchor; entries: MenuEntry[] } | null>(null);
  breakdownTarget = $state<string | null>(null);
  /** The Options ▸ DAG ▸ Hierarchy display dialog. */
  hierarchyOpen = $state(false);
  /** The resource whose card's pencil was clicked. */
  resourceTarget = $state<string | null>(null);
  /** The type of a resource being added, which does not exist until it is created. */
  newResourceType = $state<string | null>(null);
  reparentRequest = $state<ReparentRequest | null>(null);
  confirmation = $state<Confirmation | null>(null);
  /**
   * The period box a canvas drag is hovering, so the drawer can light it up.
   *
   * It lives here for the same reason the open menu does: the canvas is doing
   * the dragging and the Periods view is doing the drawing, and neither owns
   * the other. Nothing about the board is in it — it is gone the moment the
   * pointer comes up.
   */
  periodDropTarget = $state<string | null>(null);
  /**
   * Whose queue the queue panel shows: a resource id, or null for everybody's.
   * Here rather than in the panel so folding the panel does not forget it, and
   * not in the view, because it is a way of reading and nothing a teammate
   * should inherit on pull.
   */
  queueFor = $state<string | null>(null);

  openMenu(event: MouseEvent, entries: MenuEntry[]): void {
    event.preventDefault();
    event.stopPropagation();
    this.openMenuAt({ x: event.clientX, y: event.clientY }, entries);
  }

  /**
   * A menu somewhere other than the pointer — under the button that opened it,
   * which is what a toolbar dropdown has to do to look like one.
   */
  openMenuAt(anchor: MenuAnchor, entries: MenuEntry[]): void {
    if (!entries.length) return;
    this.menu = { anchor, entries };
  }

  closeMenu(): void {
    this.menu = null;
  }

  openBreakdown(id: string): void {
    this.breakdownTarget = id;
  }

  closeBreakdown(): void {
    this.breakdownTarget = null;
  }

  openHierarchy(): void {
    this.hierarchyOpen = true;
  }

  closeHierarchy(): void {
    this.hierarchyOpen = false;
  }

  editResource(id: string): void {
    this.newResourceType = null;
    this.resourceTarget = id;
  }

  newResource(type: string): void {
    this.resourceTarget = null;
    this.newResourceType = type;
  }

  closeResource(): void {
    this.resourceTarget = null;
    this.newResourceType = null;
  }

  askReparent(request: ReparentRequest): void {
    this.reparentRequest = request;
  }

  closeReparent(): void {
    const pending = this.reparentRequest;
    this.reparentRequest = null;
    pending?.onDone();
  }

  confirm(confirmation: Confirmation): void {
    this.confirmation = confirmation;
  }

  resolveConfirmation(accepted: boolean, choice = false): void {
    const pending = this.confirmation;
    this.confirmation = null;
    if (accepted) pending?.onConfirm(choice);
  }
}

const KEY = Symbol('shell');

export function provideShell(shell: Shell): Shell {
  return setContext(KEY, shell);
}

export function useShell(): Shell {
  return getContext<Shell>(KEY);
}
