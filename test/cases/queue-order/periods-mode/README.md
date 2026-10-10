# Case: the queue panel and `lpm queue simulate` show the same order (periods mode)

## What this case proves

For each reader of the board, the command `lpm queue simulate` and the queue
panel of the web app show the same stories in the same order, when the board
plans with sprints.

This case has the same documents as `../queue-mode/`. One command is different:
`lpm init` gets the flag `--planning periods`. So the config has no `planning`
key, and the board is in periods mode. Read `../queue-mode/README.md` first. It
has the table of documents, the rules R1 to R4, K1 to K5 and P1 to P3, and the
units under test.

**Runner.** `web/test/queue-cases.test.ts`. See `../REVIEW.md`.

## Inputs

| File | Content | Difference from `../queue-mode/` |
| --- | --- | --- |
| `inputs/config.yml` | The board config. | None. |
| `inputs/commands.txt` | The 19 `lpm` commands that build the board. | The first command has `--planning periods`. |
| `inputs/audiences.json` | The four readers. | None. |

The clock is an input. Sprint 1 (SP-1) runs from 2020-01-01 to 2098-12-31, so
SP-1 runs on any date before 2099. Sprint 2 (SP-2) starts on 2099-01-01, so SP-2
has not started on any date before 2099.

### The stories that have a sprint

| Story | Sprint | State of the sprint |
| --- | --- | --- |
| LP-6 Test checkout | SP-1 | Runs today. |
| LP-4 Payment API client | SP-2 | Has not started. |
| The other eight stories | none | |

## Expected outputs

`outputs/sequence.json` and `outputs/panel.json` have the same shape as in
`../queue-mode/`.

## Where the baseline comes from

A person computed both files by hand from the rules below, before the test ran
for the first time. The test then passed without a change to either file.

## The rule that periods mode adds

In periods mode, one rule ranks two ready stories before K1 to K5:

- **K0.** The story in the lower group first:
  - Group 0: the sprint of the story has started.
  - Group 1: the story has no sprint.
  - Group 2: the sprint of the story has not started.

`scheduleRank` in `src/core/board/tasks/ranking.ts` implements K0. In queue
mode, `scheduleRank` puts each story in group 1, so K0 never decides.

| Story | Group |
| --- | --- |
| LP-6 | 0 |
| LP-4 | 2 |
| The other eight stories | 1 |

## Walkthrough

### Alice (`--user Alice`, "Queue for" = Alice)

| Step | Ready stories (group, priority) | Taken | Reason |
| --- | --- | --- | --- |
| 1 | (part 1) | LP-3 | LP-3 is in `doing`, and Alice holds it. |
| 2 | LP-6 (0, low), LP-9 (1, medium), LP-4 (2, low) | LP-6 | K0: group 0 is first. The low priority of LP-6 does not count, because K0 comes before K1. |
| 3 | LP-9 (1, medium), LP-4 (2, low) | LP-9 | K0: group 1 is before group 2. |
| 4 | LP-4 (2, low) | LP-4 | LP-4 is the only ready story. LP-5 waits on LP-4. |
| 5 | LP-5 (1, high) | LP-5 | LP-4 is done, so LP-5 is ready. |
| End | none | | LP-7 has a flag. LP-8 waits on LP-7. |

→ `outputs/sequence.json`: `"Alice": ["LP-3", "LP-6", "LP-9", "LP-4", "LP-5"]`

In queue mode the same reader gets LP-3, LP-9, LP-4, LP-5, LP-6. The sprint
moves LP-6 from the last position to the second position.

| Section | Cards (number, id) |
| --- | --- |
| In progress | 1 LP-3 |
| Up next | 2 LP-6, 3 LP-9, 4 LP-4 |
| Waiting | 5 LP-5, then LP-7 and LP-8 with no number |

### Bob and QA

No story of Bob has a sprint, so K0 never decides for Bob. The pool QA has one
story. Both results are the same as in queue mode:

- `"Bob": ["LP-11"]`. LP-10 is in "Waiting" with no number.
- `"QA": ["LP-6"]`.

### Everyone (`--team`, "Queue for" = Everyone)

| Step | Ready stories (group, priority) | Taken | Reason |
| --- | --- | --- | --- |
| 1 | (part 1) | LP-3 | LP-3 is the only story in `doing`. |
| 2 | LP-6 (0, low), LP-12 (1, high), LP-9 (1, medium), LP-11 (1, medium), LP-4 (2, low) | LP-6 | K0: group 0 is first. |
| 3 | LP-12 (1, high), LP-9 (1, medium), LP-11 (1, medium), LP-4 (2, low) | LP-12 | K0 leaves the three stories of group 1. K1: `high` is first. |
| 4 | LP-9 (1, medium), LP-11 (1, medium), LP-4 (2, low) | LP-9 | K0 and K1 are a tie between LP-9 and LP-11. K4: LP-10 depends on LP-9. |
| 5 | LP-10 (1, high), LP-11 (1, medium), LP-4 (2, low) | LP-10 | LP-9 is done, so LP-10 is ready. K1: `high` is first. |
| 6 | LP-11 (1, medium), LP-4 (2, low) | LP-11 | K0: group 1 is before group 2. |
| 7 | LP-4 (2, low) | LP-4 | LP-4 is the only ready story. |
| 8 | LP-5 (1, high) | LP-5 | LP-4 is done, so LP-5 is ready. |
| End | none | | LP-7 has a flag. LP-8 waits on LP-7. |

→ `"Everyone": ["LP-3", "LP-6", "LP-12", "LP-9", "LP-10", "LP-11", "LP-4", "LP-5"]`

| Section | Cards (number, id) |
| --- | --- |
| In progress | 1 LP-3 |
| Up next | 2 LP-6, 3 LP-12, 4 LP-9, 6 LP-11, 7 LP-4 |
| Waiting | 5 LP-10, 8 LP-5, then LP-7 and LP-8 with no number |

## What this case does and does not prove

- **It pins** that the panel follows the sprints when the board plans with
  sprints. Before the panel read its order from the server, the panel ranked
  work without rule K0. With this board, that panel showed LP-9 before LP-6 for
  Alice, and the terminal showed LP-6 before LP-9.
- **It catches** a panel that leaves out K0, and an engine that leaves out K0 in
  periods mode.
- **It does not cover** a switched-off sprint, a sprint that a squad owns, or
  two sprints in the same group. `test/tasks.test.ts`, `test/periods.test.ts`
  and `test/simulate.test.ts` cover those rules in the engine.
