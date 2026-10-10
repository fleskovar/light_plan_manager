/**
 * "What should I work on?" plus "who is carrying how much?" — the read-only
 * resource dimension of the board.
 *
 * Split across two modules so each answers one question:
 *
 * - `ranking.ts` — ranking work: `nextTasks`, `blockedTasks`, `resumableTasks`,
 *   `currentTasks`, `previousTasks`, `rankCandidates`, `routeOf`, `isParked`,
 *   `scheduleOf`, `squadBars`, `blockersOf`, `isBlocked`, `upstreamOf`, `effortOf`, `TaskOptions`,
 *   `TaskCandidate`, `TaskRoute`, `UpstreamIssue`.
 *
 * - `roster.ts` — reporting load: `resourceLoad`, `LoadRow`, `LoadReport`.
 *
 * Everything here derives from the board plus the config; nothing writes.
 * `lpm task` and `lpm team` are thin printers over these functions.
 *
 * The export surface is load-bearing: `simulate.ts` deliberately imports
 * `resumableTasks`, `routeOf`, `isParked` and `squadBars` so the simulator can never
 * disagree with the queue — and `src/runner/loop.ts` imports `resumableTasks`
 * for the same reason, so `lpm queue agent` resumes exactly the work
 * `lpm queue simulate` says it will. `test/simulate.test.ts` and
 * `test/runner-loop.test.ts` enforce it.
 */
export * from './ranking.js';
export * from './roster.js';
