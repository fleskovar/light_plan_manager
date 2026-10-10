/**
 * Routing, in its entirety.
 *
 * The "router" is a reactive read of the URL hash. `#/view/roadmap` names the
 * view that the window shows, which is the active tab. `#/issue/LP-3?view=roadmap`
 * is the popup for one issue. Any other hash is `home`: the app then opens the
 * view that this browser used last. Using the hash means reloading the page
 * keeps you where you were, and the static server needs no rewrite rules.
 */
export type Route =
  | { name: 'home' }
  | { name: 'view'; id: string }
  | { name: 'issue'; nodeId: string; viewId: string };

export function parseRoute(hash: string): Route {
  const issueMatch = /^#\/issue\/([^?]+)\?view=(.+)$/.exec(hash);
  if (issueMatch) {
    return { name: 'issue', nodeId: decodeURIComponent(issueMatch[1]!), viewId: decodeURIComponent(issueMatch[2]!) };
  }
  const viewMatch = /^#\/view\/(.+)$/.exec(hash);
  return viewMatch ? { name: 'view', id: decodeURIComponent(viewMatch[1]!) } : { name: 'home' };
}

export function createRouter(): { readonly route: Route } {
  let route = $state(parseRoute(window.location.hash));
  window.addEventListener('hashchange', () => {
    route = parseRoute(window.location.hash);
  });
  return {
    get route() {
      return route;
    },
  };
}

export const viewHash = (id: string): string => `#/view/${encodeURIComponent(id)}`;

/**
 * Show a view in this window. With `replace`, the new address takes the place
 * of the current history entry, so the Back button does not return to an
 * address that only redirects.
 */
export function goToView(id: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.location.replace(viewHash(id));
  else window.location.hash = viewHash(id);
}
