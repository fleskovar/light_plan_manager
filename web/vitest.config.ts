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
 */
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ['browser'],
    alias: {
      $shared: path.resolve(here, '../src/shared'),
      $lib: path.resolve(here, 'src/lib'),
      $features: path.resolve(here, 'src/features'),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
