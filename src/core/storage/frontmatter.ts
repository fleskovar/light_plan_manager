import YAML from 'yaml';

const BOM = '\\uFEFF';
const FRONTMATTER_RE = new RegExp(
  `^${BOM}?---[ \\t]*\\r?\\n([\\s\\S]*?)(?:\\r?\\n)?---[ \\t]*(?:\\r?\\n|$)`,
);
const LEADING_BOM_RE = new RegExp(`^${BOM}`);

export interface ParsedDocument {
  data: Record<string, unknown>;
  body: string;
  hadFrontmatter: boolean;
}

/**
 * Split a markdown document into YAML frontmatter and body.
 * Throws if the frontmatter block exists but is not valid YAML.
 */
export function parseFrontmatter(raw: string): ParsedDocument {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { data: {}, body: raw.replace(LEADING_BOM_RE, ''), hadFrontmatter: false };
  }
  const parsed = YAML.parse(match[1]!) as unknown;
  const data =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { data, body: raw.slice(match[0].length), hadFrontmatter: true };
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  const trimmed = body.replace(/^\s+/, '').trimEnd();
  return trimmed ? `---\n${yaml}\n---\n\n${trimmed}\n` : `---\n${yaml}\n---\n`;
}

/**
 * First level-1 heading in a markdown body, used to recover a missing title.
 * Deliberately h1-only: issue body templates open with h2 section headings.
 */
export function firstHeading(body: string): string | null {
  const match = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  return match ? match[1]! : null;
}
