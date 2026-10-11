import { spawn } from 'node:child_process';
import path from 'node:path';
import { BoardError } from '../core/index.js';

/**
 * Asking the desktop of this machine to open a file, or to show it in the file
 * manager.
 *
 * `lpm ui` runs on the machine of the person who uses it, so the server can
 * start the program that the desktop uses for a file. The web app cannot: a
 * browser page has no access to the file system.
 *
 * The routes that call this module pass a path that the server chose, never a
 * path from the request. A route that took the path from the request would let
 * any page that reaches the port start a program on any file.
 *
 * `desktopCommand` is pure, so a test checks the command of each platform
 * without starting one. `launch` starts the command detached and reports only
 * whether it started: the editor or the file manager stays open after the
 * request ends.
 */

export type DesktopAction = 'open' | 'reveal';

export interface DesktopCommand {
  command: string;
  args: string[];
  /** Windows only: hand the arguments to the program as written, with no quoting by Node. */
  verbatim?: boolean;
}

/**
 * The command that opens `file` with the program that the desktop uses for its
 * type (`open`), or that shows `file` in the file manager (`reveal`).
 *
 * | Platform | `open` | `reveal` |
 * | --- | --- | --- |
 * | Windows | `cmd /c start "" <file>` | `explorer.exe /select,"<file>"` |
 * | macOS | `open <file>` | `open -R <file>` |
 * | other | `xdg-open <file>` | `xdg-open <folder>` |
 *
 * `xdg-open` cannot select a file, so on Linux `reveal` opens the folder.
 */
export function desktopCommand(
  action: DesktopAction,
  file: string,
  platform: NodeJS.Platform = process.platform,
): DesktopCommand {
  if (platform === 'win32') {
    return action === 'open'
      ? // The empty string is the window title that `start` takes first.
        { command: 'cmd', args: ['/c', 'start', '""', `"${file}"`], verbatim: true }
      : // Explorer reads the path only in this spelling, with the quotes after the comma.
        { command: 'explorer.exe', args: [`/select,"${file}"`], verbatim: true };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: action === 'open' ? [file] : ['-R', file] };
  }
  return { command: 'xdg-open', args: [action === 'open' ? file : path.dirname(file)] };
}

/** Starts a desktop command. Resolves when the program started, and rejects when it did not. */
export type DesktopLauncher = (command: DesktopCommand) => Promise<void>;

export const launch: DesktopLauncher = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      stdio: 'ignore',
      detached: true,
      windowsVerbatimArguments: command.verbatim === true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

/** Open a file or show it in the file manager. A program that does not start is a `BoardError` with the path. */
export async function onDesktop(
  action: DesktopAction,
  file: string,
  launcher: DesktopLauncher = launch,
): Promise<void> {
  const command = desktopCommand(action, file);
  try {
    await launcher(command);
  } catch (error) {
    throw new BoardError(
      action === 'open' ? 'Could not open the file' : 'Could not show the file in the file manager',
      [
        `The command "${command.command}" did not start: ${(error as Error).message}`,
        `The file is ${file}`,
      ],
    );
  }
}
