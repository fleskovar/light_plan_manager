import type { IncomingMessage, ServerResponse } from 'node:http';
import { BoardError, ConflictError } from '../../core/index.js';
import type { ApiErrorBody } from '../../shared/index.js';

/** Refuse a body big enough to be a mistake rather than a view. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The API is local and mutates the working tree; nothing may be cached.
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Render any thrown value as a response. `BoardError` carries the hints the CLI
 * prints, and they are worth just as much in a dialog, so they travel too.
 */
export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    return sendJson(res, error.status, { error: error.message, details: error.details });
  }
  if (error instanceof BoardError) {
    const body: ApiErrorBody = { error: error.message, details: error.details };
    // Somebody else got there first: the request was fine, the board moved.
    return sendJson(res, error instanceof ConflictError ? 409 : 400, body);
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 500, { error: message });
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new HttpError(400, `Invalid JSON body: ${(error as Error).message}`);
  }
}
