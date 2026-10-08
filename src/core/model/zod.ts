import type { ZodError } from 'zod';

/**
 * Turn a zod error into `"path: message"` strings, the same format both schema
 * parsers and the view parser use.
 */
export function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
}
