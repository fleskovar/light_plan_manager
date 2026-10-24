/**
 * The "All projects" page lives at this path on the same server: a board
 * server and the hub both serve it. `main.ts` mounts the page for this path,
 * so the address works after a reload and in a bookmark.
 */
export const PROJECTS_PATH = '/projects';

/** Go to the "All projects" page. `go` is the navigation, which a test replaces. */
export function goToProjects(go: (url: string) => void = (url) => window.location.assign(url)): void {
  go(PROJECTS_PATH);
}
