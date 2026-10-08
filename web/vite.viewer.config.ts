import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The read-only viewer: a second bundle of the same sources.
 *
 * Two things make it different from `vite.config.ts`, and both are what let the
 * output be copied anywhere and just work:
 *
 *   root      `viewer/`, so its index.html is the entry and lands as
 *             `dist-viewer/index.html` — what a GitHub Pages site serves.
 *   base      relative, so the assets resolve from `owner.github.io/repo/` as
 *             happily as from a domain root. The app already routes on the
 *             hash, so no rewrite rules are needed either.
 *
 * There is no dev proxy because there is no API: the viewer fetches one
 * `board.json` written by `lpm export`.
 */
export default defineConfig({
  root: path.resolve(here, 'viewer'),
  base: './',
  // The plugin looks for a svelte config beside the root, and the root is not
  // the package here.
  plugins: [svelte({ configFile: path.resolve(here, 'svelte.config.js') })],
  resolve: {
    alias: {
      $shared: path.resolve(here, '../src/shared'),
      $lib: path.resolve(here, 'src/lib'),
      $features: path.resolve(here, 'src/features'),
    },
  },
  build: {
    outDir: path.resolve(here, 'dist-viewer'),
    emptyOutDir: true,
  },
});
