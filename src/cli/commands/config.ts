import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  BoardError,
  abandonCentralStore,
  centralStorePath,
  expandHome,
  listCentralBoards,
  moveCentralStore,
  readUserSettings,
  samePath,
  setCentralStore,
  setDefaultBoardTemplate,
  unsetCentralStore,
  userSettingsPath,
  writeUserSettings,
} from '../../core/index.js';
import { choose } from '../prompt.js';
import { bold, dim, green, out, pad, yellow } from '../ui.js';

/**
 * Reading and writing the user settings: the keys in `settings.json` of the
 * user folder, which belong to one person on one computer and to no board. A
 * thin printer over the operations that own each key, so that `lpm config set`
 * checks a value the same way as the code that reads it.
 */

export const help = `Show and change your user settings.

Usage
  lpm config                       List every setting and its value
  lpm config get <key>             Print the value of one setting
  lpm config set <key> <value>     Write a setting
  lpm config set central_store [--path <dir>] [--move | --abandon]
                                   Make this folder (or <dir>) the central store
  lpm config unset <key>           Remove a setting, so its default applies

\`lpm set central_store\` is the same command as \`lpm config set central_store\`.

Settings
  central_store      The folder that holds boards outside their projects. Each
                     board is a folder in <central_store>/.lpm_central. The
                     value is an absolute path. A relative path resolves from
                     the current folder, and ~ is the home folder. set creates
                     a missing folder. Default: not set, so every board is
                     local. lpm init, lpm store and lpm ui read it.
  default_template   The board template that lpm init uses without --template.
                     The value is the name of a built-in or saved template.
                     Default: scrum.

Setting the central store
  Without a path, \`set central_store\` uses the current folder. --path <dir>,
  or a path as the last argument, names another folder. When another folder
  is already the central store, the command warns and asks what to do:

    Cancel             Change nothing (the default answer).
    Move the store     Move every board of the old store into the new one, and
                       rewrite the pointer .lpm/config.yml of each project.
    Abandon            Use the new folder from now on. The old boards stay in
                       the old folder, and their projects still reach them.

  --move and --abandon answer without the question. Without a terminal and
  without one of them, the command fails and changes nothing. A move stops at
  the first board that fails: that board and the setting stay as they were,
  and running the command again moves the boards that are left.

The settings are in settings.json in the user folder: ~/.light-plan, or the
folder that LPM_HOME names. No board holds them, so they apply to every board
on this computer and are never committed.

\`lpm config get\` prints only the value, and exits 1 when the setting is not set,
so a script can read it.

Examples
  lpm config set central_store ~/boards
  lpm set central_store                       # this folder
  lpm set central_store --path ~/boards --move
  lpm config get central_store
  lpm config unset central_store
  lpm config set default_template kanban`;

interface Setting {
  /** The stored value, or null when the key is absent. */
  get(): string | null;
  /** Check and write the value. Returns the value that was stored. */
  set(value: string): string;
  unset(): void;
}

const settings: Record<string, Setting> = {
  central_store: {
    get: centralStorePath,
    set: setCentralStore,
    unset: unsetCentralStore,
  },
  default_template: {
    get: () => readUserSettings().default_template ?? null,
    set: (value) => {
      setDefaultBoardTemplate(value);
      return value;
    },
    unset: () => {
      const { default_template: _removed, ...rest } = readUserSettings();
      writeUserSettings(rest);
    },
  },
};

function settingFor(key: string | undefined): Setting {
  const known = Object.keys(settings);
  if (!key) throw new BoardError('Missing setting name', [`Known settings: ${known.join(', ')}`]);
  const setting = settings[key];
  if (!setting) throw new BoardError(`Unknown setting "${key}"`, [`Known settings: ${known.join(', ')}`]);
  return setting;
}

function list(): number {
  const width = Math.max(...Object.keys(settings).map((key) => key.length)) + 2;
  for (const [key, setting] of Object.entries(settings)) {
    const value = setting.get();
    out(`${pad(key, width)}${value ?? dim('(not set)')}`);
  }
  out(dim(`stored in ${userSettingsPath()}`));
  return 0;
}

type StoreChange = 'move' | 'abandon' | 'cancel';

/**
 * Where the central store goes, when another store is set: a flag answers,
 * else the person at the terminal, else the command fails and names the flags.
 */
function chooseStoreChange(previous: string, target: string, move: boolean, abandon: boolean): StoreChange {
  if (move && abandon) throw new BoardError('Pass --move or --abandon, not both');
  if (move) return 'move';
  if (abandon) return 'abandon';
  const boards = listCentralBoards().length;
  if (!process.stdin.isTTY) {
    throw new BoardError(`The central store is already ${previous}`, [
      `It holds ${boards} board(s). Choose what happens to them:`,
      `  --move     move every board to ${target}, and rewrite the pointer of each project`,
      '  --abandon  use the new folder, and leave the boards in the old one (their projects still reach them)',
    ]);
  }
  out(`${yellow('warning')} The central store is already ${previous}. It holds ${boards} board(s).`);
  return choose<StoreChange>(
    `Use ${target} as the central store?`,
    [
      { value: 'cancel', label: 'Cancel', detail: 'Change nothing.' },
      { value: 'move', label: 'Move the store', detail: `Move every board to ${target}, and rewrite the pointers.` },
      {
        value: 'abandon',
        label: 'Abandon the old store',
        detail: 'Use the new folder for new boards. The old boards stay where they are.',
      },
    ],
    '--move or --abandon',
  );
}

/** `lpm config set central_store [<dir>] [--path <dir>] [--move | --abandon]`. */
function setCentralStoreCommand(target: string, move: boolean, abandon: boolean): number {
  const previous = centralStorePath();
  if (previous === null || samePath(previous, target)) {
    const stored = setCentralStore(target);
    out(`${green('Set')} ${bold('central_store')} to ${stored}`);
    return 0;
  }
  const change = chooseStoreChange(previous, target, move, abandon);
  if (change === 'cancel') {
    out(dim(`Nothing changed. The central store is still ${previous}.`));
    return 0;
  }
  if (change === 'abandon') {
    const stored = abandonCentralStore(target);
    out(`${green('Set')} ${bold('central_store')} to ${stored}`);
    out(dim(`  The boards in ${previous} stay there. Their projects still reach them, and \`lpm projects\` lists them.`));
    return 0;
  }
  const result = moveCentralStore(target);
  for (const board of result.moved) {
    out(`${green('Moved')} ${board.name} to ${board.to}`);
    if (!board.pointerUpdated) out(dim(`  no project points at it: no pointer was rewritten`));
    for (const warning of board.warnings) out(`${yellow('warning')} ${warning}`);
  }
  if (result.failure) {
    throw new BoardError(`Could not move the board ${result.failure.name}: ${result.failure.message}`, [
      `The central store is still ${previous}. ${result.moved.length} board(s) moved already.`,
      'Run the same command again to move the boards that are left.',
    ]);
  }
  for (const folder of result.leftBehind) out(`${yellow('left')} ${folder} ${dim('holds no board and was not moved')}`);
  out(`${green('Set')} ${bold('central_store')} to ${result.store}`);
  return 0;
}

export function run(args: string[]): number {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { path: { type: 'string' }, move: { type: 'boolean' }, abandon: { type: 'boolean' } },
  });
  const [action, key, value, ...rest] = positionals;

  if (action === 'set' && key === 'central_store') {
    if (rest.length || (value !== undefined && values.path !== undefined)) {
      throw new BoardError('Name the folder once: as the last argument, or with --path');
    }
    const target = path.resolve(expandHome(values.path ?? value ?? process.cwd()));
    return setCentralStoreCommand(target, values.move === true, values.abandon === true);
  }
  if (values.path !== undefined || values.move || values.abandon) {
    throw new BoardError('--path, --move and --abandon apply to `lpm config set central_store` only');
  }

  if (action === undefined) return list();
  if (action === 'get') {
    const stored = settingFor(key).get();
    if (stored === null) return 1;
    out(stored);
    return 0;
  }
  if (action === 'set') {
    const setting = settingFor(key);
    if (value === undefined || rest.length) {
      throw new BoardError(`lpm config set ${key} needs one value`, [`Usage: lpm config set ${key} <value>`]);
    }
    const stored = setting.set(value);
    out(`${green('Set')} ${bold(key!)} to ${stored}`);
    return 0;
  }
  if (action === 'unset') {
    settingFor(key).unset();
    out(`${green('Unset')} ${bold(key!)}`);
    return 0;
  }
  throw new BoardError(`Unknown action "${action}"`, ['Use get, set or unset. Run lpm config --help.']);
}
