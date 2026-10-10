---
name: lpm-planning
description: Populate and reshape a light-plan board — writing epics, features and user stories with real requirements and a definition of done, breaking work into granular modular pieces, chaining it with dependencies, assigning it to people or pools, and scheduling it into sprints. Load this for "write stories for X", "break this down", "plan the sprint", "turn this brief into tickets", "assign this work", or any use of create_document / split_issue / insert_between / convert_document / copy_documents / link_issues.
roles:
  - pm
---

# Planning work on a light-plan board

Load the `lpm` skill first for the tool map and the routing mechanic, and
`lpm-writing` for how to write the text. The
`lpm-planner` agent in `.claude/agents/` applies this as a persona; this skill is
the workflow reference.

## Before you write anything

```
board_overview
list_templates
list_documents { kind: "issue", workUnitsOnly: false, limit: 100 }
```

You need the types and their exact `hierarchy`, the statuses, the
`priorityAttribute` and `effortAttribute`, and what already exists so you do not
duplicate it.

`list_templates` is the one people forget. The board's **registry** holds
reusable pieces of plan the team has already worked out — a feature with its
standard stories, the steps a particular kind of change has to go through. If
one covers what you are about to write, instantiate it rather than typing the
same shape again: it is faster, and creating it by hand quietly skips a process
somebody wrote down on purpose. `lpm-templates` is the full reference.

```
instantiate_template { id: "TPL-3", params: { name: "Payments" }, parent: "LP-14" }
``` **The hierarchy is enforced**: a type's index in the list is the
folder depth it must sit at, so plan the shape before you create the first
document.

## Creating documents

```
create_document {
  type: "user_story",              # a name from board_overview
  title: "Let a signed-out shopper pay with an email address",
  parent: "LP-14",                 # must be the type one level up
  attributes: { story_points: 5, priority: "high" },
  period: "TL-8",
  assignee: "RS-4",
  dependsOn: ["LP-40"],
  relatedFiles: ["docs/prd.md#L120-L164", "src/checkout/session.ts"],
  body: "## Context\n…"
}
```

```bash
lpm new user_story -t "Let a signed-out shopper pay with an email address" \
  -p LP-14 --set story_points=5 --set priority=high --period TL-8 --assignee RS-4 \
  --related "docs/prd.md#L120-L164" --related src/checkout/session.ts
```

Omit `body` to get the type's template from `.lpm/config.yml` — **prefer that**,
so every ticket on the board reads alike. Supplying `body` replaces the template
entirely, so keep the same headings. For anything long, use a file:

```bash
lpm set LP-42 --body-file ./story.md
```

Build **top-down**: the container first, then the leaves that carry the work.

## What makes a ticket startable

Load `lpm-writing` before you write a title or a body. It defines the style:
short sentences, facts instead of adjectives, no figurative or promotional
language. Load `lpm-writing-items` for what the body of each type must contain.
Load `lpm-writing-reviews` before you write a `review` issue.

A ticket is ready when someone who has never met you can read it and know what to
build, why, and when to stop.

```markdown
## Context
Why this exists, in two or three sentences — the user problem or the technical
force behind it, and what stays broken if it is not done.

## Requirements
- Specific, testable statements, each independently checkable.
- The real constraints: the endpoint, the format, the limit, the error case.
- What happens when it goes wrong, not only when it goes right.

## Definition of done
- [ ] The observable outcome, verifiable without you.
- [ ] Tests: which cases, at which level.
- [ ] Docs / config / migration touched, if any.
- [ ] Anything that must be true for the next ticket in the chain to start.

## Out of scope
What a reasonable developer might otherwise pull in.

## Notes
Where to start looking (`src/…`), prior art, decisions already made.
```

**Never omit *Definition of done*.** A ticket without it cannot be finished, only
abandoned — the developer will guess.

Titles name a capability in the user's language, specific enough to be
unambiguous in a list of forty. `Guest checkout` is a topic, not a ticket.

| Smell | Fix |
| --- | --- |
| "Improve error handling" | Name the errors and the behaviour for each |
| Requirements that restate the title | Write the actual constraints |
| Implementation steps as requirements | State the outcome; put suggestions in *Notes* |
| No *Out of scope* on anything vague | Add it — scope creep is the default |
| "Also update the docs" bolted on | Separate ticket, or an explicit DoD line |

Set the board's priority and effort attributes on **every leaf**. They are not
decoration: priority orders `next_tasks`, effort drives `team_load` and
`split --splitEffort`. Enum attributes accept only the values `board_overview`
lists.

### What the developer will actually read

Nobody reads a story on its own. `get_instructions { id }` / `lpm instructions
<id>` stacks the whole ancestry above it — programme, epic, feature, then the
story — and hands the developer one brief. So:

- **Do not restate the level above.** It is already there, immediately before
  yours, and repeating it buries the requirement.
- **A thin epic is a thin brief for every story under it.** The epic body is the
  only place "why" lives. Write it once, properly.
- **Check your own work with it.** `lpm instructions <id>` on a ticket you just
  wrote shows exactly what the developer gets. It is the cheapest review there is,
  and it catches the story that reads fine alone and explains nothing in context.

### Point the ticket at its files

`relatedFiles` is a list of paths on the issue, printed at the top of the brief
under *Files this is about*. Two entries are worth more than the rest:

- **The requirement you wrote it from**, with a line range where you have one:
  `docs/prd.md#L120-L164`. Your *Context* section says which part matters; this
  lets the developer read the source instead of your paraphrase of it.
- **The code you already know changes**, when you know it. When you do not, leave
  it out — a wrong path costs the reader more than a missing one, and the
  developer adds the real ones as they go.

Nothing is checked against the filesystem, so naming a file that does not exist
yet is fine and is often precisely the instruction.

```
update_document { id: "LP-42", relatedFiles: ["docs/prd.md#L120-L164", "src/checkout/session.ts"] }
```
```bash
lpm set LP-42 --related "docs/prd.md#L120-L164"      # --unrelated to detach
```

The payoff lands on the *next* ticket: where B depends on A, B's brief lists the
files A named under *what that work touched*. Sequencing tickets and naming their
files turns a dependency edge from "wait for that" into "read that first, and
here is where it landed".

## Breaking work down

Aim for leaves that are **one developer, a few days, one reviewable change**.

Split along seams that can be finished separately — a layer (schema → API → UI),
a user-visible slice (read-only → editing → bulk), a risk boundary (spike the
unknown first, then build on the answer). Avoid "part 1 / part 2", and anything
whose first piece cannot be merged and left alone.

The reshaping tools go through the same planners as the CLI and the web canvas, so
the graph is rewired for you: **whatever blocked the original blocks the first
piece, and whatever waited on it waits on the last.** Never rebuild that by hand.

```
split_issue { id: "LP-42", titles: ["Schema", "API", "UI"], mode: "children" }
```
Nests the pieces inside the original, which becomes a container. Use when the
parent is a meaningful unit that stays on the board.

```
split_issue { id: "LP-42", titles: [...], mode: "replace", splitEffort: true }
```
Puts the pieces where it stood and deletes it. Use when the original was simply
too big to be one thing.

**`chain` defaults to `true`** — each piece depends on the one before it. Right
for a layered split, wrong for independent work: pass `chain: false` or
`--no-chain`, or you will serialise the team by accident.

```
insert_between { source: "LP-4", target: "LP-7", title: "Validate the payload" }
convert_document { id: "LP-9", under: "LP-14" }                    # demote to fit
convert_document { id: "LP-9", type: "feature" }                   # change what it is
convert_document { id: "LP-9", under: "LP-14", buildParents: true } # create missing levels
copy_documents  { ids: ["LP-20"], under: "LP-31" }                 # repeat a structure
delete_document { id: "LP-20", recursive: true }
```

`insert_between` **replaces** the edge: `LP-4 → LP-7` becomes `LP-4 → new → LP-7`.

`copy_documents` keeps dependencies *within* the copied selection and repoints
them at the copies; edges leaving the selection are dropped, so the duplicate
stands on its own.

**Always `dryRun: true` first** on `split_issue`, `convert_document` and
`delete_document` when children or dependencies are involved. Read what it says it
will do.

## Sequencing

```
link_issues { blocked: "LP-42", blockedBy: ["LP-40", "LP-41"] }
link_issues { blocked: "LP-42", blockedBy: ["LP-40"], remove: true }
```

Only the forward edge is stored; the inverse is derived. A dependency that would
close a cycle is refused.

**`depends_on` is the only edge that gates the queue**; `relates_to` implies
nothing. So add a dependency only where the work really cannot start, and put
everything else — what the issue was written from, what it is like — in the body.

**An edge is inherited by everything inside the issue.** Link the two features
and every story under the second one waits for the first one's work — you do not
wire story to story to say "this feature comes after that one", and you should
not: a mesh of leaf edges says the same thing less clearly and goes stale the
moment somebody adds a story. Link at the level the gate is really at. A
dependency on a container is cleared when the work *inside* it is finished, not
when somebody moves the container to `done`, so a feature-level edge does not
need anyone to remember to close the feature.

**And an edge is reflected onto the containers above it, up to the one the two
ends share.** The other direction of the same rule: a story waiting on a story
in another feature puts those two features in that order, and the epics above
them. `link_issues` reports it as `alsoOrders` and `get_document` reads it back
as `rolledUpBlockedBy` / `rolledUpBlocks`, so you never have to write it down —
and you must not. Adding the container edge yourself makes it a real gate that
every piece of work inside it inherits, which stops a dozen stories that are
waiting on nothing. Write the edge where the gate really is, and read the levels
above it.

Two rules that keep a graph useful:

- **Add an edge only for a real gate** — B genuinely cannot start until A is done.
  "It would be tidier in this order" is a preference, and it will idle a
  developer.
- **Prefer a wide graph to a deep one.** Three chains of four running in parallel
  beat one chain of twelve. Look at what you built and ask how many people could
  start tomorrow; if the answer is one, you wrote a queue, not a plan.

When work comes out of a spike, the ordering is a dependency like any other:

```
link_issues { blocked: "LP-51", blockedBy: ["LP-30"] }
```

Two consequences to plan around:

- **Put the spike where it can run first.** A research task inside the very
  feature that waits on its findings deadlocks both — the feature waits on the
  spike, the spike inherits the feature's dependencies. `lpm check` reports it
  as a cycle. Hang a spike that several features wait on off the level *above*
  them.
- **Say what it found, in the body.** The queue only needs to know the order.
  Which measurement, which document, which numbers — that goes in LP-30's body
  and its related files, and it is what a developer actually reads.

`relates_to` is non-blocking association and is **CLI-only**:
`lpm link LP-7 --relates-to LP-9`.

## Assigning

```
update_document { id: "LP-42", assignee: "RS-4" }   # a pool
update_document { id: "LP-42", assignee: "RS-1" }   # a named person
update_document { id: "LP-42", assignee: null }     # back to the backlog
```

**Prefer the pool.** Assigning by name commits someone else's time and strands
work when they are away. Name a person when the work genuinely needs their
context, their area or their review.

Coverage connects a person to a pool, is one hop, does not chain, and is CLI-only:
`lpm link RS-1 --covers RS-4`.

**Split the work by who can do it.** A board worked by people and agents needs a
**Human Supervisor** and an **AI Agent** on the roster. If they are not there,
create them first (see `lpm-board-setup`). Then:

| Assign to | When the work is |
| --- | --- |
| AI Agent | Implementation an agent can finish alone: stories, bugs, tests, sub-tasks, spikes |
| Human Supervisor | A decision, an approval, a `review` gate, anything needing credentials or access an agent does not have |

If a story needs a human answer before an agent can build it, write two issues.
Assign the decision to the supervisor, assign the build to the agent, and make
the build depend on the decision. An agent should never be offered work it can
only flag.

```
team_load { period: "TL-8" }
```

Read three things: `uncovered` (pools nobody can serve — always fix), the
`unassigned` row (open work nobody owns), and each row's `open` and `effort`
against `capacity`. It is a **load report, not a scheduler**.

## Scheduling

**A simple project is not scheduled at all.** `lpm init` seeds an omni chain
(`Omni Product Increment` > `Omni Sprint`) and `default_period`, so every new
issue lands in the running omni sprint while that chain is the whole timeline.
Create increments and sprints only when somebody asks for calendar planning.
From the first one, new issues arrive unscheduled, so place them, move what the
omni sprint holds, and delete the omni increment when it is empty.

```
update_document { id: "LP-42", period: "TL-8" }
update_document { id: "LP-42", period: null }
```

Any issue at any level goes in any period. `next_tasks` puts the running or
overdue period first, then unscheduled work, then periods that have not started —
so scheduling is how you say "not yet" without blocking anything.

## Verify the plan actually routes

Writing the tickets is half the job.

1. **`check_board`** — broken references, cycles, hierarchy violations, periods
   that do not fit. Fix every error.
2. **`flagged_issues`** — is anybody stopped? Answer those before writing anything
   new; a flag is capacity sitting idle, and it costs more than any ticket you are
   about to add. See "Answering flags" below.
3. **Simulate the handoff**: `next_tasks { assignee: "<person>" }` for each person
   you planned for. That is what they will really be offered, pool work included.
   Nothing? Find out why — assigned to a container, blocked by something
   unfinished, in a pool nobody covers, or in a period that has not started.
4. **`team_load`** — is anyone carrying everything? Is anything uncovered?
5. **Read your weakest story with `get_document`** and ask whether you could start
   it cold. If not, it is not ready.

Report the result by what it enables — "9 stories under LP-14, three parallel
chains, Alice and the web pool are each offered work tomorrow, LP-51 waits on the
spike LP-30" — not by document count.

## Anti-patterns

| Doing this | Why it fails |
| --- | --- |
| Assigning an epic | Containers are never offered; assign the work units under it |
| Chaining every split | Serialises the team; use `chain: false` for parallel work |
| A dependency because it "feels ordered" | Idles a developer for nothing |
| Parking work in an uncovered pool | Nobody can ever pick it up |
| A story with no definition of done | Cannot be finished, only abandoned |
| Re-parenting or re-assigning in-flight work silently | Check `current_tasks`, and comment on the issue saying why |
| Hand-editing `.lpm/` markdown to "fix" structure | Use `convert_document` / `lpm convert`; the hierarchy is validated |
| Clearing a flag without answering it | Sends the developer back into the same wall, with the record now claiming it was dealt with |
| Planning new work while flags sit unanswered | Somebody has already stopped; new tickets do not help them |
| Guessing at `relatedFiles` | A wrong path costs the reader more than a missing one |

## Answering flags

A developer who cannot finish something flags it: the issue keeps its status and
assignee, turns red on the canvas, and carries a comment saying what stopped and
what would resolve it. `blocked` = something outside the issue has to happen
first; `paused` = deliberately set down; `help` = a person is needed.

**This is the planner's inbox.** Read it first:

```
flagged_issues                    # everything stopped, board-wide
list_comments { id: "LP-42" }     # why — a flag always carries one
```
```bash
lpm flag list
lpm comment LP-42 --list
```

Answer it before you clear it, and write the answer where it belongs rather than
only in a comment:

| The flag says | The fix |
| --- | --- |
| A requirement is missing or ambiguous | Put the answer in the issue body (`update_document`), not just in a reply — the next reader reads the body |
| A decision is needed | Record the decision *and* the reasoning, so nobody re-litigates it |
| Something has to happen first | `link_issues` — the flag was right and the sequencing was wrong |
| The ticket was too vague to build | Rewrite it. A flag is a bug report about your ticket |

Then, and only then:

```
clear_flag { id: "LP-42", comment: "<what changed, so the work can resume>" }
```
```bash
lpm flag clear LP-42 --comment "..."
```

Clearing is the plan owner's, not the implementer's — it means "carry on", and it
is a claim that the thing that stopped the work has actually been dealt with.

**You can raise one too.** `flag_issue` on an issue nobody has started is how a
planner says "do not start this yet" and is obeyed: the queue stops offering a
flagged issue in any column. Use it when the reason is outside the board (a
pending decision, a vendor, a scope review). When the reason is another issue,
use `link_issues` instead, because a dependency clears itself when that work
lands.

## End-to-end: a brief becomes a sprint

```
board_overview                                  # types, hierarchy, statuses, attributes
list_documents { kind: "issue", search: "checkout" }   # does it already exist?

create_document { type: "epic", title: "Checkout revamp", parent: "LP-1" }
create_document { type: "feature", title: "Guest checkout", parent: "LP-12" }

# the leaves, each written to the bar
create_document { type: "research", title: "Which PSPs support guest tokenisation?",
                  parent: "LP-13", attributes: { priority: "high" }, body: "## Context…" }
create_document { type: "user_story", title: "Let a signed-out shopper pay with an email address",
                  parent: "LP-13", attributes: { story_points: 5, priority: "high" },
                  relatedFiles: ["docs/prd.md#L120-L164", "src/checkout/session.ts"], body: "…" }
create_document { type: "user_story", title: "Send a guest order confirmation",
                  parent: "LP-13", attributes: { story_points: 3, priority: "medium" }, body: "…" }

# sequence: only real gates
link_issues   { blocked: "LP-15", blockedBy: ["LP-14"] }   # story waits on the spike
# LP-16 is independent — deliberately unchained, so two people can start

# route and schedule
update_document { id: "LP-14", assignee: "RS-1", period: "TL-8" }
update_document { id: "LP-15", assignee: "RS-4", period: "TL-8" }
update_document { id: "LP-16", assignee: "RS-4", period: "TL-8" }

# prove it
check_board
team_load  { period: "TL-8" }
next_tasks { assignee: "RS-1" }     # LP-14
next_tasks { assignee: "RS-2" }     # LP-16 via the pool; LP-15 correctly withheld
```
