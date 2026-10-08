import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * `lpm agent` against the built CLI, because what it does *is* the filesystem:
 * where each harness wants its files, and the promise that installing into
 * somebody's project never destroys what was already there.
 */
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

const dirs: string[] = [];
let cwd: string;
let home: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), 'lpm-agent-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'lpm-home-'));
  dirs.push(cwd, home);
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function lpm(...args: string[]): { status: number; stdout: string; all: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    // A sandboxed home, so a --global test can never touch the real one.
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData'),
      COPILOT_HOME: path.join(home, '.copilot'),
    },
  });
  const stdout = result.stdout ?? '';
  return { status: result.status ?? 0, stdout, all: stdout + (result.stderr ?? '') };
}

const read = (...segments: string[]): string => readFileSync(path.join(cwd, ...segments), 'utf8');
const has = (...segments: string[]): boolean => existsSync(path.join(cwd, ...segments));

/** The frontmatter of an installed asset, as a raw string. */
function frontmatter(...segments: string[]): string {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(read(...segments))![1]!;
}

describe('lpm agent', () => {
  it('installs the Claude Code layout into a fresh project', () => {
    const run = lpm('agent', '--target', 'claude', '--project');
    expect(run.status).toBe(0);

    expect(has('.claude', 'agents', 'lpm-developer.md')).toBe(true);
    expect(has('.claude', 'agents', 'lpm-planner.md')).toBe(true);
    expect(has('.claude', 'skills', 'lpm', 'SKILL.md')).toBe(true);
    expect(has('.mcp.json')).toBe(true);

    // Claude wants a name and a comma-joined tool list; the body travels verbatim.
    const front = frontmatter('.claude', 'agents', 'lpm-developer.md');
    expect(front).toMatch(/^name: lpm-developer$/m);
    expect(front).toMatch(/mcp__light-plan__next_tasks/);
    expect(read('.claude', 'skills', 'lpm', 'SKILL.md')).toContain('# Working a light-plan board');

    const config = JSON.parse(read('.mcp.json')) as { mcpServers: Record<string, { args: string[] }> };
    expect(config.mcpServers['light-plan']!.args).toEqual(['mcp']);
  });

  /** .github/agents/*.agent.md and .github/skills/<name>/SKILL.md, per the CLI config reference. */
  it('installs the Copilot layout, with its own file names and frontmatter', () => {
    expect(lpm('agent', '--target', 'copilot', '--project').status).toBe(0);

    expect(has('.github', 'agents', 'lpm-developer.agent.md')).toBe(true);
    expect(has('.github', 'skills', 'lpm', 'SKILL.md')).toBe(true);
    expect(has('.github', 'copilot-instructions.md')).toBe(true);

    // Copilot's tool vocabulary is its own, so Claude's tool list must not
    // travel: an agent naming tools that do not exist is worse off than one
    // with the default set.
    const front = frontmatter('.github', 'agents', 'lpm-developer.agent.md');
    expect(front).toMatch(/^name: lpm-developer$/m);
    expect(front).toMatch(/^description:/m);
    expect(front).not.toMatch(/mcp__light-plan__/);

    // Copilot reads project MCP servers from .mcp.json, in the standard format.
    const config = JSON.parse(read('.mcp.json')) as Record<string, unknown>;
    expect(Object.keys(config)).toEqual(['mcpServers']);
  });

  /** Reasonix has one directory for both, and marks subagents in frontmatter. */
  it('installs the Reasonix layout as slash commands', () => {
    const run = lpm('agent', '--target', 'deepseek', '--project');
    expect(run.status).toBe(0);

    expect(has('.reasonix', 'commands', 'lpm-developer.md')).toBe(true);
    expect(has('.reasonix', 'commands', 'lpm.md')).toBe(true);
    expect(has('.mcp.json')).toBe(true);

    expect(frontmatter('.reasonix', 'commands', 'lpm-developer.md')).toMatch(/^runAs: subagent$/m);
    // A skill is a plain command: nothing marks it as a subagent profile.
    expect(frontmatter('.reasonix', 'commands', 'lpm.md')).not.toMatch(/runAs/);
  });

  /** All three read .mcp.json, so a project set up for all of them has one. */
  it('shares one project MCP config across the targets that read it', () => {
    lpm('agent', '--target', 'claude', '--project');
    const after = lpm('agent', '--target', 'copilot', '--project');

    expect(after.all).toMatch(/= \.mcp\.json|\.mcp\.json/);
    const config = JSON.parse(read('.mcp.json')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(config.mcpServers)).toEqual(['light-plan']);
  });

  it('prints what to add by hand when a target keeps MCP somewhere we will not rewrite', () => {
    const run = lpm('agent', '--target', 'reasonix', '--global', '--type', 'pm');
    expect(run.status).toBe(0);
    expect(existsSync(path.join(home, '.reasonix', 'commands', 'lpm-planner.md'))).toBe(true);
    // config.toml is somebody's file and this package cannot merge TOML.
    expect(run.all).toMatch(/\[\[plugins\]\]/);
    expect(run.all).toMatch(/config\.toml/);
  });

  it('filters what it installs by --type', () => {
    expect(lpm('agent', '--target', 'claude', '--project', '--type', 'developer').status).toBe(0);

    expect(has('.claude', 'agents', 'lpm-developer.md')).toBe(true);
    expect(has('.claude', 'agents', 'lpm-planner.md')).toBe(false);
    expect(has('.claude', 'skills', 'lpm-delivery', 'SKILL.md')).toBe(true);
    expect(has('.claude', 'skills', 'lpm-planning', 'SKILL.md')).toBe(false);
    // The hub skill belongs to both roles.
    expect(has('.claude', 'skills', 'lpm', 'SKILL.md')).toBe(true);
  });

  it('merges into an existing MCP config instead of replacing it', () => {
    writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({ inputs: [{ id: 'tok' }], mcpServers: { 'our-db': { command: 'db-mcp' } } }),
      'utf8',
    );

    expect(lpm('agent', '--target', 'copilot', '--project').status).toBe(0);

    const config = JSON.parse(read('.mcp.json')) as {
      inputs: unknown[];
      mcpServers: Record<string, unknown>;
    };
    expect(config.inputs).toEqual([{ id: 'tok' }]);
    expect(config.mcpServers['our-db']).toEqual({ command: 'db-mcp' });
    expect(config.mcpServers['light-plan']).toBeDefined();
  });

  /** A file already using `servers` keeps it, rather than growing a second key. */
  it('follows the key an existing config already uses', () => {
    mkdirSync(path.join(cwd, '.vscode'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({ servers: { 'our-db': { command: 'db-mcp' } } }),
      'utf8',
    );

    lpm('agent', '--target', 'copilot', '--project');

    const config = JSON.parse(read('.mcp.json')) as Record<string, Record<string, unknown>>;
    expect(Object.keys(config)).toEqual(['servers']);
    expect(Object.keys(config.servers!)).toEqual(['our-db', 'light-plan']);
  });

  it('appends one delimited block to an instructions file it does not own', () => {
    mkdirSync(path.join(cwd, '.github'), { recursive: true });
    writeFileSync(path.join(cwd, '.github', 'copilot-instructions.md'), '# Ours\n\nUse tabs.\n', 'utf8');

    lpm('agent', '--target', 'copilot', '--project');
    lpm('agent', '--target', 'copilot', '--project');

    const text = read('.github', 'copilot-instructions.md');
    expect(text).toContain('# Ours');
    expect(text).toContain('Use tabs.');
    // Re-running replaces the block where it stands rather than stacking another.
    expect(text.match(/<!-- lpm:begin -->/g)).toHaveLength(1);
    expect(text).toContain('light-plan');
  });

  it('never overwrites an edited file without --force', () => {
    lpm('agent', '--target', 'claude', '--project');
    const file = path.join(cwd, '.claude', 'agents', 'lpm-developer.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nMY OWN NOTES\n`, 'utf8');

    const again = lpm('agent', '--target', 'claude', '--project');
    expect(again.all).toMatch(/already exists; pass --force/);
    expect(readFileSync(file, 'utf8')).toContain('MY OWN NOTES');

    const forced = lpm('agent', '--target', 'claude', '--project', '--force');
    expect(forced.all).toMatch(/1 files? written/);
    expect(readFileSync(file, 'utf8')).not.toContain('MY OWN NOTES');
  });

  it('reports an unchanged install as doing nothing', () => {
    lpm('agent', '--target', 'claude', '--project');
    const again = lpm('agent', '--target', 'claude', '--project');
    // Only the MCP entry is "skipped"; every asset is byte-identical.
    expect(again.all).toMatch(/0 files written/);
  });

  it('writes nothing with --dry-run', () => {
    const run = lpm('agent', '--target', 'claude', '--project', '--dry-run');
    expect(run.status).toBe(0);
    expect(run.all).toMatch(/would change/);
    expect(has('.claude')).toBe(false);
    expect(has('.mcp.json')).toBe(false);
  });

  it('leaves the MCP config alone with --no-mcp', () => {
    expect(lpm('agent', '--target', 'claude', '--project', '--no-mcp').status).toBe(0);
    expect(has('.claude', 'agents', 'lpm-developer.md')).toBe(true);
    expect(has('.mcp.json')).toBe(false);
  });

  it('forwards --user and --profile into the MCP entry', () => {
    lpm('agent', '--target', 'claude', '--project', '--user', 'Planner Bot', '--name', 'planner');
    const config = JSON.parse(read('.mcp.json')) as {
      mcpServers: Record<string, { args: string[]; env?: Record<string, string> }>;
    };
    const entry = config.mcpServers['planner']!;
    expect(entry.args).toEqual(['mcp']);
    expect(entry.env).toEqual({ LPM_USER: 'Planner Bot' });
  });

  it('installs for the user account, without pinning one project', () => {
    const run = lpm('agent', '--target', 'claude', '--global', '--type', 'pm');
    expect(run.status).toBe(0);

    expect(existsSync(path.join(home, '.claude', 'agents', 'lpm-planner.md'))).toBe(true);
    expect(existsSync(path.join(home, '.claude', 'skills', 'lpm', 'SKILL.md'))).toBe(true);
    // Nothing landed in the project.
    expect(has('.claude')).toBe(false);

    const config = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, { cwd?: string }>;
    };
    expect(config.mcpServers['light-plan']!.cwd).toBeUndefined();
  });

  it('warns when the project has no board to work on', () => {
    expect(lpm('agent', '--target', 'claude', '--project').all).toMatch(/no \.lpm board found/);
  });

  it('lists the files it ships and the copy rules that place them', () => {
    const run = lpm('agent', '--list');
    expect(run.status).toBe(0);

    // Source files, by their path in the neutral tree.
    expect(run.stdout).toContain('agents/lpm-developer.md');
    expect(run.stdout).toContain('skills/lpm-planning.md');

    // And each harness's rules as patterns, not as hard-coded paths.
    for (const harness of ['claude', 'copilot', 'reasonix']) {
      expect(run.stdout).toContain(harness);
    }
    expect(run.stdout).toContain('skills/*.md');
    expect(run.stdout).toContain('{root}/skills/{name}/SKILL.md');
  });

  it('refuses to guess', () => {
    expect(lpm('agent', '--project').all).toMatch(/Pass --target/);
    expect(lpm('agent', '--target', 'emacs', '--project').all).toMatch(/Unknown --target/);
    expect(lpm('agent', '--target', 'claude', '--project', '--type', 'architect').all).toMatch(
      /Unknown --type/,
    );
    expect(lpm('agent', '--target', 'claude', '--project', '--global').all).toMatch(
      /one of --project and --global/,
    );
    // With no terminal to ask, the scope has to be stated rather than assumed.
    const asked = lpm('agent', '--target', 'claude');
    expect(asked.status).toBe(1);
    expect(asked.all).toMatch(/no terminal to ask/);
  });
});
