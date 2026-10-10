import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `initBoard` reads the default template from the user folder. The tests
    // must not read the `~/.light-plan` of the person who runs them, so
    // `LPM_HOME` names a folder that no test creates. A test that writes the
    // user folder sets `LPM_HOME` to a folder of its own.
    env: { LPM_HOME: path.join(os.tmpdir(), 'lpm-test-no-user-folder') },
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
