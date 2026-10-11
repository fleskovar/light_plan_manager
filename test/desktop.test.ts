import { describe, expect, it } from 'vitest';
import { BoardError } from '../src/core/index.js';
import { desktopCommand, launch, onDesktop, type DesktopCommand } from '../src/server/desktop.js';

/**
 * Opening a file on the desktop, and showing it in the file manager. No case
 * opens an editor or a file manager: the command of each platform is checked
 * as data, and `launch` runs Node itself.
 */

describe('desktopCommand', () => {
  it('opens a file with `start` on Windows, with the path in quotes for a space', () => {
    expect(desktopCommand('open', 'C:\my board\.lpm\config.yml', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '""', '"C:\my board\.lpm\config.yml"'],
      verbatim: true,
    });
  });

  it('selects the file in Explorer on Windows', () => {
    expect(desktopCommand('reveal', 'C:\my board\.lpm\config.yml', 'win32')).toEqual({
      command: 'explorer.exe',
      args: ['/select,"C:\my board\.lpm\config.yml"'],
      verbatim: true,
    });
  });

  it('uses `open` on macOS, with -R to show the file in Finder', () => {
    expect(desktopCommand('open', '/work/.lpm/config.yml', 'darwin')).toEqual({
      command: 'open',
      args: ['/work/.lpm/config.yml'],
    });
    expect(desktopCommand('reveal', '/work/.lpm/config.yml', 'darwin').args).toEqual([
      '-R',
      '/work/.lpm/config.yml',
    ]);
  });

  it('uses `xdg-open` elsewhere, and opens the folder because it cannot select a file', () => {
    expect(desktopCommand('open', '/work/.lpm/config.yml', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/work/.lpm/config.yml'],
    });
    expect(desktopCommand('reveal', '/work/.lpm/config.yml', 'linux').args).toHaveLength(1);
    expect(desktopCommand('reveal', '/work/.lpm/config.yml', 'linux').args[0]).not.toContain('config.yml');
  });
});

describe('launch', () => {
  it('resolves when the program starts, and rejects when it does not exist', async () => {
    await expect(launch({ command: process.execPath, args: ['-e', '0'] })).resolves.toBeUndefined();
    await expect(launch({ command: 'lpm-no-such-program', args: [] })).rejects.toThrow();
  });
});

describe('onDesktop', () => {
  it('passes the command of this platform to the launcher', async () => {
    const started: DesktopCommand[] = [];
    await onDesktop('open', '/work/.lpm/config.yml', async (command) => {
      started.push(command);
    });
    expect(started).toEqual([desktopCommand('open', '/work/.lpm/config.yml')]);
  });

  it('answers a BoardError with the path when the program does not start', async () => {
    const failing = async (): Promise<void> => {
      throw new Error('spawn xdg-open ENOENT');
    };
    const error = await onDesktop('reveal', '/work/.lpm/config.yml', failing).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BoardError);
    expect((error as BoardError).message).toBe('Could not show the file in the file manager');
    expect((error as BoardError).details.at(-1)).toBe('The file is /work/.lpm/config.yml');
  });
});
