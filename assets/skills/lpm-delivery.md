---
name: lpm-delivery
description: Pick work up off a light-plan board, record how it went, and close it — the developer's loop. Load this for "what should I work on", "take the next task", "start LP-42", "close out my ticket", writing issue comments a reviewer can act on, handing a blocked ticket back, or any use of next_tasks / start_task / finish_task / add_comment / `lpm task`.
roles:
  - developer
---

# Doing the work on a light-plan board

Load the `lpm` skill first for the tool map. The `lpm-developer` agent in
`.claude/agents/` applies this as a persona; this skill is the workflow reference.

## The loop

```
board_overview          # types, statuses, who you are, what you are offered
next_tasks              # what to do
get_instructions        # what do I need to know to do it? — read this in full
start_task              # claim it, before touching code
… work, commenting as the picture changes …
flag_issue              # only if it stops: say what stopped it, and leave it
finish_task             # with the handover note
```

```bash
lpm me                    # or: lpm me "Alice Smith"
lpm task next
lpm instructions LP-42    # the brief: ancestors, issue, files, both directions, log
lpm task start LP-42
lpm comment LP-42 -f ./notes.md
lpm flag LP-42 --comment "..."   # if it stops
lpm task done LP-42
```

## 1. Find work

```
next_tasks { limit: 10 }
next_tasks { includeUnassigned: true }    # widen only when the first is empty
current_tasks                             # what you already hold
```

`next_tasks` only offers work that is genuinely startable: a **work unit** — an
issue with no children, or one whose type the board declares `atomic` and which
is therefore taken whole (containers are never offered, and nothing inside an
atomic issue is offered separately) — not finished, not already active, assigned
to you or parked in a pool you cover, with nothing unfinished blocking it. Each item's `route` says
how it reached you — `direct`, `pool` or `unassigned`.

Take the top item you can honestly start. **Do not shop around**: the ranking
encodes the team's sequencing. If the top item is wrong, comment saying why rather
than silently taking the second.

Empty queue? `list_documents { workUnitsOnly: true, status: "…" }` shows what is
actually there. Usually everything is blocked — report that, it is information the
orchestrator needs. If you have a profile, `lpm profile` shows the scope narrowing
what you see.

## 2. Get the brief

```
get_instructions { id: "LP-42" }
```

```bash
lpm instructions LP-42
```

**Do this before touching code, every time.** A story on its own almost never
explains itself: the epic says why the work is wanted, the feature says what
capability it belongs to, and the story only says which slice you were handed.
`get_instructions` walks that hierarchy and returns **one piece of markdown** —
every ancestor's title and body in order, then the issue, its breakdown, the
files it names, where it comes from and where it is going, the research it rests
on, and its work log. Read the whole thing.

Four sections do the work and are easy to skim past:

| Section | What it is for |
| --- | --- |
| **Files this is about** | The paths the ticket was written against — the requirement (often with a line range, `docs/prd.md#L120-L164`) and the code expected to change. Open these before you go searching. One may not exist yet; that usually means create it |
| **Where this comes from** | The issues this was sequenced after, and the files *they* touched. A file in both lists means somebody just changed it — read what they did first |
| **Where this is going** | What is sequenced after this. A change that closes your ticket and blocks the next one has not finished the job |
| A **flag** at the top | Somebody already picked this up and stopped. Read the work log before anything else; do not restart blind |

The layout comes from the board: `.lpm/templates/context/<type>.md`, with
`default.md` behind it and a built-in layout behind that. A team can therefore
decide what its developers are told, per issue type. **Do not pass `template`**
unless you were asked to use a specific one. If the reply has `warnings`, the
board's own template asked for something the board does not have — report it,
do not repair it.

If instead it comes back **refusing** a template, that is the safety check: these
layouts are Eta templates and compile to JavaScript, and this one reaches outside
the board. Report it and stop. There is no override for agents, and looking for
one is the wrong instinct — a board carrying a template that can run code is
something a human has to see.

`lpm instructions` writes the brief to stdout and nothing else, so it pipes:

```bash
lpm instructions LP-42 > brief.md
lpm instructions --list            # which layout each type uses
lpm instructions --init            # write the starter layouts into this board
```

`get_document { id }` is still the raw record — fields, links, `ancestors` as
ids, the comment log — and is what you want when you are about to *change* a
document rather than do it.

Then judge honestly:

- Is there a definition of done, or criteria you can test against?
- Do you understand the *why*, not just the *what*?
- Are the `blockedBy` issues really finished?
- Does the codebase match what the ticket assumes?

**If it is not startable, do not start it and do not guess.** Comment with the
precise question you need answered, and move to the next item:

```
add_comment { id: "LP-42", body:
  "Not starting this yet. The requirement says \"validate the payload\" but does not say " +
  "what to do on failure — reject with 400, or accept and flag? The two lead to different " +
  "schemas. @orchestrator: which?" }
```

A ticket returned with a precise question beats one half-built against an invented
requirement. "Unclear requirements" is not a question.

## 3. Claim it

```
start_task { id: "LP-42" }
```

Assigns it to you and moves it to the board's first active status. Claim it
**before** editing code — that is what stops two agents doing the same ticket.
Never `force: true` onto someone else's work; comment and let the orchestrator
move it.

Then leave an intent comment. One call, and it makes an interrupted ticket
recoverable:

```markdown
Picked this up. Reading it as: <the requirement in your own words>.

Plan: <2-4 bullets>
Assumptions: <what you inferred that the ticket did not say>
```

## 4. Work, and comment as you go

Comment when the **picture changes**, not on a schedule: something surprising, a
blocker, a decision that closes off other options, an approach abandoned.

```markdown
The PSP sandbox rejects tokenised guest cards below £1, which the AC assumes works.

- Tried the £0.01 auth-and-void the docs suggest; same rejection.
- Going with a £1.00 auth instead, voided immediately. Adds a real charge window
  of ~2s on the customer's statement — worth a product decision, raised as LP-58.
```

Keep the ticket's file list true as you go. When you end up somewhere it did not
name, add it — the next issue sequenced after this one gets these paths in its
brief:

```
get_document { id: "LP-42" }        # returns relatedFiles
update_document { id: "LP-42", relatedFiles: [...existing, "src/checkout/pay.ts"] }
```

```bash
lpm set LP-42 --related src/checkout/pay.ts       # adds; --unrelated detaches
```

## 4b. If the work stops: flag it

Some things more effort will not fix: a credential you do not have, a decision
nobody has made, a requirement too vague to build against. There are three bad
answers — guess, work around it, or drift onto another ticket leaving this one
open and silently stuck — and one good one:

```
flag_issue { id: "LP-42", reason: "blocked" | "paused" | "help",
             comment: "<what stopped, what you tried, what would resolve it>" }
```

```bash
lpm flag LP-42 --reason help --comment "..."
lpm flag --comment "..."          # the issue you have in flight
lpm flag list                     # everything stopped, board-wide
```

The issue keeps its status and stays assigned to you, and turns **red** on the
canvas for whoever is running the plan. `blocked` = something outside the issue
has to happen first; `help` = a person is needed; `paused` = deliberately set
down.

The comment is required and is the whole value. Write it for somebody who has read
none of your session:

```markdown
Stopped: <one line>.

Tried: <what you did, and what it did>.
Blocked on: <the specific decision, access or fact you need>.
Unblocks when: <what has to be true for this to go on>.
```

"Unclear requirements" is a shrug. "The story says 'retry on failure' but not how
many times, or whether a 4xx counts; I need a number and a rule" is answerable in
thirty seconds.

**Flag early, and only for a real stop.** Flag the moment you know more effort
will not fix it. Do not flag after an hour of guessing. And do not flag for these:

- **An ordering.** If this issue truly cannot start before another one is done,
  that is a dependency. Comment, and ask the planner for `link_issues`.
- **A hard problem you can solve.** A failing test or a tricky bug is the work.
- **Work that is done.** Close it; anything left over is a new issue.
- **A change of plan.** If you no longer hold the issue, hand it back (below).

On a board with a **Human Supervisor** resource, that person answers flags. Write
the comment so they can answer it in one reply.

**Clearing is the plan owner's call.** `clear_flag` / `lpm flag clear` means
"carry on", and it is a claim that the thing that stopped the work has been dealt
with — so it belongs to whoever dealt with it. Do not clear your own to get past
it. Finishing the issue clears it automatically.

## 5. Close it

```
finish_task { id: "LP-42", comment: "<the handover note>" }
```

`finish_task` takes the comment in the same call, so the note and the status
change land together.

**Do not close the parent yourself.** A container's status is derived: closing
the last open issue in a feature closes the feature, and its epic with it, as far
up as it goes. `finish_task` returns what it carried in `rolledUp`, and the CLI
prints it. Anything that was waiting on that feature is offered immediately —
there is nothing to tick off by hand.

**Only close what you verified.** If the tests do not pass, or you could not run
them, it is not done — say so and leave it in progress. Reporting a green run you
did not see is the one unrecoverable mistake, because the next person builds on
it.

## Writing comments a reviewer can act on

Load `lpm-writing` before you write a comment. It has the style rules and a
template for each kind of comment: claim, progress, flag, handover, clear.

When your work needs the approval of a senior developer or engineer, create a
`review` issue and load `lpm-writing-reviews`. When you find a defect or a
question during the work, load `lpm-writing-items` before you write the bug or
the research issue.

You are writing for two people who are not in your conversation: the **senior
reviewer** judging the change without re-deriving it, and the **developer in four
months** who has hit a bug here. Neither can see your terminal.

Write what the diff cannot say: **why**, **what you rejected**, **what you
verified**, **what is still open**.

- **Specifics, not adjectives.** Not "fixed the caching bug" — "`resolve()` cached
  on the raw path, so `./a` and `a` were separate entries; normalised before the
  lookup in `src/core/cache.ts:88`".
- **Cite `file.ts:line`.**
- **Paste the evidence** — the command and its real output.
- **Record the rejected options.** Write each option you rejected and the
  reason. Then the next person does not reopen a decision you already made.
- **Name your uncertainty.** "Not sure this handles the empty case" tells the
  reviewer where to look first.
- **No "as discussed" or "see above".** The issue is the whole record.
- **No status theatre.** "Working on it", "almost done" — delete. Nothing factual,
  no comment.

### The handover note

```markdown
## What changed
- `src/core/cache.ts:88` — normalise the path before the lookup
- `test/cache.test.ts` — case for `./a` vs `a`

## Why this way
<The approach, and what it rests on.>

Rejected: <alternative> — <why not>.

## How I verified it
```
$ npm test
Test Files  19 passed (19)
     Tests  430 passed (430)
```
<Anything you could NOT verify, and why.>

## For the reviewer
- <The judgement call you are least sure of.>

## Follow-ups
- LP-58 — <work this uncovered, already on the board>
```

Drop sections that would be empty; never pad one to look thorough.

Long comments belong in a file:

```bash
lpm comment LP-42 -f ./handover.md
echo "sandbox is back up" | lpm comment LP-42 -f -
```

Comments live in a `_comments.md` beside the document, so they diff, merge and
blame like everything else. They are read on demand and written straight through —
even the web app does not queue them.

### Handing a ticket back

Do not just abandon it. **Flag it** with what you did, what you learned and
precisely what is blocking, then leave it with you — the flag already says it is
not moving — or ask for it to be reassigned. Include your dead ends; that is the
whole value of the trail. A flagged ticket is visible on the board, which a
ticket sitting in progress with a comment is not.

## Work you discover

Real implementation uncovers work the ticket did not mention. Absorbing it
silently hides scope; ignoring it loses it. Put it on the board:

```
create_document { type: "bug", title: "…", parent: "LP-13", body: "## Reproduce\n…" }
split_issue     { id: "LP-42", titles: ["…", "…"], mode: "children" }
link_issues     { blocked: "LP-42", blockedBy: ["LP-40"] }
```

Then reference the new id in your comment on the original ticket.

Do **not** reshape the plan beyond that. Re-parenting epics, changing types,
re-scheduling and re-assigning are the planner's job — if the structure is wrong,
say so in a comment.

## Hard rules

- Never hand-edit `.lpm/` markdown.
- Never invent a type, status or attribute name — use `board_overview`.
- Never close an issue you did not verify, and never report a test result you did
  not see.
- Never `force`-claim work assigned to someone else.
- Never start an issue whose brief you have not read. `get_instructions` is one
  call; skipping it is how you build the right code for the wrong reason.
- Never leave a ticket in progress with no comment. A silent in-progress issue is
  the worst state on the board: it looks claimed and teaches nobody anything.
- Never leave a ticket **stuck** without flagging it. Same failure, louder.
- Never clear your own flag to get past it — that is the plan owner's call.
- Never guess a path into `relatedFiles`. Add the ones you actually opened; a
  wrong one costs the next reader more than a missing one.
- A dependency outside your scope is still readable — scope narrows what is
  *offered*, never what is *reachable*. `get_document` reads any id.
