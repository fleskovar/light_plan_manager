import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      // The wire contract lives with the server that implements it. It is
      // import-free by design, so it compiles here unchanged.
      $shared: path.resolve(here, '../src/shared'),
      $lib: path.resolve(here, 'src/lib'),
      $features: path.resolve(here, 'src/features'),
    },
  },
  server: {
    port: 5173,
    // `npm run dev` serves the app; the board still comes from `lpm ui --api-only`.
    proxy: { '/api': 'http://127.0.0.1:4571' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
