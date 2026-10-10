import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BoardError,
  USER_HOME_ENV_VAR,
  builtinTemplatePath,
  defaultBoardTemplate,
  editBoardConfig,
  initBoard,
  listBoardTemplates,
  loadConfig,
  removeBoardTemplate,
  saveBoardTemplate,
  setDefaultBoardTemplate,
  userTemplatePath,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard } from './helpers.js';

/**
 * Board templates in the user folder. Each case gets its own folder through
 * `LPM_HOME`, so no case reads or writes `~/.light-plan`.
 */
const previousHome = process.env[USER_HOME_ENV_VAR];
let home: string;
const roots: string[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'lpm-home-'));
  process.env[USER_HOME_ENV_VAR] = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  if (previousHome === undefined) delete process.env[USER_HOME_ENV_VAR];
  else process.env[USER_HOME_ENV_VAR] = previousHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupBoards();
});

function emptyRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
  roots.push(root);
  return root;
}

const names = (): string[] => listBoardTemplates().map((template) => `${template.source}:${template.name}`);

describe('saving a board config as a template', () => {
  it('writes templates/<name>.yml in the user folder and lists it after the built-in templates', () => {
    const paths = makeBoard('scrum', 'LP');
    const result = saveBoardTemplate(paths, 'team-flow');

    expect(result.file).toBe(path.join(home, 'templates', 'team-flow.yml'));
    expect(result.replaced).toBe(false);
    expect(names()).toEqual(['builtin:scrum', 'builtin:kanban', 'builtin:blank', 'user:team-flow']);
  });

  it('leaves out the keys that describe one board', () => {
    const paths = makeBoard('scrum', 'LP', { omni: true, planning: 'queue' });
    appendFileSync(
      paths.configPath,
      ['', 'remotes:', '  tracker:', '    provider: jsonfile', '    conflict: manual', ''].join('\n'),
    );
    expect(readFileSync(paths.configPath, 'utf8')).toMatch(/^default_period: TL-2$/m);

    saveBoardTemplate(paths, 'team-flow');

    const text = readFileSync(userTemplatePath('team-flow'), 'utf8');
    for (const key of ['remotes', 'default_period', 'planning', 'git_sync']) {
      expect(text).not.toMatch(new RegExp(`^${key}:`, 'm'));
    }
    expect(text).toMatch(/^issue_types:$/m);
    expect(text).toMatch(/^statuses:$/m);
  });

  it('keeps the guide to remotes that the shipped config ends with, and drops the comments of the removed keys', () => {
    const paths = makeBoard('scrum', 'LP', { omni: true, planning: 'queue' });
    appendFileSync(
      paths.configPath,
      ['', 'remotes:', '  tracker:', '    provider: jsonfile', '    conflict: manual', ''].join('\n'),
    );

    saveBoardTemplate(paths, 'team-flow');

    const text = readFileSync(userTemplatePath('team-flow'), 'utf8');
    expect(text).toContain('# Remotes — mirror this board onto an external tracker');
    expect(text).not.toContain('# The catch-all every new issue is scheduled in');
    expect(text).not.toContain('# Work the board as one continuous queue');
  });

  it('gives back the shipped template when the board changed nothing', () => {
    const paths = makeBoard('scrum', 'LP', { omni: true, planning: 'queue' });
    saveBoardTemplate(paths, 'copy');

    const shipped = readFileSync(builtinTemplatePath('scrum'), 'utf8');
    expect(readFileSync(userTemplatePath('copy'), 'utf8').trimEnd()).toBe(shipped.trimEnd());
  });

  it('starts a new board with the types that the saved board had', () => {
    const paths = makeBoard('scrum', 'LP');
    editBoardConfig(paths, [
      { op: 'update-type', kind: 'issue', type: 'epic', name: 'milestone', label: 'Milestone' },
    ]);
    saveBoardTemplate(paths, 'milestones');

    const created = initBoard({ root: emptyRoot(), template: 'milestones', prefix: 'NB', git: false });

    const config = loadConfig(created.paths).config!;
    expect(created.template).toBe('milestones');
    expect(config.key_prefix).toBe('NB');
    expect(config.issue_types.milestone?.label).toBe('Milestone');
    expect(config.hierarchy[1]).toEqual(['milestone']);
  });

  it('refuses the name of a built-in template, an invalid name, and a second save without `overwrite`', () => {
    const paths = makeBoard('scrum', 'LP');
    expect(() => saveBoardTemplate(paths, 'scrum')).toThrow('"scrum" is a built-in template');
    expect(() => saveBoardTemplate(paths, '../escape')).toThrow('Invalid template name');

    saveBoardTemplate(paths, 'team-flow');
    expect(() => saveBoardTemplate(paths, 'team-flow')).toThrow(BoardError);
    expect(saveBoardTemplate(paths, 'team-flow', { overwrite: true }).replaced).toBe(true);
  });
});

describe('the default template', () => {
  it('is scrum when settings.json has no key `default_template`', () => {
    expect(defaultBoardTemplate()).toBe('scrum');
  });

  it('is the template that `setDefaultBoardTemplate` wrote, and `initBoard` uses it', () => {
    setDefaultBoardTemplate('kanban');

    expect(JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8'))).toEqual({
      default_template: 'kanban',
    });
    expect(defaultBoardTemplate()).toBe('kanban');
    expect(initBoard({ root: emptyRoot(), git: false }).template).toBe('kanban');
  });

  it('refuses a name that no template has', () => {
    expect(() => setDefaultBoardTemplate('nope')).toThrow('No board template called "nope"');
  });

  it('falls back to scrum when the chosen template was deleted by hand', () => {
    const paths = makeBoard('kanban', 'LP');
    saveBoardTemplate(paths, 'team-flow');
    setDefaultBoardTemplate('team-flow');
    rmSync(userTemplatePath('team-flow'));

    expect(defaultBoardTemplate()).toBe('scrum');
  });

  it('is cleared when `removeBoardTemplate` deletes the chosen template', () => {
    const paths = makeBoard('kanban', 'LP');
    saveBoardTemplate(paths, 'team-flow');
    setDefaultBoardTemplate('team-flow');

    removeBoardTemplate('team-flow');

    expect(existsSync(userTemplatePath('team-flow'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8'))).toEqual({});
    expect(() => removeBoardTemplate('scrum')).toThrow('built-in template');
  });

  it('ignores a settings.json that is not JSON', () => {
    writeFileSync(path.join(home, 'settings.json'), 'not json', 'utf8');
    expect(defaultBoardTemplate()).toBe('scrum');
  });
});
