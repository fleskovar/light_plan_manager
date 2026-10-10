# Case: the queue panel and `lpm queue simulate` show the same order (queue mode)

## What this case proves

For each reader of the board, the command `lpm queue simulate` and the queue
panel of the web app show the same stories in the same order.

The board is in queue mode, so the queue ignores both sprints. The case
`../periods-mode/` uses the same documents with the sprints in force.

**Units under test.**

| Side | Code |
| --- | --- |
| Terminal | `simulateQueue` in `src/core/board/simulate.ts`, printed by `src/cli/commands/queue.ts` |
| Server | `GET /api/queue` in `src/server/routes/planning.ts` |
| Browser | `QueueSequence` in `web/src/features/queue/sequence.svelte.ts`, and `buildQueue`, `queueSections` and `markerOf` in `web/src/features/queue/queue.ts` |

**Runner.** `web/test/queue-cases.test.ts` runs every folder under
`test/cases/queue-order/`. `../REVIEW.md` explains how to run it and how to
repeat each step by hand.

## Inputs

| File | Content |
| --- | --- |
| `inputs/config.yml` | The board config: features and stories, three statuses, three priorities, sprints, people and one pool. |
| `inputs/commands.txt` | The 19 `lpm` commands that build the board, in order. |
| `inputs/audiences.json` | The four readers. Each reader has the flags for `lpm queue simulate` and the value of "Queue for" in the panel. |

The clock is an input too. Sprint 1 runs from 2020-01-01 to 2098-12-31, and
Sprint 2 starts on 2099-01-01. So the result is the same on any date before
2099. In this case the dates have no effect, because queue mode ignores sprints.

### The board

`commands.txt` creates these documents. The board numbers documents in creation
order, so the ids are stable.

| Id | Document | Assignee | Priority | Status | Sprint | Depends on |
| --- | --- | --- | --- | --- | --- | --- |
| RS-1 | QA (a pool) | | | | | |
| RS-2 | Alice (covers RS-1) | | | | | |
| RS-3 | Bob | | | | | |
| SP-1 | Sprint 1 (running) | | | | | |
| SP-2 | Sprint 2 (not started) | | | | | |
| LP-1 | Feature: Checkout | | | | | |
| LP-2 | Feature: Search | | | | | |
| LP-3 | Cart page (in LP-1) | Alice | medium | doing | | |
| LP-4 | Payment API client (in LP-1) | Alice | low | todo | SP-2 | |
| LP-5 | Payment form (in LP-1) | Alice | high | todo | | LP-4 |
| LP-6 | Test checkout (in LP-1) | QA | low | todo | SP-1 | |
| LP-7 | Receipt email (in LP-1), flagged `blocked` | Alice | high | todo | | |
| LP-8 | Refund flow (in LP-1) | Alice | low | todo | | LP-7 |
| LP-9 | Search box (in LP-2) | Alice | medium | todo | | |
| LP-10 | Search results (in LP-2) | Bob | high | todo | | LP-9 |
| LP-11 | Search filters (in LP-2) | Bob | medium | todo | | |
| LP-12 | Search analytics (in LP-2) | nobody | high | todo | | |

### Why each story exists

| Story | The rule it demonstrates |
| --- | --- |
| LP-3 | Work in progress is the first step of the sequence. |
| LP-4 | A tie on priority goes to the story that another story depends on. |
| LP-5 | A blocked story waits for its blocker, even with the highest priority. It comes next when the blocker is finished. |
| LP-6 | Work assigned to a pool reaches each person who covers the pool. |
| LP-7 | The queue never offers a flagged story. |
| LP-8 | A story that depends on a flagged story is never reached. |
| LP-9 | A higher priority comes before a lower priority. |
| LP-10 | A story that depends on the work of another person is never reached in the queue of one person. |
| LP-11 | The work of one person is not in the queue of another person. |
| LP-12 | A story with no assignee is in the queue of no person. It is in the queue of the whole team. |

## Expected outputs

| File | Content | Order |
| --- | --- | --- |
| `outputs/sequence.json` | For each reader, the ids of the stories in the order of the sequence. | The order of the sequence. |
| `outputs/panel.json` | For each reader, the cards in the three sections of the panel. Each card has its id and the number on its marker. `null` means that the marker shows no number. | The order on the screen, top to bottom. |

The files hold ids and numbers only. They hold no dates, paths or titles.

## Where the baseline comes from

A person computed both files by hand from the rules below, before the test ran
for the first time. The test then passed without a change to either file.

## The rules

`simulateQueue` builds the sequence for one reader in two parts.

**Part 1.** The sequence starts with the stories that the reader holds in the
status `doing`. A flagged story is left out.

**Part 2.** `simulateQueue` then repeats these three steps until no story is
ready:

1. List the stories that are ready for the reader (rules R1 to R4).
2. Take the first story by rank (rules K1 to K5).
3. Count that story as done, and start again.

A story is **ready** for a reader when all four rules hold:

- **R1.** The story is in the status `todo`. A feature is never offered.
- **R2.** The story has no flag.
- **R3.** The story reaches the reader. For a person, the story is assigned to
  that person or to a pool that the person covers. For a pool, the story is
  assigned to the pool. For Everyone, each story reaches the reader.
- **R4.** Each story in "Depends on" is done.

Two ready stories are **ranked** by the first rule that separates them:

- **K1.** The higher priority first: `high`, then `medium`, then `low`.
- **K2.** The story in the later status column first. Each ready story in this
  case is in `todo`, so K2 never decides.
- **K3.** The story in the feature with more work under way first. K3 compares
  stories of different features only. In this case, each tie on K1 is between
  two stories of the same feature, so K3 never decides.
- **K4.** The story that more stories depend on first.
- **K5.** The story with the lower id number first.

The panel shows the same sequence with three more rules:

- **P1.** The status and the blockers of a story today decide its section.
  "In progress" holds stories in `doing`. "Up next" holds stories that are ready
  today. "Waiting" holds stories in `todo` that have an unfinished blocker or a
  flag.
- **P2.** The number on a card is the position of the story in the sequence. A
  story that the sequence never reaches has no number.
- **P3.** Inside a section, the numbered cards come first, in number order.

## Walkthrough

### Alice (`--user Alice`, "Queue for" = Alice)

By R3, these stories reach Alice: LP-3, LP-4, LP-5, LP-7, LP-8 and LP-9 (her
own), and LP-6 (assigned to the pool RS-1, which Alice covers).

| Step | Ready stories | Taken | Reason |
| --- | --- | --- | --- |
| 1 | (part 1) | LP-3 | LP-3 is in `doing`, and Alice holds it. |
| 2 | LP-4 (low), LP-6 (low), LP-9 (medium) | LP-9 | K1: `medium` is before `low`. LP-5 is not ready, because LP-4 is not done (R4). |
| 3 | LP-4 (low), LP-6 (low) | LP-4 | K1 is a tie. Both are in `todo` and in the feature LP-1. K4: one story (LP-5) depends on LP-4, and no story depends on LP-6. |
| 4 | LP-5 (high), LP-6 (low) | LP-5 | LP-4 is done, so LP-5 is ready. K1: `high` is before `low`. |
| 5 | LP-6 (low) | LP-6 | LP-6 is the only ready story. |
| End | none | | LP-7 has a flag (R2). LP-8 depends on LP-7, which is never done (R4). |

→ `outputs/sequence.json`: `"Alice": ["LP-3", "LP-9", "LP-4", "LP-5", "LP-6"]`

The panel puts each story in a section by P1, and numbers it by P2:

| Section | Cards (number, id) | Reason |
| --- | --- | --- |
| In progress | 1 LP-3 | LP-3 is in `doing`. |
| Up next | 2 LP-9, 3 LP-4, 5 LP-6 | These three stories are ready today. |
| Waiting | 4 LP-5, then LP-7 and LP-8 with no number | LP-5 waits on LP-4. LP-7 has a flag. LP-8 waits on LP-7. |

The number 4 is in "Waiting" and not in "Up next", because LP-5 becomes ready
only when LP-4 is done. Read the numbered cards in number order: LP-3, LP-9,
LP-4, LP-5, LP-6. That order is the sequence of the terminal.

### Bob (`--user Bob`, "Queue for" = Bob)

LP-10 and LP-11 reach Bob. He holds no story in `doing`.

| Step | Ready stories | Taken | Reason |
| --- | --- | --- | --- |
| 1 | LP-11 (medium) | LP-11 | LP-10 is not ready: it depends on LP-9 (R4). |
| End | none | | LP-9 is the work of Alice. The queue of Bob never finishes LP-9, so LP-10 is never ready. |

→ `"Bob": ["LP-11"]`. The panel shows 1 LP-11 in "Up next", and LP-10 in
"Waiting" with no number.

### QA (`--role QA`, "Queue for" = QA)

Only LP-6 is assigned to the pool. LP-6 is ready.

→ `"QA": ["LP-6"]`. The panel shows 1 LP-6 in "Up next".

### Everyone (`--team`, "Queue for" = Everyone)

By R3, each story reaches the reader, LP-12 included.

| Step | Ready stories | Taken | Reason |
| --- | --- | --- | --- |
| 1 | (part 1) | LP-3 | LP-3 is the only story in `doing`. |
| 2 | LP-4 (low), LP-6 (low), LP-9 (medium), LP-11 (medium), LP-12 (high) | LP-12 | K1: `high` is first. |
| 3 | LP-4, LP-6, LP-9 (medium), LP-11 (medium) | LP-9 | K1 is a tie between LP-9 and LP-11. Both are in LP-2. K4: LP-10 depends on LP-9, and no story depends on LP-11. |
| 4 | LP-4, LP-6, LP-10 (high), LP-11 (medium) | LP-10 | LP-9 is done, so LP-10 is ready. K1: `high` is first. |
| 5 | LP-4 (low), LP-6 (low), LP-11 (medium) | LP-11 | K1: `medium` is before `low`. |
| 6 | LP-4 (low), LP-6 (low) | LP-4 | K4, as in step 3 of Alice. |
| 7 | LP-5 (high), LP-6 (low) | LP-5 | K1. |
| 8 | LP-6 (low) | LP-6 | LP-6 is the only ready story. |
| End | none | | LP-7 has a flag. LP-8 waits on LP-7. |

→ `"Everyone": ["LP-3", "LP-12", "LP-9", "LP-10", "LP-11", "LP-4", "LP-5", "LP-6"]`

| Section | Cards (number, id) |
| --- | --- |
| In progress | 1 LP-3 |
| Up next | 2 LP-12, 3 LP-9, 5 LP-11, 6 LP-4, 8 LP-6 |
| Waiting | 4 LP-10, 7 LP-5, then LP-7 and LP-8 with no number |

## What this case does and does not prove

- **It pins** the order of the sequence for four kinds of reader, the section of
  each card, and the number on each card.
- **It catches** a panel that sorts cards with its own rules, a server route that
  answers for the wrong reader, and an engine that reads sprints in queue mode.
  Each of the three was tried: `../REVIEW.md`, part 5, has the results.
- **It does not cover** rule K3 (the feature already under way), rule K2 (the
  status column), profiles, squads or a switched-off sprint.
  `test/cohesion.test.ts` covers K3. `test/tasks.test.ts`,
  `test/simulate.test.ts` and `test/planning.test.ts` cover the other rules in
  the engine. It does not render the Svelte markup of the
  panel: it stops at the values that the markup prints.
