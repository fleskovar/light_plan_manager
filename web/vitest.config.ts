import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Only the logic is tested: graph building, layout, the working copy, the
 * mutations and the roster maths. Components stay presentational precisely so
 * that this is enough — nothing here needs a DOM.
 *
 * The svelte plugin is here for the `.svelte.ts` stores: runes are a compile
 * step, so a class using `$state` has to go through it even outside a browser.
 *
 * Vitest runs these tests in the Vite environment whose consumer is `server`.
 * Two settings make that environment run runes the way the browser does:
 *
 * - The plugin compiles each module with `generate: 'server'` by default. In
 *   that output `$effect` and `$effect.root` do nothing. The option
 *   `dynamicCompileOptions` sets `generate: 'client'`.
 * - `resolve.conditions` applies only to the client environment. Without the
 *   `ssr.resolve` conditions, `import { flushSync } from 'svelte'` loads the
 *   server build, where `flushSync` does nothing.
 *
 * `test/flag-form.svelte.test.ts` depends on both settings.
 */
export default defineConfig({
  plugins: [svelte({ dynamicCompileOptions: () => ({ generate: 'client' }) })],
  resolve: {
    conditions: ['browser'],
    alias: {
      $shared: path.resolve(here, '../src/shared'),
      $lib: path.resolve(here, 'src/lib'),
      $features: path.resolve(here, 'src/features'),
    },
  },
  ssr: { resolve: { conditions: ['browser'], externalConditions: ['browser'] } },
  test: { include: ['test/**/*.test.ts'] },
});
