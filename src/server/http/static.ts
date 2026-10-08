import { createReadStream, existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serving the built single-page app.
 *
 * Like `operations/init.ts` and its templates, this resolves relative to its own
 * depth in the package — three levels up from `server/http` in both `src` and
 * `dist` — so moving this file breaks `lpm ui` and `lpm export --site`.
 */
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

export const WEB_DIST = path.join(PACKAGE_ROOT, 'web', 'dist');

/**
 * The read-only viewer bundle. A second build of the same sources, with
 * relative asset paths so it runs from any subdirectory — `lpm export --site`
 * copies it, nothing serves it.
 */
export const VIEWER_DIST = path.join(PACKAGE_ROOT, 'web', 'dist-viewer');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Resolve a URL path inside `root`, or null if it escapes or does not exist. */
function resolveFile(root: string, pathname: string): string | null {
  const target = path.resolve(root, `.${path.posix.normalize(pathname)}`);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return existsSync(target) && statSync(target).isFile() ? target : null;
}

export interface StaticServer {
  available: boolean;
  /** True when the request was answered. */
  serve(pathname: string, res: ServerResponse): boolean;
}

export function staticServer(root: string = WEB_DIST): StaticServer {
  const index = path.join(root, 'index.html');
  const available = existsSync(index);

  return {
    available,
    serve(pathname, res) {
      if (!available) return false;
      // Everything that is not a real file is a client-side route.
      const file = resolveFile(root, pathname) ?? index;
      const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
      // Hashed asset names make the bundle safe to cache; index.html is not.
      const cache = file === index ? 'no-store' : 'public, max-age=31536000, immutable';
      res.writeHead(200, { 'content-type': type, 'cache-control': cache });
      createReadStream(file).pipe(res);
      return true;
    },
  };
}
