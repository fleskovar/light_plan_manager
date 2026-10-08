import type { StaticBoard } from '$shared';
import { STATIC_BOARD_FILE, parseStaticBoard } from '$shared';

/**
 * Working out which board to show, from nothing but the address bar.
 *
 * Three ways in, in order of how much the page has been set up for:
 *
 *   (none)              `./board.json`, beside the page. This is what
 *                       `lpm export --site` produces, and what a GitHub Pages
 *                       board serves.
 *   ?repo=owner/name    Read another repository's export over raw.github\
 *                       usercontent.com. Nothing has to be installed anywhere;
 *                       the repository just needs a committed board.json.
 *   ?src=<url>          An explicit URL, for a board published somewhere else.
 *
 * `?ref=` and `?path=` refine the repo form. Everything is a plain GET of one
 * file: no API, no token, no rate limit worth worrying about.
 */
const RAW_HOST = 'https://raw.githubusercontent.com';
const DEFAULT_PATH = `.lpm/${STATIC_BOARD_FILE}`;

/** `owner/name`, optionally `owner/name@ref`. */
const REPO = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@([\w.\-/]+))?$/;
const REF = /^[\w.\-/]+$/;

export interface BoardLocation {
  /** Where the board data is fetched from. */
  url: string;
  /** `owner/name`, when the URL was built from `?repo=`. */
  repo: string | null;
  /** A page to link back to, when there is an obvious one. */
  homepage: string | null;
}

/**
 * A URL is only followed if it is http(s) or same-origin relative. The page
 * fetches whatever it is pointed at, so `javascript:` and friends stop here
 * rather than at whatever happens to consume the string later.
 */
function safeUrl(value: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

export function resolveLocation(search: string, base: string): BoardLocation {
  const params = new URLSearchParams(search);

  const src = params.get('src');
  if (src) {
    const url = safeUrl(src, base);
    if (!url) throw new Error(`"${src}" is not a URL this viewer will fetch`);
    return { url, repo: null, homepage: null };
  }

  const repo = params.get('repo');
  if (repo) {
    const match = REPO.exec(repo.trim());
    if (!match) {
      throw new Error(`"${repo}" is not an owner/name repository`);
    }
    const [, owner, name, inlineRef] = match as unknown as [string, string, string, string?];
    const ref = params.get('ref') ?? inlineRef ?? 'HEAD';
    const path = params.get('path') ?? DEFAULT_PATH;
    if (!REF.test(ref)) throw new Error(`"${ref}" is not a branch, tag or commit`);
    if (path.includes('..')) throw new Error(`"${path}" is not a path in the repository`);

    const clean = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return {
      url: `${RAW_HOST}/${owner}/${name}/${ref}/${clean}`,
      repo: `${owner}/${name}`,
      homepage: `https://github.com/${owner}/${name}`,
    };
  }

  return { url: new URL(`./${STATIC_BOARD_FILE}`, base).href, repo: null, homepage: null };
}

/**
 * Fetch and validate the board.
 *
 * Credentials are deliberately omitted: this reads public files, and a viewer
 * that quietly sent a reader's cookies to whatever `?src=` named would be a
 * worse thing than a viewer that cannot read private boards.
 */
export async function fetchStaticBoard(
  location: BoardLocation,
  fetchImpl: typeof fetch = fetch,
): Promise<StaticBoard> {
  let response: Response;
  try {
    response = await fetchImpl(location.url, { credentials: 'omit', cache: 'no-cache' });
  } catch (error) {
    throw new Error(`Could not reach ${location.url} (${(error as Error).message})`);
  }

  if (response.status === 404) {
    throw new Error(
      location.repo
        ? `${location.repo} has no exported board at that path. Run \`lpm export\` and commit the result.`
        : `No board at ${location.url}. Run \`lpm export --site\` to produce one.`,
    );
  }
  if (!response.ok) {
    throw new Error(`${location.url} returned ${response.status} ${response.statusText}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${location.url} is not JSON`);
  }
  return parseStaticBoard(body);
}
