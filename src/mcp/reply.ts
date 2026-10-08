import { BoardError } from '../core/index.js';

/**
 * What a tool hands back.
 *
 * Every result is text, and data results are compact JSON inside it. That is
 * the shape every MCP client understands, and an agent reads JSON perfectly
 * well — declaring an output schema per tool would double the size of this
 * server for no gain the model can use.
 */
export interface ToolReply {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export function text(message: string): ToolReply {
  return { content: [{ type: 'text', text: message }] };
}

export function json(value: unknown): ToolReply {
  return text(JSON.stringify(value, null, 2));
}

/**
 * Report a refusal to the model rather than throwing.
 *
 * A `BoardError` is the engine explaining what is wrong and often how to fix
 * it, which is exactly what an agent needs to try again. Losing the hints in a
 * transport-level error would leave it guessing.
 */
export function failure(error: unknown): ToolReply {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof BoardError ? error.details : [];
  return {
    content: [{ type: 'text', text: [message, ...details].join('\n') }],
    isError: true,
  };
}

/** Wrap a tool body so every failure comes back as a readable message. */
export function guard<A>(run: (args: A) => ToolReply | Promise<ToolReply>) {
  return async (args: A): Promise<ToolReply> => {
    try {
      return await run(args);
    } catch (error) {
      return failure(error);
    }
  };
}
