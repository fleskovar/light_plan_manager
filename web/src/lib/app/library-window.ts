import { libraryHash, parseRoute } from './router.svelte.js';

/**
 * The Library page (`#/library`) runs in a browser window of its own, so the
 * reader can keep the canvas and the library side by side.
 *
 * The window has the name `LIBRARY_WINDOW`. A second request finds the window
 * by that name and brings it to the front. When the request names a
 * document, the window gets the address of that document, and the page opens
 * it. A request without a document leaves the window on the page it shows,
 * so the open document and an unsaved draft stay.
 */
export const LIBRARY_WINDOW = 'lpm-library';

/** Wide enough for the tree and the editor side by side. */
const FEATURES = 'width=1280,height=860,resizable,scrollbars';

/** True when `target` already shows the Library page. False when the browser does not let this window read it. */
function showsLibrary(target: Window): boolean {
  try {
    return parseRoute(target.location.hash).name === 'library';
  } catch {
    return false;
  }
}

/**
 * Open the Library page, on the document `docId` when it is not null. `viewId`
 * names the view whose issue windows the links of the page open. Returns
 * false when the browser blocked the window.
 */
export function openLibraryWindow(docId: string | null, viewId: string | null): boolean {
  // An empty address returns the window with this name when one exists, and
  // opens an empty window when none does.
  const target = window.open('', LIBRARY_WINDOW, FEATURES);
  if (!target) return false;
  if (docId !== null || !showsLibrary(target)) {
    const base = window.location.href.replace(/#.*$/, '');
    target.location.href = `${base}${libraryHash(docId, viewId)}`;
  }
  target.focus();
  return true;
}
