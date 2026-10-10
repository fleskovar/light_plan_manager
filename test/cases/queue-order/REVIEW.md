# How to review the queue-order cases

This document is for a person who wants to check one claim without trusting the
test: for each reader, the command `lpm queue simulate` and the queue panel of
the web app show the same stories in the same order.

The claim is checked in two cases, with one small board:

| Case | Planning mode of the board | Folder |
| --- | --- | --- |
| Queue mode | `queue`: the queue ignores sprints | `queue-mode/` |
| Periods mode | `periods`: sprints order the work | `periods-mode/` |

The review has five parts. Parts 1 and 2 take about ten minutes. Parts 3 and 4
repeat the test by hand in a terminal and a browser. Part 5 shows that the test
fails when the code is wrong.

## Before you start

Run these commands once, in the root of the repository:

```bash
npm install
npm run install:web
npm run build:all
```

Parts 3 and 4 need the command `lpm`. If `lpm` is not on your PATH, use
`node <repository>/dist/cli/index.js` in each place where this document says
`lpm`.

Make sure that the variable `LPM_BOARD_PATH` is not set. When the variable is
set, each `lpm` command uses the board that the variable names.

## Part 1: run the automated test

```bash
npm run test:queue-cases
```

The expected result is eight passed tests: four readers in each of two cases.

```text
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

For each case and each reader, the test (`web/test/queue-cases.test.ts`) does
these steps:

1. It builds the board with the commands in `inputs/commands.txt`.
2. It runs `lpm queue simulate` for the reader, and reads the ids from the
   numbered lines of the output.
3. It starts the server, and loads the board with the code of the web app.
4. It computes the queue panel for the reader with the code of the web app.
5. It checks that the numbered cards of the panel, in number order, are the ids
   of step 2.
6. It checks that both are equal to `outputs/sequence.json` and
   `outputs/panel.json`.

To run one case, add its name:

```bash
cd web
npx vitest run test/queue-cases.test.ts -t "queue-order/queue-mode"
```

## Part 2: check the expected values by hand

The files in `outputs/` are the baseline. A person computed them by hand. To
check them, you need only the README of each case.

1. Open `queue-mode/README.md`.
2. Read the table "The board" and the section "The rules".
3. For Alice, compute the sequence with the rules. Do not look at the
   walkthrough.
4. Compare your sequence with the walkthrough, and with the line `"Alice"` in
   `queue-mode/outputs/sequence.json`.
5. Do the same for Everyone.
6. Open `periods-mode/README.md`, and repeat steps 3 to 5 with rule K0.

If your sequence is different from the file, the baseline or the rules are
wrong. Report the reader and the step.

## Part 3: repeat the queue-mode case by hand

### Step 1: build the board

Make an empty folder outside the repository, and copy two input files into it.
Then run the commands file. The examples use `~/queue-case`.

With Git Bash:

```bash
mkdir ~/queue-case
cd ~/queue-case
cp <repository>/test/cases/queue-order/queue-mode/inputs/config.yml .
cp <repository>/test/cases/queue-order/queue-mode/inputs/commands.txt .
bash commands.txt
```

With PowerShell, replace the last line:

```powershell
Get-Content commands.txt | Where-Object { $_ -match '^lpm ' } | ForEach-Object { Invoke-Expression $_ }
```

The first command prints the planning mode of the new board:

```text
  planning   queue  (sprints and increments are ignored; plan with them with lpm planning periods)
```

### Step 2: read the queue in the terminal

Run the command for each reader. Write down the ids, in order.

```text
$ lpm queue simulate --user Alice
  1.   LP-3    Cart page                           Story          in progress
  2.   LP-9    Search box                          Story          frees LP-10
  3.   LP-4    Payment API client                  Story          frees LP-5
  4.   LP-5    Payment form                        Story
  5.   LP-6    Test checkout                       Story          pool RS-1

$ lpm queue simulate --user Bob
  1.   LP-11   Search filters                      Story

$ lpm queue simulate --role QA
  1.   LP-6    Test checkout                       Story

$ lpm queue simulate --team
  1.   LP-3    Cart page                           Story          in progress
  2.   LP-12   Search analytics                    Story          unassigned
  3.   LP-9    Search box                          Story          frees LP-10
  4.   LP-10   Search results                      Story
  5.   LP-11   Search filters                      Story
  6.   LP-4    Payment API client                  Story          frees LP-5
  7.   LP-5    Payment form                        Story
  8.   LP-6    Test checkout                       Story          pool RS-1
```

Each list must be equal to the line of that reader in
`queue-mode/outputs/sequence.json`.

To see the stories that a sequence never reaches, add `--skipped`:

```text
$ lpm queue simulate --user Alice --skipped
...
Never reached
  LP-7    Receipt email                         flagged by RS-2 (Alice) — the work has stopped until somebody clears it
  LP-8    Refund flow                           waiting on LP-7
  LP-10   Search results                        assigned to RS-3 (Bob)
  LP-11   Search filters                        assigned to RS-3 (Bob)
  LP-12   Search analytics                      assigned to nobody — try --unassigned
```

### Step 3: read the queue in the browser

1. In `~/queue-case`, run `lpm ui`. The browser opens the board.
2. Create a view: in the card **New view**, type a name and select **Create**.
3. The queue panel is on the left side. If you see only a narrow strip with the
   word "Queue", select the strip.
4. At the top of the panel, the switch shows **Queue**. Below the heading, the
   panel shows "One PI › one sprint › all 10 work units".
5. In the list **Queue for**, select **Alice**.
6. Read the number in the circle beside each card, in the three sections.

The panel must show these cards. The values are in
`queue-mode/outputs/panel.json`.

| Queue for | In progress | Up next | Waiting |
| --- | --- | --- | --- |
| Alice | 1 LP-3 | 2 LP-9, 3 LP-4, 5 LP-6 | 4 LP-5, then LP-7 and LP-8 with no number |
| Bob | (empty) | 1 LP-11 | LP-10 with no number |
| QA | (empty) | 1 LP-6 | (empty) |
| Everyone | 1 LP-3 | 2 LP-12, 3 LP-9, 5 LP-11, 6 LP-4, 8 LP-6 | 4 LP-10, 7 LP-5, then LP-7 and LP-8 with no number |

7. Select each of the other readers in **Queue for**, and compare again.

### Step 4: compare the two

For each reader, read the numbered cards of the panel in number order. Ignore
the sections. The list must be equal to the list that the terminal printed in
step 2.

Example for Alice: the cards 1 to 5 are LP-3, LP-9, LP-4, LP-5, LP-6. The
terminal printed LP-3, LP-9, LP-4, LP-5, LP-6.

A number can be in "Waiting". The story LP-5 has the number 4, because LP-5 is
the fourth step of the sequence. LP-5 is in "Waiting" today, because LP-4 is not
done.

## Part 4: repeat the periods-mode case by hand

The periods-mode case has the same documents. So you do not need a second
board: switch the mode of the board from part 3.

1. Keep `lpm ui` open. In a second terminal, in `~/queue-case`, run:

   ```bash
   lpm planning periods
   ```

   You can also select **Sprints & PIs** in the switch at the top of the queue
   panel. Both write the same key in `.lpm/config.yml`.

2. Run the commands of part 3, step 2, again. Two lists change:

   ```text
   $ lpm queue simulate --user Alice
     1.   LP-3    Cart page                           Story          in progress
     2.   LP-6    Test checkout                       Story          SP-1 · pool RS-1
     3.   LP-9    Search box                          Story          frees LP-10
     4.   LP-4    Payment API client                  Story          SP-2 · frees LP-5
     5.   LP-5    Payment form                        Story

   $ lpm queue simulate --team
     1.   LP-3    Cart page                           Story          in progress
     2.   LP-6    Test checkout                       Story          SP-1 · pool RS-1
     3.   LP-12   Search analytics                    Story          unassigned
     4.   LP-9    Search box                          Story          frees LP-10
     5.   LP-10   Search results                      Story
     6.   LP-11   Search filters                      Story
     7.   LP-4    Payment API client                  Story          SP-2 · frees LP-5
     8.   LP-5    Payment form                        Story
   ```

   Each list must be equal to `periods-mode/outputs/sequence.json`.

3. In the browser, wait five seconds. The web app reads the board again every
   five seconds. The switch now shows **Sprints & PIs**, and the drawer at the
   bottom shows the tabs **Periods** and **Gantt**.

4. Compare the panel with this table. The values are in
   `periods-mode/outputs/panel.json`.

   | Queue for | In progress | Up next | Waiting |
   | --- | --- | --- | --- |
   | Alice | 1 LP-3 | 2 LP-6, 3 LP-9, 4 LP-4 | 5 LP-5, then LP-7 and LP-8 with no number |
   | Bob | (empty) | 1 LP-11 | LP-10 with no number |
   | QA | (empty) | 1 LP-6 | (empty) |
   | Everyone | 1 LP-3 | 2 LP-6, 3 LP-12, 4 LP-9, 6 LP-11, 7 LP-4 | 5 LP-10, 8 LP-5, then LP-7 and LP-8 with no number |

5. Run `lpm planning queue`. The terminal and the panel return to the values of
   part 3.

   A switch of the mode changes no story file. To check this, copy the folder
   `.lpm/board` before the switch, and compare the two folders after it:

   ```bash
   cp -r .lpm/board board-before
   lpm planning periods
   diff -r board-before .lpm/board
   ```

   `diff` prints nothing when the folders are equal.

## Part 5: show that the test can fail

A test that cannot fail proves nothing. Each row of this table is one change to
the code. With each change, `npm run test:queue-cases` failed. The results are
from 2026-10-10.

| Change | File | Result |
| --- | --- | --- |
| The panel sorts numbered cards with its own rules, not by their step. | `web/src/features/queue/queue.ts`, in `byQueueOrder` | 3 of 8 tests failed. |
| The server answers for the whole team, whatever reader the panel names. | `src/server/routes/planning.ts`, in the route `GET /api/queue` | 6 of 8 tests failed: Alice, Bob and QA in both cases. |
| The engine reads sprints in queue mode. | `src/core/board/tasks/ranking.ts`, in `scheduleOf` | 2 of 8 tests failed: Alice and Everyone in `queue-mode`. |

To repeat the third row:

1. In `scheduleOf`, replace the line that starts with `return ignoresPeriods`
   with `return periodOf(board, issue);`.
2. Run `npm run test:queue-cases`. Two tests fail.
3. Undo the change with `git checkout src/core/board/tasks/ranking.ts`.
4. Run the test again. Eight tests pass.

## How to debug one case

Run one case under the Node inspector, and attach a debugger:

```bash
cd web
npx vitest run test/queue-cases.test.ts -t "queue-order/queue-mode" --inspect-brk --no-file-parallelism
```

In VS Code, open a **JavaScript Debug Terminal** and run the same command
without `--inspect-brk`. The breakpoints in `web/test/queue-cases.test.ts`,
`src/core/board/simulate.ts` and `web/src/features/queue/queue.ts` then stop
the run.

## How to add a case

1. Copy one case folder under `test/cases/queue-order/`.
2. Change `inputs/commands.txt`. The runner knows the commands `lpm init`,
   `lpm new` and `lpm flag`.
3. Compute `outputs/sequence.json` and `outputs/panel.json` by hand, and write
   the derivation in the README of the case.
4. Run `npm run test:queue-cases`. The runner finds the new folder.
