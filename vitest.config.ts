import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The web app is a separate package with its own aliases and its own
    // vitest config; `npm run test:web` runs it.
    include: ['test/**/*.test.ts'],
    // test/cli.test.ts spawns the built CLI once per step, and the suites run in
    // parallel, so those processes routinely need more than the 5s default.
    testTimeout: 30000,
    // Same reason, for the `beforeEach` that makes a temp board: with every
    // suite spawning processes at once, even mkdtemp can miss the 10s default.
    hookTimeout: 30000,
  },
});
