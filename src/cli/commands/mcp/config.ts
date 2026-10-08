import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoardError } from '../../../core/index.js';

/**
 * Writing an MCP host's configuration for this board.
 *
 * Hosts disagree about two things and agree about everything else: the key the
 * servers live under (`mcpServers` for Claude Desktop, Claude Code and Cursor;
 * `servers` for VS Code), and where the file lives. So the shape is detected
 * from whatever file is being edited rather than guessed, and the path is the
 * caller's to choose.
 */
export interface ServerEntry {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export type ServerKey = 'mcpServers' | 'servers';

export const DEFAULT_SERVER_NAME = 'light-plan';
/** Claude Code's project-scoped file, committed with the repository. */
export const DEFAULT_CONFIG_FILE = '.mcp.json';

/**
 * How to launch `lpm mcp`.
 *
 * `lpm` is used when it is on the PATH, which is the normal case and the one
 * that survives the repository moving. Otherwise the absolute path to this
 * checkout's built CLI is written, so the config still works — with a warning,
 * because that path is machine-specific.
 *
 * Not under `npx light-plan`, though: then "this checkout" is npm's `_npx` cache,
 * which npm clears whenever it likes, and a config pointing into it breaks a
 * week later with nothing to say why. The host runs `npx` itself instead —
 * through `cmd /c` on Windows, where `npx` is a `.cmd` shim a host spawning
 * without a shell cannot start.
 */
export function launchCommand(
  onPath: boolean,
  entry = fileURLToPath(new URL('../../index.js', import.meta.url)),
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (onPath) return { command: 'lpm', args: ['mcp'] };
  if (isNpxCache(entry)) {
    const npx = ['npx', '-y', 'light-plan', 'mcp'];
    return platform === 'win32'
      ? { command: 'cmd', args: ['/c', ...npx] }
      : { command: npx[0]!, args: npx.slice(1) };
  }
  return { command: process.execPath, args: [entry, 'mcp'] };
}

/** Is `lpm` runnable by name? If not, a config has to say how else to start it. */
export function lpmOnPath(): boolean {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(finder, ['lpm'], { encoding: 'utf8' });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

/** Is this file inside the cache `npx` runs packages from? */
export function isNpxCache(file: string): boolean {
  return file.split(/[\\/]/).includes('_npx');
}

export function buildEntry(options: {
  onPath: boolean;
  root: string;
  user?: string;
  profile?: string;
  readOnly?: boolean;
  allowRemote?: boolean;
}): ServerEntry {
  const { command, args } = launchCommand(options.onPath);
  const env: Record<string, string> = {};
  if (options.user) env.LPM_USER = options.user;
  if (options.profile) env.LPM_PROFILE = path.resolve(options.profile);
  if (options.readOnly) args.push('--read-only');
  if (options.allowRemote) args.push('--allow-remote');
  return { command, args, env: Object.keys(env).length ? env : undefined, cwd: options.root };
}

export interface HostConfig {
  /** The parsed document, with the server key guaranteed to exist. */
  data: Record<string, unknown>;
  key: ServerKey;
  servers: Record<string, unknown>;
}

/**
 * Read a host config, or start an empty one. Detects which key it uses; a file
 * that does not exist yet gets `preferred`, which is the only thing the harnesses
 * disagree about when there is nothing to follow.
 */
export function readConfig(file: string | null, preferred: ServerKey = 'mcpServers'): HostConfig {
  if (!file || !existsSync(file)) {
    return { data: {}, key: preferred, servers: {} };
  }

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new BoardError(`Could not read ${file}`, [(error as Error).message]);
  }

  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    throw new BoardError(`${file} is not valid JSON`, [
      (error as Error).message,
      'Fix it, or point --file somewhere else.',
    ]);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BoardError(`${file} does not hold a JSON object`);
  }

  const data = parsed as Record<string, unknown>;
  // VS Code calls it `servers`; everyone else calls it `mcpServers`. Follow
  // whatever the file already does rather than adding a second key to it.
  const key: ServerKey =
    data.servers !== undefined && data.mcpServers === undefined
      ? 'servers'
      : data.mcpServers !== undefined
        ? 'mcpServers'
        : preferred;
  const existing = data[key];
  const servers =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};

  return { data, key, servers };
}

export interface MergeResult {
  /** The document to write. */
  data: Record<string, unknown>;
  /** True when an entry of this name was already there and was replaced. */
  replaced: boolean;
}

export function mergeEntry(
  config: HostConfig,
  name: string,
  entry: ServerEntry,
  force: boolean,
): MergeResult {
  const replaced = name in config.servers;
  if (replaced && !force) {
    throw new BoardError(`"${name}" is already configured`, [
      'Pass --force to replace it, or --name <other> to add a second entry.',
    ]);
  }
  return {
    data: { ...config.data, [config.key]: { ...config.servers, [name]: entry } },
    replaced,
  };
}

export function serialize(data: Record<string, unknown>): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Where to write when the caller named no file. */
export function defaultConfigPath(root: string): string {
  return path.join(root, DEFAULT_CONFIG_FILE);
}
