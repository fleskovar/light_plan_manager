/**
 * Working briefs: turning one issue into the text somebody needs to do it.
 *
 * `lpm task next` says *what* to work on. This layer answers the question
 * straight after it — *what do I need to know to start?* — by walking up the
 * hierarchy and laying the ancestors' titles and bodies out above the issue's
 * own, plus its breakdown, its blockers, the findings it rests on and its work
 * log. The result is markdown meant to be pasted into a prompt.
 *
 *   analyze.ts    the safety check a template passes before it is compiled
 *   template.ts   rendering one with Eta, plus the helpers it may call
 *   context.ts    board + issue -> the values a template can see
 *   builtin.ts    the layout every board falls back to, naming no type
 *   instructions.ts  which template to use, and rendering it
 *
 * Read-only, like `board/tasks.ts`: a brief reports the board, it never
 * changes it. The layouts live in `.lpm/templates/context/`, which is the one
 * folder under `.lpm` that holds no documents — `load.ts` never opens it and
 * `check` does not know it exists, so no template can make a board invalid.
 *
 * They are, however, **executable**: Eta compiles a template to JavaScript and
 * runs it. `analyze.ts` is what stands between a board somebody handed you and
 * your shell, and every render goes through it.
 */
export * from './analyze.js';
export * from './builtin.js';
export * from './context.js';
export * from './instructions.js';
export * from './template.js';
