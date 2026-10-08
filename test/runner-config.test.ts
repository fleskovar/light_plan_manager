import { describe, expect, it } from 'vitest';
import { parseAgentConfigText } from '../src/runner/index.js';

describe('the queue agent config file', () => {
  it('reads a full config', () => {
    const { config, errors } = parseAgentConfigText(
      [
        'user: alice',
        'maxTasks: 5',
        'model: anthropic:claude-opus-4-5',
        'effort: high',
        'commit: parent',
        'unassigned: true',
        'timeout: 600',
        'commandTimeout: 120',
        'tools: [read, bash, edit, write]',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
    expect(config).toEqual({
      user: 'alice',
      maxTasks: 5,
      model: 'anthropic:claude-opus-4-5',
      effort: 'high',
      commit: 'parent',
      unassigned: true,
      timeout: 600,
      commandTimeout: 120,
      tools: ['read', 'bash', 'edit', 'write'],
    });
  });

  it('rejects a non-positive commandTimeout', () => {
    expect(parseAgentConfigText('commandTimeout: 0').config).toBeNull();
    expect(parseAgentConfigText('commandTimeout: -5').config).toBeNull();
  });

  it('treats an empty file as a config that sets nothing', () => {
    const { config, errors } = parseAgentConfigText('');
    expect(errors).toEqual([]);
    expect(config).toEqual({});
  });

  it('rejects an unknown effort', () => {
    const { config, errors } = parseAgentConfigText('effort: turbo');
    expect(config).toBeNull();
    expect(errors.join(' ')).toContain('effort');
  });

  it('rejects an unknown commit mode', () => {
    const { config, errors } = parseAgentConfigText('commit: sometimes');
    expect(config).toBeNull();
    expect(errors.join(' ')).toContain('commit');
  });

  it('rejects an unknown key rather than ignoring it', () => {
    const { config, errors } = parseAgentConfigText('modle: anthropic:opus');
    expect(config).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-positive maxTasks', () => {
    expect(parseAgentConfigText('maxTasks: 0').config).toBeNull();
    expect(parseAgentConfigText('maxTasks: 2.5').config).toBeNull();
  });

  it('reports invalid YAML rather than throwing', () => {
    const { config, errors } = parseAgentConfigText('user: [unclosed');
    expect(config).toBeNull();
    expect(errors[0]).toContain('invalid YAML');
  });
});
