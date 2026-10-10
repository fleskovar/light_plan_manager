import { readFileSync } from 'node:fs';
import { experimentalOf } from '../config/lookup.js';
import { parseConfigText } from '../config/schema.js';
import { BoardError } from '../errors.js';
import { writeFileAtomic } from '../storage/atomic.js';
import type { BoardPaths } from '../storage/paths.js';
import { CONFIG_FILE, LPM_DIR } from '../storage/paths.js';
import { withBoardWrite } from './git-sync.js';

/**
 * Turning the experimental features of a board on and off.
 *
 * `setExperimental` writes the key `experimental` in `.lpm/config.yml`. The
 * key holds `true` or `false`. When the key is absent, the features are off.
 * `experimentalOf` in `config/lookup.ts` reads the key, and `lpm ui` passes the
 * answer to the server. The flag `lpm ui --experimental` still turns the
 * features on for one run.
 *
 * The experimental features today are the tracker remotes of the web app. The
 * key does not gate a CLI command: `lpm remote` and `lpm queue agent` work
 * with or without it.
 *
 * The config is edited as text, as `setPlanning` edits it. Turning the
 * features on appends one commented line, and turning them off removes that
 * line with its comment, so the two calls leave the file byte for byte as it
 * was. No document is touched. On a board shared through git, the change is
 * committed and pushed like any other write, so the whole team gets it.
 *
 * This module does not install anything. The packages that the experimental
 * features load belong to the installation of light-plan and not to a board.
 * The CLI installs them (`cli/experimental-deps.ts`).
 */

export interface SetExperimentalResult {
  /** Whether the features are on afterwards. */
  experimental: boolean;
  /** Whether the features were on before. */
  previous: boolean;
  /** False when the board already held that value and nothing was written. */
  changed: boolean;
}

/** The block that turning the features on appends, comment included, so that it can be removed whole. */
const EXPERIMENTAL_BLOCK =
  '\n# Show the features of `lpm ui` that are not finished yet: the tracker\n' +
  '# remotes (Jira, GitHub, Linear). `lpm experimental off` removes this line.\n' +
  'experimental: true\n';

/** A top-level `experimental:` line, however it was written. */
const EXPERIMENTAL_LINE = /^experimental:[^\n]*\n?/m;

/**
 * The config text with the experimental features on or off, touching nothing
 * but the line of the key. Exported for `boardTemplateText`, which removes the
 * key from a template.
 */
export function configWithExperimental(text: string, on: boolean): string {
  if (!on) {
    // The block that this module wrote goes whole, with its comment and its
    // blank line. A line that a person wrote goes alone.
    if (text.includes(EXPERIMENTAL_BLOCK)) return text.replace(EXPERIMENTAL_BLOCK, '');
    return text.replace(EXPERIMENTAL_LINE, '');
  }
  if (EXPERIMENTAL_LINE.test(text)) return text.replace(EXPERIMENTAL_LINE, 'experimental: true\n');
  return `${text}${text.endsWith('\n') ? '' : '\n'}${EXPERIMENTAL_BLOCK}`;
}

/** Turn the experimental features of the board on or off. Writes nothing when the board already holds the value. */
export function setExperimental(paths: BoardPaths, on: boolean): SetExperimentalResult {
  const loaded = parseConfigText(readFileSync(paths.configPath, 'utf8'));
  if (!loaded.config) throw new BoardError('The board config does not validate', loaded.errors);
  const config = loaded.config;
  const previous = experimentalOf(config);
  if (previous === on) return { experimental: on, previous, changed: false };

  withBoardWrite(
    paths,
    on ? 'turn the experimental features on' : 'turn the experimental features off',
    () => {
      const next = configWithExperimental(readFileSync(paths.configPath, 'utf8'), on);
      const parsed = parseConfigText(next);
      if (!parsed.config || experimentalOf(parsed.config) !== on) {
        throw new BoardError(`${LPM_DIR}/${CONFIG_FILE} would not validate`, [
          ...(parsed.errors ?? []),
          'Check the `experimental:` line in .lpm/config.yml by hand.',
        ]);
      }
      writeFileAtomic(paths.configPath, next);
    },
    config,
  );
  return { experimental: on, previous, changed: true };
}
