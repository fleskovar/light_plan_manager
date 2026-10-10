import { getContext, setContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { Workspace } from './workspace.svelte.js';

/**
 * One `Workspace` for each open tab, keyed by the id of its view.
 *
 * A workspace lives from the moment its tab opens until the tab closes. A
 * switch to another tab unmounts the screen of the workspace and keeps the
 * workspace, so the unsaved layout, the selection and the queue of the first
 * tab are still there when the reader returns.
 *
 * The map is reactive, so the tab strip can read `unsaved` from the workspace
 * of each tab. Call `acquire` and `release` from an effect or an event
 * handler: Svelte refuses a write to shared state while a component renders.
 */
export class WorkspacePool {
  readonly #open = new SvelteMap<string, Workspace>();
  readonly #make: () => Workspace;

  constructor(make: () => Workspace) {
    this.#make = make;
  }

  /** The workspace of the view. The first call creates it and starts the load. */
  acquire(id: string): Workspace {
    const existing = this.#open.get(id);
    if (existing) return existing;
    const workspace = this.#make();
    workspace.load(id);
    this.#open.set(id, workspace);
    return workspace;
  }

  get(id: string): Workspace | undefined {
    return this.#open.get(id);
  }

  all(): Workspace[] {
    return [...this.#open.values()];
  }

  /** Dispose the workspace of a closed tab. `deleted` says that its view file is gone. */
  release(id: string, deleted = false): void {
    const workspace = this.#open.get(id);
    if (!workspace) return;
    this.#open.delete(id);
    workspace.dispose({ deleted });
  }
}

const KEY = Symbol('workspace-pool');

export function providePool(pool: WorkspacePool): WorkspacePool {
  return setContext(KEY, pool);
}

export function usePool(): WorkspacePool {
  return getContext<WorkspacePool>(KEY);
}
