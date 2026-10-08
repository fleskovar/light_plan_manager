import { describe, expect, it } from 'vitest';
import { NON_INTERACTIVE_ENV, blockedCommand, refusalFor } from '../src/runner/index.js';

/**
 * The guard between an unattended agent run and a command that waits for a
 * person. Every case here is one that stopped a real run, or one that must not
 * be refused because a run needs it.
 */

describe('blockedCommand', () => {
  it('refuses the openers that hand a file to another program', () => {
    for (const command of [
      'start README.md',
      'open docs/plan.md',
      'xdg-open report.html',
      'explorer.exe .',
      'code src/index.ts',
      'notepad notes.txt',
      'wslview index.html',
    ]) {
      expect(blockedCommand(command), command).not.toBeNull();
    }
  });

  it('refuses the programs that take the terminal over', () => {
    for (const command of ['less CHANGELOG.md', 'man git', 'vim src/a.ts', 'top', 'more x.txt']) {
      expect(blockedCommand(command), command).not.toBeNull();
    }
  });

  it('looks past a path, an extension and a prefix', () => {
    expect(blockedCommand('/usr/bin/less file')).not.toBeNull();
    expect(blockedCommand('C:\\Windows\\explorer.exe .')).not.toBeNull();
    expect(blockedCommand('sudo vim /etc/hosts')).not.toBeNull();
    expect(blockedCommand('FOO=bar nohup code .')).not.toBeNull();
  });

  it('reads every segment of a command line, not just the first', () => {
    expect(blockedCommand('npm test && open coverage/index.html')).not.toBeNull();
    expect(blockedCommand('git diff; less')).not.toBeNull();
    expect(blockedCommand('cat file.md | less')).not.toBeNull();
    expect(blockedCommand('ls\nstart notes.md')).not.toBeNull();
  });

  it('catches the ones whose first word is innocent', () => {
    expect(blockedCommand('powershell -Command "Start-Process report.md"')).not.toBeNull();
    expect(blockedCommand('tail -f server.log')).not.toBeNull();
    expect(blockedCommand('git add -p src/')).not.toBeNull();
    expect(blockedCommand('git rebase --interactive HEAD~3')).not.toBeNull();
  });

  it('leaves ordinary work alone', () => {
    for (const command of [
      'npm test',
      'npm run build && npm run typecheck',
      'git status --porcelain',
      'git log --oneline -n 5',
      'git add -A',
      'git commit -m "fix: the thing"',
      'git checkout -b feature/x',
      'git checkout -- src/some-file-zip.txt',
      'grep -rn "start" src/',
      'node --version',
      'tail -n 20 server.log',
      'cat README.md',
      'ls -la',
    ]) {
      expect(blockedCommand(command), command).toBeNull();
    }
  });

  it('says what was refused, so the agent can do something else', () => {
    const reason = blockedCommand('start report.md');
    expect(reason).toContain('start');
    const refusal = refusalFor(reason!);
    expect(refusal).toContain('exit 1');
    expect(refusal).toContain('read tool');
    // Single-quoted for sh, so nothing in the message can run.
    expect(refusal.match(/'/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('quotes a reason containing an apostrophe without breaking the shell', () => {
    const refusal = refusalFor("it's a window");
    expect(refusal).toContain(`'\\''`);
  });
});

describe('NON_INTERACTIVE_ENV', () => {
  it('turns off the three things that wait for a person', () => {
    expect(NON_INTERACTIVE_ENV.PAGER).toBe('cat');
    expect(NON_INTERACTIVE_ENV.GIT_PAGER).toBe('cat');
    expect(NON_INTERACTIVE_ENV.GIT_EDITOR).toBe('true');
    expect(NON_INTERACTIVE_ENV.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('answers $EDITOR and $VISUAL, which is what `lpm open` spawns', () => {
    expect(NON_INTERACTIVE_ENV.EDITOR).toBe('true');
    expect(NON_INTERACTIVE_ENV.VISUAL).toBe('true');
  });

  it('says it is CI, which is what stops a test runner starting in watch mode', () => {
    expect(NON_INTERACTIVE_ENV.CI).toBe('true');
  });

  it('is all strings, because it is spread into a process environment', () => {
    for (const [key, value] of Object.entries(NON_INTERACTIVE_ENV)) {
      expect(typeof value, key).toBe('string');
    }
  });
});
