/**
 * Routing, in its entirety.
 *
 * The app has two screens — pick a view, or work on one — so the "router" is a
 * reactive read of the URL hash. `#/view/roadmap` opens a view; anything else
 * is the welcome screen. Using the hash means reloading the page keeps you
 * where you were, and the static server needs no rewrite rules.
 */
export type Route =
  | { name: 'welcome' }
  | { name: 'view'; id: string }
  | { name: 'issue'; nodeId: string; viewId: string };

function parse(hash: string): Route {
  const issueMatch = /^#\/issue\/([^?]+)\?view=(.+)$/.exec(hash);
  if (issueMatch) {
    return { name: 'issue', nodeId: decodeURIComponent(issueMatch[1]!), viewId: decodeURIComponent(issueMatch[2]!) };
  }
  const viewMatch = /^#\/view\/(.+)$/.exec(hash);
  return viewMatch ? { name: 'view', id: decodeURIComponent(viewMatch[1]!) } : { name: 'welcome' };
}

export function createRouter(): { readonly route: Route } {
  let route = $state(parse(window.location.hash));
  window.addEventListener('hashchange', () => {
    route = parse(window.location.hash);
  });
  return {
    get route() {
      return route;
    },
  };
}

export function goToView(id: string): void {
  window.location.hash = `#/view/${encodeURIComponent(id)}`;
}

export function goHome(): void {
  window.location.hash = '#/';
}
