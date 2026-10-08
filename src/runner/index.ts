/**
 * The queue runner: `lpm queue agent`.
 *
 * An autonomous development loop over the board's own queue. It picks the top
 * task with `nextTasks`, hands its brief to an isolated pi coding-agent run, and
 * records the outcome through the same operations a person uses — `moveNode` to
 * finish, `flagIssue` to ask for help, `addComment` to leave a trail.
 *
 * Everything here is SDK-free except `pi.ts`, which is loaded on demand and is
 * therefore *not* re-exported: the CLI reaches it through a guarded dynamic
 * import, so a board with the pi packages missing still builds and runs every
 * other command. `loop.ts` takes the runner as an argument, which is what keeps
 * the loop testable without pi installed.
 */
export * from './types.js';
export * from './config.js';
export * from './shell.js';
export * from './git.js';
export * from './stats.js';
export * from './loop.js';
