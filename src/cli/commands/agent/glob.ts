/**
 * Selecting source files the way `.gitignore` does.
 *
 * A rule's `from:` is one pattern or a list of them, matched against paths
 * relative to `assets/` with forward slashes. Later patterns win, and a leading
 * `!` excludes — so a list reads top to bottom like a `.gitignore`:
 *
 *   from:
 *     - "skills/**\/*.md"     everything under skills/
 *     - "!skills/_*.md"       except the ones starting with an underscore
 *
 * Supported: `*` (within a segment), `**` (across segments), `?` (one
 * character), a trailing `/` or a bare directory name (everything beneath it),
 * and `!` to negate. Deliberately no braces, no character classes and no
 * `[[:alpha:]]` — this selects files in one small shipped directory, and a
 * pattern language nobody can predict is worse than one that cannot express
 * every case.
 */

/** Turn one pattern (no `!`) into an anchored regular expression. */
function toRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*') {
      const isDouble = pattern[index + 1] === '*';
      if (isDouble) {
        // `**/` may match nothing at all, so `a/**/b` also matches `a/b`.
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

interface Rule {
  negated: boolean;
  test: RegExp;
}

function compile(pattern: string): Rule {
  const negated = pattern.startsWith('!');
  let body = (negated ? pattern.slice(1) : pattern).trim();
  // A leading `/` only anchors, and everything here is anchored already.
  if (body.startsWith('/')) body = body.slice(1);
  // `dir/` and a bare `dir` both mean everything beneath it.
  if (body.endsWith('/')) body += '**';
  else if (!/[*?.]/.test(body)) body += '/**';
  return { negated, test: toRegExp(body) };
}

/**
 * A matcher over paths relative to `assets/`, using forward slashes.
 * With no positive pattern nothing matches — an empty `from:` selects nothing
 * rather than everything, because the destructive reading of a typo should be
 * the harmless one.
 */
export function matcher(patterns: string[]): (relativePath: string) => boolean {
  const rules = patterns.map(compile);
  return (relativePath: string): boolean => {
    const target = relativePath.split('\\').join('/');
    let matched = false;
    for (const rule of rules) {
      if (!rule.test.test(target)) continue;
      matched = !rule.negated;
    }
    return matched;
  };
}
