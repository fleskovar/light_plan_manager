import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A router small enough to read in one sitting: exact segments plus `:name`
 * placeholders, matched in registration order. There is no middleware stack and
 * no wildcards — the API has a dozen endpoints and is meant to stay that way.
 */
export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface Route {
  method: Method;
  segments: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: Method, pattern: string, handler: Handler): this {
    this.routes.push({ method, segments: split(pattern), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  put(pattern: string, handler: Handler): this {
    return this.add('PUT', pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  /** The handler for a request, with its path params, or null when nothing matches. */
  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = split(pathname);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, parts);
      if (params) return { handler: route.handler, params };
    }
    return null;
  }
}

function split(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of pattern.entries()) {
    const part = parts[index]!;
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(part);
    else if (segment !== part) return null;
  }
  return params;
}
