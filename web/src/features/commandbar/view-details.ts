import type { ViewDocument } from '$shared';
import type { Tabs } from '$lib/app/tabs.svelte.js';
import type { ViewDetails, Workspace } from '$lib/workspace/workspace.svelte.js';

/**
 * Read and write the name and the description of one view, for the Edit view
 * dialog. The view can be the view of any open tab, also a tab that the window
 * does not show.
 *
 * A tab that the window showed has a workspace, and the workspace holds the
 * view in memory. Its next autosave writes the whole view file. So a change
 * to such a view goes through `Workspace.editDetails`, or the autosave writes
 * the old name back. A tab that the window never showed has no workspace, and
 * the change reads the view file, changes the two texts and writes the file.
 */
export interface ViewDetailsHost {
  tabs: Pick<Tabs, 'name' | 'description' | 'refresh'>;
  /** The workspace of an open tab, or undefined when the tab has none. */
  workspaceOf(id: string): Workspace | undefined;
  loadView(id: string): Promise<ViewDocument>;
  saveView(view: ViewDocument): Promise<ViewDocument>;
}

/** The workspace that holds the loaded view `id`, or undefined. */
function loadedWorkspace(host: ViewDetailsHost, id: string): Workspace | undefined {
  const workspace = host.workspaceOf(id);
  return workspace?.view?.id === id ? workspace : undefined;
}

/** The name and the description that the dialog starts with. */
export function currentDetails(host: ViewDetailsHost, id: string): ViewDetails {
  const view = loadedWorkspace(host, id)?.view;
  if (view) return { name: view.name, description: view.description ?? '' };
  return { name: host.tabs.name(id), description: host.tabs.description(id) };
}

/**
 * Write the name and the description of the view `id`, then read the view
 * list again so the tabs show the new name.
 *
 * Returns false when the workspace reported a refusal in its notices. Throws
 * when the server refused the write of a view without a workspace.
 */
export async function saveDetails(host: ViewDetailsHost, id: string, details: ViewDetails): Promise<boolean> {
  const next: ViewDetails = { name: details.name.trim(), description: details.description.trim() };
  const workspace = loadedWorkspace(host, id);
  if (workspace) {
    if (!(await workspace.editDetails(next))) return false;
  } else {
    const stored = await host.loadView(id);
    await host.saveView({ ...stored, ...next });
  }
  await host.tabs.refresh();
  return true;
}
