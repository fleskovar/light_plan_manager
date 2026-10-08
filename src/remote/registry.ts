/**
 * The provider registry — the one place a provider name becomes an
 * implementation.
 *
 * Adding a provider is a folder under `src/remote/providers/` and one line in
 * the literal below. Deliberately a plain object literal: no dynamic import,
 * no filesystem scanning, no plugin loader. The codebase's explicit tables
 * (`commands` / `summaries` in `src/cli/index.ts`, `BUILTIN_TEMPLATES`) have
 * served it well, and a discovery mechanism would be the first magic in it.
 *
 * Third-party providers are out of scope for 0.3.0; the shape (`Provider`)
 * allows them later without committing to a plugin API now.
 */

import { BoardError } from '../core/errors.js';
import type { Provider } from './provider.js';
import { githubProvider } from './providers/github/index.js';
import { jiraProvider } from './providers/jira/index.js';
import { jsonfileProvider } from './providers/jsonfile/index.js';
import { linearProvider } from './providers/linear/index.js';

/** Provider name → implementation. The registry itself. */
export const providers: Record<string, Provider> = {
  github: githubProvider,
  jira: jiraProvider,
  jsonfile: jsonfileProvider,
  linear: linearProvider,
};

/** Registered provider names, sorted, for errors and listings. */
export function registeredProviders(): string[] {
  return Object.keys(providers).sort();
}

/**
 * Resolve a provider name without throwing — `undefined` when unknown.
 * The quiet half of `lookupProvider`, for callers that want to report a
 * problem rather than raise one (the check pass).
 */
export function findProvider(name: string): Provider | undefined {
  return providers[name];
}

/**
 * Resolve a provider name to its implementation.
 *
 * Throws `BoardError` naming the registered providers when the name is unknown
 * — so a typo in `provider:` is diagnosed here, where the provider is resolved,
 * not where the config file is read (core never knows what a provider is).
 */
export function lookupProvider(name: string): Provider {
  const provider = findProvider(name);
  if (!provider) {
    throw new BoardError(`Unknown provider "${name}"`, [
      `Registered providers: ${registeredProviders().join(', ')}`,
    ]);
  }
  return provider;
}
