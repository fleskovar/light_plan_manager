import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import type { Profile } from '../model/profile.js';

/**
 * Parsing a profile file: `.lpm/config.yml`'s counterpart for one developer.
 *
 * Deliberately strict. The board config can afford to be forgiving about a key
 * it does not recognise; a profile cannot, because the failure mode is silent
 * and one-directional — a mistyped `excludes:` would hand someone the whole
 * board and nothing would ever say so. An unknown key is an error.
 *
 * YAML is a superset of JSON, so a `.json` profile parses here too.
 */

/**
 * A list, written as one either way: `under: LP-2` and `under: [LP-2]`. A key
 * left empty is the same as not writing it — `scope:` with every line beneath
 * it commented out is the shape the starter file ships in, and it has to mean
 * "no opinion" rather than "scope me to nothing".
 */
const nameList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (typeof value === 'string' ? [value] : value))
  .pipe(z.array(z.string().trim().min(1)))
  .nullish()
  .transform((value) => value ?? undefined);

const scopeSchema = z
  .object({
    under: nameList,
    exclude: nameList,
    types: nameList,
    periods: nameList,
  })
  .strict();

const profileSchema = z
  .object({
    user: z.string().trim().min(1).nullish(),
    scope: scopeSchema.nullish().transform((value) => value ?? {}),
  })
  .strict();

export interface ProfileResult {
  profile: Profile | null;
  errors: string[];
}

import { formatZodIssues } from '../model/zod.js';

export function parseProfileText(text: string): ProfileResult {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (error) {
    return { profile: null, errors: [`invalid YAML: ${(error as Error).message}`] };
  }
  // An empty file is a profile that claims nothing, not a broken one.
  if (doc === null || doc === undefined) return { profile: { user: null, scope: {} }, errors: [] };

  const parsed = profileSchema.safeParse(doc);
  if (!parsed.success) return { profile: null, errors: formatZodIssues(parsed.error) };

  const { user, scope } = parsed.data;
  // A key with nothing under it is dropped, so `scope: { under: undefined }`
  // never reaches `resolveScope` claiming to have been declared.
  return {
    profile: {
      user: user ?? null,
      scope: Object.fromEntries(Object.entries(scope).filter(([, value]) => value !== undefined)),
    },
    errors: [],
  };
}

export function loadProfileFile(file: string): ProfileResult {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { profile: null, errors: [`cannot read profile: ${(error as Error).message}`] };
  }
  return parseProfileText(text);
}

/** The starter `lpm profile --init` writes, and the format's worked example. */
export function profileTemplate(user?: string): string {
  return `# A light-plan profile: who you are, and which part of the board is yours.
# Point light-plan at it with \`lpm profile <this file>\` or LPM_PROFILE.

# The roster entry you act as — an id or a name.
user: ${user ?? 'RS-1'}

# What gets offered to you. Every key is optional; leave the section out
# entirely to be offered the whole board.
scope:
  # Only work at or below these documents.
  # under: [LP-2]

  # Never these documents, nor anything below them. Wins over \`under\`.
  # exclude: [LP-9]

  # Only issues of these types.
  # types: [story, bug]

  # Only work scheduled in these periods, or in a period below one of them.
  # periods: [TL-2]
`;
}
