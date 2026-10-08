import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { AGENT_EFFORTS, COMMIT_MODES } from './types.js';
import type { AgentConfig } from './types.js';

/**
 * The `--file config.yml` loader for `lpm queue agent`.
 *
 * Mirrors `parseConfigText` in the engine: YAML → zod → a `{ config, errors }`
 * result that never throws, so the command can report every problem at once. It
 * is deliberately its own tiny schema rather than a reach into `core/config`,
 * because an agent run is a front-end concern and the board config is not.
 */

const schema = z
  .object({
    user: z.string().optional(),
    maxTasks: z.number().int().positive().optional(),
    model: z.string().optional(),
    effort: z.enum(AGENT_EFFORTS as unknown as [string, ...string[]]).optional(),
    commit: z.enum(COMMIT_MODES as unknown as [string, ...string[]]).optional(),
    unassigned: z.boolean().optional(),
    parked: z.boolean().optional(),
    timeout: z.number().positive().optional(),
    commandTimeout: z.number().positive().optional(),
    tools: z.array(z.string()).optional(),
    authPath: z.string().optional(),
  })
  .strict();

export interface AgentConfigResult {
  config: AgentConfig | null;
  errors: string[];
}

/** Turn zod issues into one line each, `path: message`. */
function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export function parseAgentConfigText(text: string): AgentConfigResult {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (error) {
    return { config: null, errors: [`invalid YAML: ${(error as Error).message}`] };
  }
  // An empty file is a config that sets nothing, not an error.
  if (doc === null || doc === undefined) return { config: {}, errors: [] };

  const parsed = schema.safeParse(doc);
  if (!parsed.success) return { config: null, errors: formatIssues(parsed.error) };
  return { config: parsed.data as AgentConfig, errors: [] };
}

export function loadAgentConfig(path: string): AgentConfigResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { config: null, errors: [`cannot read ${path}: ${(error as Error).message}`] };
  }
  return parseAgentConfigText(text);
}
