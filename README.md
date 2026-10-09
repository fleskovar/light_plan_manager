# Light Plan

A lightweight, file-based issue tracker. Your Agile board lives in your repo as
folders and markdown files, versioned with git — no server, no database, no
account.

## Install

Requires Node 20+. The package is `light-plan` and the command it installs is
`lpm`:

```bash
npm install -g light-plan
lpm init
```

Or run it without installing anything:

```bash
npx light-plan init
npx light-plan ui
```

To get started:

```bash
cd my-project
lpm init        # create the board in .lpm/
lpm ui          # open it in your browser
```

`lpm init` writes the board into `.lpm/` in the current folder. It uses the
Scrum template (`--template kanban` or `--template blank` for the others) and
takes the issue-id prefix from the folder name (`--prefix LP` to choose your
own). It also makes `.lpm` a git repository of its own and adds it to your
project's `.gitignore`, so the board keeps its own history (`--no-git` skips
that). On a template with a timeline it also creates a standing **Omni Product
Increment** holding an **Omni Sprint**, and every new issue lands in that sprint
until you create a period of your own, so a simple project never has to plan
sprints at all ([the omni periods](#the-omni-periods); `--no-omni` skips them).

`lpm ui` starts a local server on `http://localhost:4571` and opens the editor
in your browser. What you change there is held as a draft until you press
**Push**, which writes it to `.lpm/`. Stop the server with Ctrl-C. To build a
board from the command line instead, see [Quick start](#quick-start).


The experimental features — [`lpm queue agent`](#draining-the-queue-with-an-agent-lpm-queue-agent) and
[Jira sync](docs/remote-jira.md) — need packages a standard install leaves out;
their sections say what to add.

### Agent configuration with hcm

light-plan ships agents (a developer and a planner), skills and an MCP server
for AI coding hosts. If you manage agent configuration with
[hcm](https://github.com/fleskovar/harness_config_manager)
(harness-config-manager), register the light-plan bundle once, then install it
into any project:

```bash
npm install -g harness-config-manager      # hcm itself, once per machine
lpm hcm init                               # register the bundle; again after each light-plan upgrade

# then, in each project
hcm install light-plan -t claude-code                  # developer and planner
hcm install light-plan -t copilot --flavor developer   # the developer agent only
hcm update light-plan                                  # after re-running lpm hcm init
```

`-t` names the harness (`hcm targets` lists them) and `--flavor` picks a role
(`developer` or `pm`). The MCP server starts as `lpm mcp`, so agents need `lpm`
on their PATH: install light-plan globally, not only through npx. Without hcm,
[`lpm agent`](#working-with-agents) installs the same files straight into a
project. The details are in
[The same assets as an hcm bundle](#the-same-assets-as-an-hcm-bundle) and
[docs/hcm.md](docs/hcm.md).

### From a checkout

```bash
make setup        # installs, builds, and puts `lpm` on your PATH
```

Requires GNU Make. Without Make:

```bash
npm install
npm run build
npm link          # puts `lpm` on your PATH
```

`make doctor` checks your machine before you start, and `make` on its own lists
every target. See [Development](#development).


## How a board is laid out

```
.lpm/
├── config.yml
├── INDEX.md                  every id, title and document, nested (generated)
├── board/                    what gets built
│   └── LP-1/                 program      — Payments platform
│       ├── _issue.md
│       └── LP-2/             epic         — Checkout revamp
│           ├── _issue.md
│           └── LP-3/         feature      — Guest flow
│               ├── _issue.md
│               ├── LP-4/     user story   — Guest checkout
│               └── LP-5/     bug          — Cart total
├── timeline/                 when it gets built
│   └── TL-1/                 product increment — 2026 H2
│       ├── _period.md
│       ├── TL-2/             sprint 1
│       └── TL-3/             sprint 2
├── team/                     who builds it
│   ├── RS-1/                 a person — Alice Smith
│   │   └── _resource.md
│   └── RS-4/                 a pool anyone can be drawn from — Jr. developer
│       └── _resource.md
└── templates/context/        what a developer is told to do it
    ├── default.md
    └── user_story.md
```

Folder nesting *is* the hierarchy. Each folder is one document; its markdown
file holds YAML frontmatter (the structured fields) plus a body (the narrative).
Everything is plain text, so diffs, blame, branches, and pull requests work
exactly as they do for code.

A folder is named after its **id and nothing else**. Ids are short and never
change, so a path stays quotable, a title can be rewritten without moving
anything, and a board nested five levels deep does not run into the limits git
and Windows put on a path. The titles live in
[`.lpm/INDEX.md`](#indexmd-the-board-as-a-table-of-contents), which every
command that adds, removes, moves or renames a document rewrites for you.

There are three collections. `board/` holds **issues** — what gets built, nested
by scope. `timeline/` holds **periods** — sprints and increments, nested by
duration. `team/` holds **resources** — the people who do the work and the
generic pools work can wait in. They are independent: an issue at any level can
be scheduled into a period at any level via its `period:` field, and assigned to
any resource via its `assignee:` field.

`templates/context/` holds no documents. It is the one folder the engine never
walks: the layouts `lpm instructions` renders a [working brief](#working-briefs-the-context-to-actually-do-it)
with, so a team decides what a developer is handed when they pick an issue up.

## Quick start

```bash
cd my-project
lpm init                                   # creates .lpm/ from the scrum template

# What gets built
lpm new program -t "Payments platform"     # -> LP-1
lpm new epic    -t "Checkout revamp" -p LP-1   # -> LP-2
lpm new feature -t "Guest flow"      -p LP-2   # -> LP-3
lpm new user_story -t "Payment gateway" -p LP-3 --set story_points=5
lpm new user_story -t "Guest checkout"  -p LP-3 --set story_points=3

# When it gets built
lpm new increment -t "2026 H2"  --starts 2026-07-01 --ends 2026-12-31   # -> TL-1
lpm new sprint    -t "Sprint 1" --starts 2026-08-03 --ends 2026-08-14 -p TL-1

# Who builds it
lpm new person -t "Alice Smith"                        # -> RS-1
lpm new role   -t "Jr. software developer" --capacity 3   # -> RS-2, a pool of three
lpm link RS-1 --covers RS-2                # Alice can pick up the pool's work

# Wire it together
lpm link LP-5 --depends-on LP-4            # LP-5 is blocked by LP-4
lpm move LP-4 --period TL-2                # schedule into Sprint 1
lpm move LP-4 --assignee RS-2              # park it in the junior pool

# Reuse what the team already worked out
lpm template list                          # the registry: reusable pieces of plan
lpm template apply TPL-3 --set name=Payments --under LP-4

# Work it
lpm me "Alice Smith"                       # this checkout is Alice's
lpm task next                              # what should I do?
lpm task start                             # claim it and start the clock
lpm task done

lpm queue simulate --user "Alice Smith"    # her whole run, if she worked alone

lpm check                                  # validate everything
```

`lpm new <type>` decides what to create from the type name: issue types land in
`board/`, period types in `timeline/`, resource types in `team/`. A name can't
mean two of those — the config rejects that.

A generated issue:

```markdown
---
id: LP-5
type: user_story
title: Guest checkout
status: backlog
assignee: RS-1
period: TL-2
depends_on:
  - LP-4
relates_to: []
related_files:
  - docs/prd.md#L120-L164
  - src/checkout/session.ts
created: 2026-07-31T15:02:27.576Z
updated: 2026-07-31T15:03:10.114Z
author: Jane Doe <jane@example.com>
story_points: 3
priority: medium
labels: []
---

As a **<role>**, I want **<capability>**, so that **<benefit>**.

## Acceptance Criteria

- [ ] **Given** <context> **when** <action> **then** <outcome>
```

## Dependencies

Two reserved fields on every issue:

| Field | Meaning |
| --- | --- |
| `depends_on` | Issues that block this one. Directional, cycle-checked. |
| `relates_to` | Non-blocking association. No ordering implied. |

```bash
lpm link LP-7 --depends-on LP-3
lpm link LP-7 --depends-on LP-3,LP-4 --relates-to LP-9
lpm link LP-7 --depends-on LP-3 --remove
lpm new user_story -t "Checkout" -p LP-3 --depends-on LP-4
```

`depends_on` is the only edge the engine acts on. There used to be a third,
`informed_by`, for the research an issue rested on — it gated the queue in
exactly the same way, which made it a second name for one relationship. It is
gone: why an issue is written the way it is belongs in its body and its
[related files](#related-files), and if work cannot start until a question is
answered, that is a dependency. A board still carrying the field is migrated by
`lpm check --fix`, which merges the ids into `depends_on`.

**Only the forward edge is stored.** The inverse — "what does this block?" — is
derived when the board loads and exposed as `board.dependents`. Storing both
sides would mean two files to keep in sync on every change, and a whole class of
reconciliation bugs for `check --fix` to chase.

**A dependency is inherited by everything inside the issue.** A story sits in a
feature, and a feature that waits on another feature waits on it *with
everything in it* — so you write the edge once, between the two features, and
the queue holds back every story under the second one. You do not have to wire
each story to each other story, and `lpm task next` will not hand somebody the
stories of a feature whose predecessor has not been started.

**A dependency on a container is cleared by the work inside it**, not by the
container's own status. Nobody moves a feature through the columns — the stories
under it are what get worked — so `LP-7 --depends-on LP-3` is satisfied once
every open piece of work under `LP-3` is finished, whatever column `LP-3` itself
is sitting in. Closing `LP-3` outright still answers for its contents, and
`lpm task next` names the dependency the way you wrote it (the feature, not the
five stories in it), because that is the document you would open to see where it
stands.

```bash
lpm link LP-4 --depends-on LP-3   # feature LP-4 after feature LP-3
lpm task next                     # ...and no story under LP-4 is offered yet
lpm queue simulate                # the whole sequence, in dependency order
```

**A dependency is reflected onto the containers above it, up to the one they
share.** The inheritance above runs downward — an edge on a feature holds back
every story in it. This is the same fact read upward. A story in *Guest flow*
waiting on a story in *Sign-up* means *Guest flow* stands behind *Sign-up*, and
the two epics above them stand in the same order, and so on until the container
they both sit in, inside which there is nothing left to order. Write the edge
between the two pieces of work that actually have it; the levels above it are
read off the graph:

```bash
lpm link LP-4 --depends-on LP-7
# Linked LP-4  Guest checkout
#   depends on   + LP-7
#   also orders LP-3  Guest flow  after LP-6  Sign-up
#   also orders LP-2  Checkout  after LP-5  Accounts

lpm upstream LP-3                 # ...and the feature reads it back
```

The reflection is **never written onto those containers**, and both halves of
that are deliberate. A `depends_on` on *Guest flow* would be inherited by every
story in it, so one story waiting on one story would hold back a dozen that are
waiting on nothing. And the reflection is not acyclic — two features that each
contain a story waiting on the other are an ordinary plan, and writing that down
would produce a loop `lpm link` has to refuse. So it is read, never gated: it
changes nothing about what the queue offers, and a loop in it is a fact about
the plan rather than a stall. It shows up in `lpm link`, in `lpm upstream`, in
the MCP `get_document` (`rolledUpBlockedBy` / `rolledUpBlocks`) and in the web
side panel, always naming the written dependency it comes from.

`lpm link` refuses an edge that would close a cycle, so bad state never reaches
the files. `lpm check` catches cycles introduced by hand-editing or by a merge,
along with references to issues that don't exist, self-references, and
duplicates. It also warns when a *done* issue is blocked by an unfinished one.
An edge pointing at one of the issue's own ancestors is ignored when work is
ranked rather than treated as a block — it could only stall the work on itself.

## Related files

An issue is usually about some code. `related_files` says which:

```bash
lpm new user_story -t "Guest checkout" -p LP-3 \
  --related "docs/prd.md#L120-L164" --related src/checkout/session.ts

lpm set LP-5 --related src/checkout/pay.ts        # attach another
lpm set LP-5 --unrelated src/checkout/session.ts  # detach one
```

Each entry is a path from the project root, optionally with a line range —
`docs/prd.md#L120-L164` points at the paragraphs of the PRD the story was written
from, `src/checkout/session.ts` at the module it will change. It is plain text
and **never checked against the filesystem**: an issue naming a file that does
not exist yet is usually the point of the issue, and a board that failed `check`
because somebody renamed a module would teach people to stop filling this in.

Two things read it. A working brief prints the issue's own files under *Files
this is about* — the first thing to open — and, for each issue this one was
sequenced after, the files that work touched. And the web app shows them in the
side panel, where they can be edited as one path per line.

That second part is what makes the field worth the typing. A story that says
"depends on LP-4" tells you the order; a story that says "depends on LP-4, which
touched `src/checkout/session.ts`, and I am about to change the same file" tells
you to go and read what LP-4 did first.

## Time hierarchy

Periods answer "when does this get built?". They are configured exactly like
issue types — their own hierarchy, their own attributes, their own body
templates — and live under `.lpm/timeline` with real files carrying their own
metadata:

```markdown
---
id: TL-2
type: sprint
title: Sprint 1
starts: 2026-08-03
ends: 2026-08-14
created: 2026-07-31T16:52:14.421Z
author: Jane Doe <jane@example.com>
goal: Guests can pay without an account
capacity: 34
committed_points: 31
completed_points: null
---

## Sprint Goal

One sentence the team can rally behind.

## Review
...
## Retrospective
...
```

`starts` and `ends` are reserved and required. Everything else — goal, capacity,
committed/completed points, PI objectives, retro notes — is configurable
per period type.

```bash
lpm new increment -t "2026 H2"  --starts 2026-07-01 --ends 2026-12-31
lpm new sprint    -t "Sprint 1" --starts 2026-08-03 --ends 2026-08-14 -p TL-1

lpm move LP-4 --period TL-2     # schedule
lpm move LP-4 --period none     # unschedule
lpm move TL-3 --parent TL-4     # re-parent a period
```

### The omni periods

A project that does not plan by the calendar should not have to invent sprints
before it can work. So `lpm init` seeds one standing period per level of
`period_hierarchy` — `TL-1 Omni Product Increment` holding `TL-2 Omni Sprint` on
the Scrum template, `CY-1 Omni Delivery Cycle` on Kanban — each running for a
year from the day the board was made, and writes `default_period: TL-2` into the
config. Every new issue nobody scheduled lands there, from the CLI, the web app
or an agent alike, so the running sprint holds the whole board.

The catch-all stops the moment you plan for real. As soon as the timeline holds
a period that is not part of the omni chain, new issues arrive unscheduled for
you to place, because ranking them beside your sprint would undo the plan. What
the chain already caught stays there until you move it. When you are done with
it, `lpm rm TL-1` deletes the chain and unschedules what is left, and the
`default_period` line can go.

```bash
lpm new user_story -t "Fix login" -p LP-3                 # scheduled in TL-2
lpm new user_story -t "Someday" -p LP-3 --period none     # left unscheduled
lpm period TL-2 --start-now                               # a year on: renew it
```

A pull from a tracker never uses the catch-all: an issue the tracker holds
unscheduled arrives unscheduled. The full rules are in
[docs/periods.md](docs/periods.md#the-omni-periods).

### Which period is running

A period runs when today falls inside it, and that is all most boards ever need.
But plenty of teams do not plan by date, and every team occasionally needs to
reroute people mid-sprint — so there is a switch held over the calendar:

```bash
lpm period TL-2              # how it stands right now
lpm period TL-2 --on         # run it whatever the dates say
lpm period TL-2 --off        # park it
lpm period TL-2 --dates      # take the switch off; the calendar decides again
lpm period TL-2 --start-now  # move it to start today, keeping how long it runs
```

`--on` and `--off` write one optional reserved field, `active`, on the period
document; `--dates` removes it. **Absent is the normal state** — a board that
never touches the switch behaves exactly as it always did.

The two directions are deliberately not symmetric. Switching a period **off**
parks everything nested inside it: "not this quarter" would mean nothing if its
sprints kept running. Switching one **on** speaks for that timebox alone,
because a live quarter has never meant all six of its sprints are this week.

What it changes is *what gets offered*, never what is reachable. Work in a
switched-off period sinks below even unscheduled work in `lpm task next`, the
MCP `next_tasks` and the queue — which is what makes the switch a way to steer
a team at short notice. Nothing is hidden, and no document becomes unreadable.

`--start-now` is the other half: it rewrites dates rather than overriding them.
The period takes today and keeps how long it runs, every period nested inside it
moves by the same number of days so a restarted increment keeps its shape,
whatever else was running is closed yesterday, and the periods above stretch to
reach. In the web UI both live on every box in the Periods tab: a toggle, and a
"Start now" button that says what it is about to change before it changes it.

### When a sprint overruns

A period whose end date has passed while work in it is still open is flagged in
red, on the CLI and in the Periods tab. There are exactly two honest answers,
and both are offered rather than one being chosen for you:

```bash
lpm period TL-2 --complete    # move the open issues to the board's end state
lpm period TL-2 --carry-over  # move them into the next period beside it
```

Completing records that the team stopped, not that the work happened. Carrying
over leaves what was finished where it was delivered — that is the record of the
sprint — and moves the rest one period along. Neither invents a period, so
carrying work down a run is what makes the last sprint's backlog grow, which is
the fact worth seeing. When there is no period after the one being corrected,
the command refuses rather than quietly unscheduling the work.

Both act only on issues scheduled *directly* in the period: an increment answers
for its own epics, and the sprints inside it answer for their own stories.

[`docs/periods.md`](docs/periods.md) is the full reference: how the dates and the
switch combine, exactly what each bucket of the work queue holds, and what
restarting or correcting a period moves.

Because the hierarchies are independent, a feature can sit in an increment while
its stories sit in individual sprints — the transversal cut. `lpm check`
validates that periods have real dates, that `ends` is not before `starts`, that
a child period fits inside its parent, that siblings don't overlap, and that
every issue's `period` points at a period that exists.

It also warns when **an issue is scheduled before something it depends on**:

```
warn  scheduled in TL-2 (2026-08-03) but depends on LP-4,
      scheduled later in TL-3 (2026-08-17)
```

That check is the reason both features earn their keep together.

Periods are opt-in. Drop `period_prefix`, `period_hierarchy` and `period_types`
from the config and the timeline disappears; the `blank` template ships without
them.

## Team and resources

Resources answer "who does the work?". They live under `.lpm/team`, are
configured exactly like issue and period types, and come in two flavours:

| | What it is | Example |
| --- | --- | --- |
| **named** | A person | Alice Smith |
| **generic** | A pool of interchangeable people | "a jr. software developer", "a data scientist, any level" |

Which one a document is comes from its **type**, not from the document —
a resource type declared `generic: true` describes a pool:

```yaml
resource_types:
  person:
    label: Person
  role:
    label: Role
    generic: true
```

```markdown
---
id: RS-4
type: role
title: Jr. software developer
capacity: 3
covers: []
created: 2026-07-31T16:12:02.104Z
author: Jane Doe <jane@example.com>
discipline: backend
level: junior
skills: [typescript, sql]
---

## What this pool covers
```

`capacity` is full-time equivalents: `1` a full-timer, `0.5` someone part-time,
`3` a pool of three. `0` means unavailable, and `lpm check` warns if you assign
work to them anyway.

```bash
lpm new person -t "Alice Smith" --set email=alice@example.com
lpm new role   -t "Jr. software developer" --capacity 3 --set level=junior
lpm new person -t "Bob Jones" --capacity 0.5

lpm move LP-4 --assignee RS-1        # to a person
lpm move LP-4 --assignee "Jr. soft"  # by name, or a unique prefix of one
lpm move LP-4 --assignee none        # back to nobody
```

Park work in a pool and anyone who **covers** that pool can pick it up:

```bash
lpm link RS-1 --covers RS-4          # Alice can work as a junior developer
lpm link RS-1 --covers RS-4 --remove
```

Coverage stores only the forward edge, exactly like `depends_on`; the inverse is
derived at load time into `board.coveredBy`. It is one hop and not transitive: a
pool covering a pool does not chain.

`lpm team` shows who is carrying what:

```
Roster
  RS-1    Alice Smith            person  1 FTE    open 4  wip 1  done 2  story_points 13  covers RS-4
  RS-2    Bob Jones              person  0.5 FTE  open 1  wip 0  done 0  story_points 3

Pools
  RS-4    Jr. software developer pool    3 FTE    open 7  wip 0  done 1  story_points 21  covered by RS-1
  RS-5    Sr. data engineer      pool    1 FTE    open 3  wip 0  done 0  story_points 8   nobody covers this

  --      (unassigned)                            open 2  wip 0  done 0  story_points 5

Total  5.5 FTE  ·  17 open  ·  1 in progress  ·  50 story_points  ·  9.1 per FTE

warn RS-5 (Sr. data engineer) holds open work but nobody covers it
warn 2 open issue(s) have no assignee
```

`lpm team --period TL-2` scopes it to one sprint (and its child periods), which
is where over-commitment actually shows up. Only **work units** are counted, so a
feature does not double-count the stories under it, and a story marked
[`atomic`](#the-unit-of-work) does not double-count its own sub-tasks.

This is deliberately a **load view, not a scheduler**: it reports demand against
declared capacity, and names the two situations that mean work simply cannot
happen — a pool nobody covers, and open work nobody owns. What "too much" means
for your team stays your call.

The roster is opt-in the same way the timeline is: drop `resource_prefix`,
`resource_hierarchy` and `resource_types` and `team/` disappears.

### Squads

A **squad** is a named sub-team of resources — "Frontend", "Platform", "Data".
When a period is owned by a squad, only that squad's members are offered work
from it. This lets two teams run independent plans inside one board: one
increment per squad, sprints grouped under it, and `lpm task next` shows each
person their squad's work.

Squads are configured exactly like the rest, and opt-in the same way:

```yaml
squad_prefix: SP
squad_types:
  squad:
    label: Squad
    attributes: {}
squad_hierarchy:
  - squad
```

A squad document lists its members:

```markdown
---
id: SP-1
type: squad
title: Frontend
members: [RS-1, RS-5, RS-8]
created: 2026-08-03T12:00:00.000Z
author: Alice Smith <alice@example.com>
---
```

Assign a squad to a period (`lpm set TL-1 --squad SP-1`), and the period's work
is gated through the routing. A sprint with no squad inherits from its
increment, the same way the `active` switch cascades; a sprint can override with
its own.

The squad engine lives in `src/core/board/query.ts` (`effectiveSquad`),
`board/tasks/ranking.ts` (the `candidatesFor` gate), and `board/load.ts`
(`periodSquadMembers`). The web UI manages squads in the Team drawer.

## Working as a team member

Tell light-plan who you are, then ask it what to do:

```bash
lpm me "Alice Smith"      # or `lpm me RS-1`; `lpm me` alone prints it
lpm task next             # what to work on, best first
lpm task start            # claim the top one: assign it to you, start it
lpm task current          # what you have in flight
lpm task done             # move it to the board's end state
lpm task prev             # what you finished most recently
```

```
$ lpm task next
Next up for RS-1 Alice Smith
  LP-12   Guest checkout           User Story · ready     TL-2
  LP-9    Cart totals              User Story · backlog   TL-2 · pool RS-4

Claim the first with lpm task start
```

`lpm task next` offers **work units** that are assigned to you, or parked in a
pool you cover, and that nothing unfinished is blocking. Add `--unassigned` to
include work nobody owns. Containers (an epic with children) are never offered —
the work units under them carry the work. Which issues are units is a config
question; see [the unit of work](#the-unit-of-work).

Work in a period somebody has [switched off](#which-period-is-running) is **not
offered at all** — off means "not this one", and ranking it last would only
delay it until the rest of the queue emptied. `--parked` considers it anyway,
and `lpm open`/`lpm task start <id>` reach it by id regardless: this is routing,
not permission.

The order of what remains is: the running or overdue period first, then
unscheduled work, then periods that have not started; within that, the board's
`priority_attribute`, then the column closest to done, then **the part of the
plan that is already under way**, then how much each issue unblocks, then age.

That middle step is what keeps a queue from handing out one story from every
feature in turn. When nothing a person set by hand separates two stories, the
one whose feature somebody is already inside comes first, then the one whose
feature is closest to finished, and work in an untouched feature comes last.
The question is asked of the outermost level the two do not share, so an epic
under way is preferred before its features are ever compared, and two stories
in the same feature are never separated by it.

`lpm task start [id]` assigns the issue to you and moves it to the first status
marked `active: true`; `lpm task done [id]` moves it to the first `terminal: true`
one. Both take an id, and both default to the obvious one — the top
recommendation for `start`, your single in-flight issue for `done`. Claiming
someone else's issue needs `--force`.

#### Claiming is atomic

`lpm task next` is a recommendation, and between reading it and acting on it
somebody else may have taken the same issue — another developer in the same
checkout, an agent, a `lpm queue agent` run. So `start` is not "write my name on
it". It takes the board's write lock, **re-reads the board**, checks the issue is
still free as it stands on disk, and only then writes:

```
$ lpm task start LP-12
error LP-12 is already being worked on by Bob Chen (RS-2)
      It is "in_progress" on the board as it stands now, and Alice Smith (RS-1) is asking for it.
      Force takes it off somebody who is part-way through it. Take something else instead.
```

The claim is recorded in the issue document itself, not only in its frontmatter:

```yaml
---
id: LP-12
assignee: RS-1
status: in_progress
---
```

```markdown
<!-- lpm:activity -->

## Activity

### 2026-08-16T09:14:02.104Z — Alice Smith (RS-1) — claimed
```

The frontmatter is what withholds the issue from everybody else's queue — work
in an active status is never offered, and the rest is routed by assignee — and
the activity line is how a person reading `_issue.md` in a file tree, or a diff
in the board's git history, finds out who took it and when. The same is true of
the MCP `start_task` and of every task `lpm queue agent` picks up.

A run that loses a claim is not a run that failed. `lpm queue agent` asks the
queue again and takes the next thing; the issue it lost is left completely
untouched — no flag, no comment, no status change. If it loses several in a row
it stops and says so, rather than spinning against whoever is out-claiming it.

This is one half of what makes a `.lpm` folder safe to share; the other half is
[below](#several-people-and-agents-one-checkout).

#### A parent's status is derived

Nobody works a feature: the stories under it are what get worked, and the
feature is a name for them. So a container's status comes from its contents.
Finish the last open issue in a feature and the feature is finished too, and its
epic with it if that was its last open feature — as far up as it goes. Reopen
one and they reopen with it, and adding a new issue inside a finished container
reopens it as well.

`terminal: true` is the whole of what "finished" means here — nothing in
light-plan knows the word "done", it reads the flag. When a board declares more
than one end state, a parent closes into the one its children agree on, and into
the first one declared when they do not.

It happens wherever work is moved — `lpm task done`, `lpm move --status`, the
MCP `finish_task` and `update_document`, and pushing from the web app — because
it lives in the operation the three of them share. Each container it carries is
printed by the CLI, listed in `rolledUp` by the MCP tools, and recorded in the
parent's own activity section, so a status nobody typed always says where it
came from.

Two things follow. Anything waiting on a feature is offered the moment its last
story is closed, without anybody remembering to tick the feature off. And a
board where that never happened — frontmatter edited by hand, a merge that took
one side of a status, a board written before this existed — is repaired by
`lpm check --fix`, which reports every container out of step with its contents
and rolls it up.

Who you are is stored in `.lpm/local.json`, which `lpm init` adds to
`.lpm/.gitignore`: the board is shared, but who is at this keyboard is not.
`LPM_USER=RS-2 lpm task next` overrides it for one command.

### Running the queue forward: `lpm queue simulate`

`lpm task next` answers "what now?" one step at a time. `lpm queue simulate`
answers the other question — *if this one person were the only contributor,
what would they work on, and in what order?* It takes the top of the queue,
marks it finished in memory, asks again, and keeps going until nothing is left
that they could pick up:

```bash
lpm queue simulate                      # you
lpm queue simulate --user "Alice Smith" # a person on the roster
lpm queue simulate --role "QA engineer" # a pool: anyone working out of it
lpm queue simulate --user alice --skipped --unassigned --limit 20
```

```
$ lpm queue simulate --user alice
Queue simulation for RS-1 Alice Smith (person)

       id      title                               type           effort   total
  1.   LP-12   Guest checkout                      User Story          3       3  TL-2 · frees LP-14
  2.   LP-9    Cart totals                         User Story          2       5  TL-2 · pool RS-4
  3.   LP-14   Apply a promo code                  User Story          5      10  TL-2

Total  3 tasks  ·  10 story_points
2 open issues never reached — see them with lpm queue simulate --skipped
```

`--user` names a person and `--role` names a pool (a resource type declared
`generic: true`). They are separate flags on purpose: simulating a pool as
though it were a person answers a question nobody asked, so the command says
which one you gave it rather than guessing.

**It is `lpm task next` in a loop, not a second opinion about it.** Every rule
about what may be picked up — routing, pools, work units, blockers, your
profile's scope, switched-off periods — lives in the engine and reaches the run
only through `nextTasks`, against a board with the earlier steps marked
finished. A developer stepping through `lpm task next` by hand gets this
sequence, and runs out where this runs out. That is the point of the command, so
it is also what the tests pin down.

Two consequences worth knowing:

- **Work already in progress goes first — unless it is flagged.** The queue does
  not offer what has already been picked up, so a run that ignored it would
  report everything waiting on it as blocked forever. A flag is where that stops:
  it says the work *has* stopped and needs a person, and nobody else is in this
  run to clear it, so starting from it would assume away the very thing holding
  the queue up. Flagged work is listed under `--skipped` instead, and counted
  under the run, which is what makes this agree with `lpm task next` and
  `lpm queue agent` on a stalled board. `lpm queue agent` resumes in-flight work
  by the same rule, so the prediction is of the run and not of a different
  reading of the board.
- **Nothing is written and no clock moves.** The board is untouched, and `today`
  stays fixed for the whole run, so a period that has not started stays
  unstarted. This reports an *order*, never a schedule: light-plan does not know
  how long a task takes, so it adds up effort and stops there.
- **Parked sprints are left out and counted.** Whatever the switch withholds
  from `lpm task next` is withheld here too, and the total says how much, so a
  short run is never a mystery. `--parked` includes it.

`--skipped` is the other half of the answer. Nobody else is contributing, so
work held by someone else is never finished and anything waiting on it waits
forever — which is usually the thing you opened the command to find out:

```
$ lpm queue simulate --user alice --skipped
...
Never reached
  LP-20   Settlement report                     assigned to RS-2 (Bob Jones)
  LP-21   Reconcile the ledger                  waiting on LP-20
  LP-22   Refund flow                           already in progress under RS-4 (Web developer)
  LP-23   Import legacy carts                   assigned to nobody — try --unassigned
  LP-24   Audit the payment providers           flagged by RS-1 (Alice Smith) — the work has stopped until somebody clears it
```

If you use a [profile](#profiles-giving-one-developer-one-part-of-the-board),
its scope narrows a simulation of **you**, because that is the queue you are
actually offered. Simulating somebody else uses the whole board: you do not hold
their profile.

Like `lpm team`, this reports — it never levels load, assigns anything or writes
a date.

### Draining the queue with an agent: `lpm queue agent`

`lpm queue simulate` predicts the order; `lpm queue agent` *works* it. It takes
the top of the queue, hands the issue's brief (the same one `lpm instructions`
prints) to an isolated [pi](https://pi.dev) coding-agent run with a fresh
context, reads back what the agent reports, and records the outcome the way a
person would — `lpm task done` on success, a flag on failure — then picks the
next task and repeats.

```bash
lpm queue agent --user alice --max-tasks 3        # do the next three, as Alice
lpm queue agent --model anthropic:claude-opus-4-5 --effort high
lpm queue agent --commit task                     # commit after each finished task
lpm queue agent --file agent.yml                  # take options from a YAML file
lpm queue agent --dry-run                         # show the next pick and its brief
```

| Option | Meaning |
| --- | --- |
| `--user <id\|name>` | Route the queue to this person (default: `lpm me`) |
| `--max-tasks <n>` | Stop after this many tasks are picked up |
| `--model <spec>` | Pi model, as `provider:model` |
| `--effort <level>` | Thinking level: `off … max` |
| `--commit <mode>` | `none` (default), `task`, or `parent` |
| `--unassigned` / `--parked` | Widen the queue, exactly as `lpm task next` does |
| `--timeout <secs>` | Per-task wall-clock cap |
| `--command-timeout <secs>` | Kill any single shell command after this long (default 300) |
| `--plain` | Log one line per event instead of drawing the live view |
| `--file <path>` | Read all of the above from YAML (CLI flags win) |
| `--dry-run` | Pick and brief the next task, but run and write nothing |

It works the **same queue** `lpm task next` offers — routing, scope, work units,
blockers and parked periods all still apply — and it finishes every piece of work
under one parent before moving to the next, so a feature lands together. Each run
leaves a comment on the issue and a full JSON log under `.lpm/runs/` (tools used
and in what order, timing, tokens and cost when the provider reports them). On
failure the issue is flagged for a human and the run moves on; a flagged task is
never retried.

Before it asks for anything new, a run **carries on with what this person is
already holding**: a task an earlier run claimed and did not finish — a crash, a
timeout, a run you interrupted — is left in progress, and the queue never offers
work in progress, so nothing else would ever return to it and everything waiting
on it would stay blocked. This is the same rule `lpm queue simulate` seeds its
prediction with, so the two commands cannot disagree about it.

A flag is where that stops, and because of it a run can stop with the board
apparently full of work: everything left is waiting on issues this person is
already holding, and those are flagged. The run says so rather than just
reporting an empty queue — it lists what they hold, marks which of it is flagged,
and points at the comments that explain why. Clearing the flag
(`lpm flag clear <id> -m "..."`) hands the work back to the next run; finishing
it yourself does the same.

#### Watching a run

On a terminal the run draws a small pane at the bottom of the screen, on stderr,
and rewrites it in place:

```
  LP-14  Guest checkout form validation                       task 2 · 4m 31s
  agent working · bash npm test -- --run src/checkout             7 tools
  ───────────────────────────────────────────────────────────────────────────
  ── LP-14  Guest checkout form validation
  Adding the validator and a test for it.
  ❯ bash npm test -- --run src/checkout
   ✓ src/checkout/validate.test.ts (4 tests)
   Test Files  1 passed
  ↑↓ PgUp/PgDn scroll · Ctrl+C stop                             12 lines back
```

The top two lines say which task, which stage of it (claiming, briefing, agent
working, recording, committing), and what the agent is running right now. Under
them is the tail of the run: what the agent is saying, the tools it calls and
what they print. **↑/↓** and **PgUp/PgDn** scroll back through it — the view
holds its place while new output arrives, and starts following again when you
reach the end. **Ctrl+C** stops the run; the task stays in progress and the next
run picks it back up.

The pane is a window, not a transcript. The whole story of a task is on the
issue: a comment when it ends, and the full JSON log under `.lpm/runs/`.

Redirect the output — or pass `--plain` — and there is no pane at all: one line
per event, no escape codes, which is what you want in CI or a log file. The
report at the end always goes to stdout, so `lpm queue agent > run.txt` is a
clean file either way.

#### A run nobody is watching

The point of the command is that it does not stop, so the agent's shell is set
up for a terminal with nobody at it:

- **Pagers print and exit** and **editors return immediately** (`PAGER`,
  `GIT_PAGER`, `GIT_EDITOR`, `EDITOR`, `VISUAL`, …), so `git log`, a `git commit`
  with no `-m`, and `lpm open LP-4` — which spawns `$VISUAL`/`$EDITOR` and waits
  for the window to close — cannot sit there waiting for a keypress.
- **`CI=true`**, which is how a test runner is told to run once instead of
  starting in watch mode, and how most scaffolders are told not to ask
  questions.
- **A command that would open a file in another program is refused** — `start`,
  `open`, `xdg-open`, `code`, `explorer`, `less`, `man`, `vim`, `tail -f`,
  `Start-Process`, `git add -p` and their like. The agent gets an error saying
  what was refused and what to do instead, and carries on.
- **Everything else is killed at `--command-timeout`** (300s by default). A
  command the agent gives its own timeout keeps that one; this only fills in a
  cap where there was none.

This is a guard against a stuck run, not a sandbox: the agent still has a real
shell in your project, and an agent that wants to get around the refusal can. It
is there because one `start report.md` used to hold a whole queue open until
somebody noticed.

`--commit` decides what happens to the code the agent wrote in your project:
`none` leaves it in the working tree for you to review, `task` commits after each
finished task, and `parent` commits once *all* the work under a task's parent is
done. Commits are made in the **project** repo, not the `.lpm` board — commit the
board (statuses, comments, run logs) yourself.

`lpm queue agent` is **experimental**, so the pi agent it drives is not installed
with light-plan (it needs Node 22.19+). Install it beside light-plan — with `-g`
when light-plan is installed globally, without it in a project:

```bash
npm install -g @earendil-works/pi-coding-agent @earendil-works/pi-ai
# or, through npx:
npx -p light-plan -p @earendil-works/pi-coding-agent -p @earendil-works/pi-ai lpm queue agent
```

`--model` takes `provider:model` for **any provider pi supports** — Anthropic,
OpenAI, DeepSeek, Google, Groq, Mistral, xAI, and others. Set that provider's API
key in the environment and pi picks it up; omit `--model` to use pi's default.

```bash
export DEEPSEEK_API_KEY=...     # or ANTHROPIC_API_KEY, OPENAI_API_KEY, ...
lpm queue agent --model deepseek:deepseek-v4-pro --max-tasks 1
```

(Exact model ids come from the installed pi version's catalog; the pi CLI or its
docs list what each provider offers.)

⚠️ The agent runs with real `bash` and `write` tools on your project. Running it
unattended is a decision you make; review what it produces, and prefer
`--max-tasks` and `--dry-run` while you learn how it behaves on your board.

## When the work stops: flags

Sometimes work you have picked up cannot go on. A credential expired, a decision
has not been made, a question needs somebody who knows the area. Moving the issue
back to the backlog would be a lie — you are holding it — and leaving it in
progress is a quieter one, because the board goes on saying it is being worked.

A **flag** says the third thing:

```bash
lpm flag --comment "Sandbox credentials expired; asked ops on #infra"
lpm flag LP-12 --reason help --comment "Need a decision on the retry budget"
lpm flag list                             # everything stopped, across the board

# the plan owner's side:
lpm flag clear LP-12 --comment "New credentials in the vault; carry on"
```

| Reason | Means |
| --- | --- |
| `blocked` (default) | something outside this issue has to happen first |
| `paused` | deliberately set down; the work is fine, the timing is not |
| `help` | a person is needed — a decision, a review, a pair of eyes |

A flag is **not a status**. The issue keeps its column and its assignee: it is
still yours, still in progress, and the flag says it is not moving. That is a
different claim from "nobody has started this", and it is the only one that needs
somebody's attention today.

What it does change is what you are *offered*. `lpm task next`, `lpm task start`
and the agent queue all leave flagged work out, whatever column it sits in — so
"blocked, do not start this" on a backlog issue is heard rather than displayed
and ignored. Like a switched-off period, it steers the queue and hides nothing:
`lpm open`, `lpm task start <id>` and `lpm flag list` all still reach it.

**A flag carries up the plan.** Nobody scrolls to the bottom of an epic to find
out whether anything under it has stopped, so every container above a flagged
issue is marked `inside` ("Stopped inside") — and the mark comes off by itself
when the last stopped thing inside it starts moving again, whether you cleared
the flag or finished the work. It is the same roll-up a closed story does to its
feature, and it is written and cleared automatically:

```bash
lpm flag LP-42 -m "Sandbox credentials expired"   # LP-42 blocked; the feature,
                                                  # epic and program say "Stopped inside"
lpm flag clear LP-42 -m "New credentials issued"  # and all three go quiet again
```

`inside` is not a reason you can raise — `lpm flag --reason inside` is refused —
because it is what tells a container the roll-up may clear from one you paused
by hand. A flag you put on a feature yourself is never overwritten and never
cleared for you. `lpm flag list` shows the issues somebody actually stopped and
counts the containers standing in front of them separately, so the list stays
the short one you can act on.

**The comment is required, both ways.** A red box nobody can read is a round trip
to ask what it means, which is the trip the flag exists to save — so `lpm flag`
refuses without one and writes it into the issue's `_comments.md` in the same
call. Clearing needs one too: whoever raised the flag is the person who reads it.

**And every flag change is written into the document itself, comment or not.**
The flag lands in the frontmatter, and the raise or the clear lands as a dated,
attributed line in the issue's activity section:

```markdown
<!-- lpm:activity -->

## Activity

### 2026-08-16T09:14:02.104Z — Alice Smith (RS-1) — flagged: Blocked

**Flagged: Blocked**

Sandbox credentials expired

### 2026-08-16T14:41:55.881Z — Alice Smith (RS-1) — flag cleared

**Flag cleared** (was: Blocked)

New credentials issued
```

That matters most for the flag changes **nobody typed a comment for**, which on
a working board are the majority: the container that gained `inside` because a
story four levels down stopped, the same container going quiet again, the flag
that finishing the work answered, the one `lpm check --fix` wrote to repair a
container that had drifted. None of those writes a comment — `_comments.md` is
where a *person* explains a stall, and one derived entry per ancestor per flag
would bury the explanation the flag exists to carry — so the activity line is
the entire record. Without it a node turns red and back again with nothing in
`_issue.md`, and nothing in the board's git history, saying when or why:

```
$ git -C .lpm log -p --  board/LP-1/LP-2/LP-3/_issue.md
+flag: inside
+### 2026-08-16T09:14:02.104Z — Alice Smith (RS-1) — flagged: Stopped inside
+
+Work inside this has stopped — see LP-42.
```

Flagged issues are drawn **in red** on the canvas, a container standing in front
of one is drawn in a quieter red, and a collapsed node says how many are stuck
inside it — folding a feature must not hide a story that has stopped. Finishing an issue clears any flag on it automatically; the comment
trail keeps the history.

Clearing is the plan owner's call, by convention rather than by enforcement.
light-plan has no permissions anywhere — [a profile routes work, it is not access
control](#profiles-giving-one-developer-one-part-of-the-board) — and inventing
them here would make that untrue. What the tooling does is record who did it.

## Working briefs: the context to actually do it

`lpm task next` says *what* to work on. `lpm instructions` answers the question
straight after it — *what do I need to know to start?*

```bash
lpm instructions LP-12          # markdown on stdout, and nothing else
lpm instructions                # the issue you have in progress
lpm instructions LP-12 > brief.md
```

A story on its own rarely explains itself. So the brief walks up the hierarchy
and lays out the **title and body of every ancestor** — the programme, the epic,
the feature — above the issue's own, then adds its breakdown, what it is blocked
by, the research it rests on, and its work log:

```
$ lpm instructions LP-12
# LP-12 — Pay as a guest

You are picking up a user story on the acme board. …

## Epic: Checkout (LP-4)

### Summary

Buy things without an account. …

## Feature: Guest flow (LP-9)
…
## The story: Pay as a guest

### Acceptance Criteria

- [ ] Given a signed-out shopper …
```

Everything about *how* the brief was made goes to stderr, so the brief itself
pipes cleanly into a prompt, a file or a clipboard.

Agents get the same text from the MCP tool `get_instructions { id }`, which is
what the shipped `lpm-developer` agent reads before writing any code.

### Context templates

The layout is a board-level decision, like the statuses. Layouts live in
`.lpm/templates/context/<issue type>.md`, with `default.md` behind them and a
built-in layout behind that — so a board with no templates at all still gets the
ancestors' titles and bodies above the issue's own. `lpm init` writes starters
for the types your config declares:

```bash
lpm instructions --list           # which layout each issue type resolves to
lpm instructions --init           # write the starters (never overwrites)
lpm instructions --audit          # read every layout for risky code
lpm instructions --template ./one-off.md LP-12
```

They are [Eta](https://eta.js.org) templates — EJS syntax, ordinary JavaScript
between the tags:

```markdown
# <%= issue.id %> — <%= issue.title %>

<% if (epic) { %>
## Epic: <%= epic.title %>

<%= heading(epic.body, 3) %>

<% } %>
## The story

<%= heading(issue.body, 3) %>

<% for (const task of children) { %>
- <%= task.id %> <%= task.title %> — <%= task.status_label %>
<% } %>
```

**Every issue type your board declares is a variable**, resolving to the nearest
ancestor of that type — so one template can say "this story's epic" without
knowing how deep it sits. `heading(n)` re-levels a body so it nests under the
heading above it, leaving fenced code alone. Note that an empty array is truthy
in JavaScript: guard a list with `.length`, an optional document with the name
alone. The full reference, including every value and helper, is in
[docs/context-templates.md](docs/context-templates.md) and in
`lpm instructions --help`.

Templates are not board truth: they live under `.lpm/templates`, `lpm check` does
not know they exist, and no template can make a board invalid.

### ⚠ Context templates are code

Eta compiles a template into a JavaScript function and **runs it**. A `.lpm`
folder arrives over `git pull` from whoever wrote it, so rendering somebody
else's board can run somebody else's JavaScript, as you, with your filesystem and
your environment variables.

light-plan reads every template before compiling it and refuses the known
escapes — `process`, `require`, `this`, `import()`, a property reached by a
computed key, and Eta's own file-reading `include`. The check tokenizes with
Eta's own parser and parses the code with [acorn](https://github.com/acornjs/acorn),
so `x["cons" + "tructor"]` is caught as readily as `require`:

```
$ lpm instructions LP-12
error Refusing to render .lpm/templates/context/user_story.md: it can do more than lay out an issue
       3:5  danger  reaches outside the board (process) — process
       4:5  danger  `this` is the template engine itself, not the issue — this
```

`lpm instructions --audit` runs that check over the whole board and exits 1 on a
finding, so it drops into CI beside `lpm check`. `--unsafe` renders anyway, for a
template you wrote and meant; the MCP tool has no equivalent, because letting an
agent opt out is the whole hole.

**This refuses the known escapes; it cannot make an untrusted template safe.**
Read the templates that arrive with a board you did not write, the way you would
read a `postinstall` script. Use at your own risk.

## Profiles: giving one developer one part of the board

A **profile** is a small YAML file you hand a developer — or an agent. It says
who they are and which part of the board they should be offered:

```yaml
# alice.yml
user: Alice Smith

scope:
  under:   [LP-2]         # only work at or below these documents
  exclude: [LP-9]         # never these, nor anything below them
  types:   [user_story]   # only these issue types
  periods: [TL-2]         # only work scheduled here, or in a child period
```

Every key is optional, and every one of them narrows: `under` on its own scopes
someone to an epic, `exclude` on its own keeps them out of one, and the two
together read as "this programme, but not that feature". A period folds its
child periods in, so naming an increment includes its sprints. Write a starter
file and start using it in one command:

```bash
lpm profile --init ~/.lpm/alice.yml --user "Alice Smith"
lpm profile ./profiles/alice.yml    # or point at one you were given
lpm profile                         # what is in force, resolved against this board
lpm profile --clear
```

```
$ lpm profile
Profile  /home/alice/.lpm/alice.yml
  .lpm/local.json
  user     Alice Smith
  scope    under LP-2 · not LP-9
  offers   14 issues of 63
```

Only the *path* is remembered, in `.lpm/local.json` beside the current user and
git-ignored with it — the profile belongs to the developer, not to the board.
`LPM_PROFILE=./profiles/bob.yml lpm task next` points at a different one for one
shell, and `lpm mcp --profile <file>` does the same for one agent session.

**Scope decides what the board offers you, never what is reachable.** It
narrows `lpm task next` and `lpm task start` with no id, and the MCP tools
`next_tasks` and `list_documents`. It does not touch `lpm open`, `lpm set`,
`get_document`, or `lpm task current` — work you have already picked up stays
yours even if the scope it came from moves, and a dependency you cannot read is
worse than a recommendation you should ignore.

So this is **routing, not access control**: the board is a folder of markdown
that whoever holds the profile can read, and a profile decides what is handed to
them. Use it to keep a team of ten out of each other's epics, or to give five
agents five slices of one plan. Do not use it to keep a secret.

Whatever is in force is printed with the work it filters, so a short list is
never a mystery:

```
$ lpm task next
Next up for RS-1 Alice Smith
  scope under LP-2 · not LP-9
  LP-12   Guest checkout           User Story · ready     TL-2
```

If the file names something this board does not have, that is reported and the
rest still applies — except that a stale `under` offers nothing rather than
quietly widening to everything. A profile that does not parse at all is
reported too, and light-plan carries on unscoped. Unknown keys are an error:
`excludes:` would otherwise silently hand someone the whole board.

Where identity is concerned the most specific answer wins: `LPM_USER`, then the
profile's `user:`, then `lpm me`. `lpm me` says which one is talking.

[`docs/profiles.md`](docs/profiles.md) is the full reference: every key, how the
file is found, what each surface does and does not filter, and how to set up a
team or a swarm of agents.

## Working by hand

The CLI is a convenience, not a gatekeeper. You can create a folder and an
`_issue.md` (or `_period.md`, or `_resource.md`) yourself — even one containing
nothing but a heading — and then run:

```bash
lpm check --fix
```

which adopts it: allocates an id from the right counter, infers the type from
its depth (when that level has only one type), takes the title from the
`# heading` or the folder name, sets the default status, defaults a resource's
`capacity` to 1, fills in `created` (from the file's first commit, falling back
to its mtime) and `author` (from `git config user.name/email`), adds the
attributes its type declares, dedupes link and coverage lists, renames the
folder to the document's id, rolls every container's status up from the work
inside it (see [a parent's status is derived](#a-parents-status-is-derived)),
and rewrites `INDEX.md`.

Anything `--fix` cannot decide for you is reported and left alone — an ambiguous
type, a duplicate id, a missing sprint date, an assignee who is not on the
roster, an attribute whose value has the wrong type. Without `--fix`, `check`
never writes anything.

## INDEX.md: the board as a table of contents

A folder is named after its id, so the file tree says what is nested in what but
not what any of it *is*. `.lpm/INDEX.md` is where the titles are — every
document in the board, with a link to its file, nested exactly the way the
folders are:

```markdown
# Board index

## Issues

- [LP-1](board/LP-1/_issue.md) — Payments platform
  - [LP-2](board/LP-1/LP-2/_issue.md) — Checkout revamp
    - [LP-3](board/LP-1/LP-2/LP-3/_issue.md) — Guest flow

## Timeline

- [TL-1](timeline/TL-1/_period.md) — 2026 H2
  - [TL-2](timeline/TL-1/TL-2/_period.md) — Sprint 1

## Team

- [RS-1](team/RS-1/_resource.md) — Alice Smith
```

It is written by `lpm init` and rewritten by every command that adds, removes,
moves, reparents or retitles a document — from the CLI, from the web UI's Push,
and from an agent over MCP alike. Nothing has to be run to keep it current.

It is generated, not authored: the board is the documents, and the index is a
reading of them. Edit it and your edit is overwritten by the next change; delete
it and `lpm check --fix` puts it back. `lpm check` reports it when it has fallen
behind — which is what a badly resolved merge conflict inside `.lpm` looks like.

Because it is markdown with relative links, GitHub, GitLab and every editor's
preview render it as a clickable outline of the whole plan.

## Configuration

`.lpm/config.yml` defines the board. `lpm init` copies one of the built-in
templates; edit it whenever the process changes and re-run `lpm check`.

```yaml
version: 1
key_prefix: LP           # issue ids: LP-1, LP-2, ...

statuses:                # the kanban columns, in board order
  - id: backlog
    label: Backlog
  - id: in_progress
    label: In Progress
    active: true         # work in progress: where `lpm task start` moves an issue
  - id: done
    label: Done
    terminal: true       # an end state: where `lpm task done` moves it, and
                         # what a parent takes when everything inside it is
                         # there — see "a parent's status is derived"

default_status: backlog  # optional; defaults to the first status

priority_attribute: priority       # optional; an enum, most important value first
effort_attribute: story_points     # optional; an int or float

hierarchy:               # index = folder depth
  - program
  - epic
  - feature
  - [user_story, bug]    # types on one line share a level
  - sub_task

issue_types:
  user_story:
    label: User Story
    atomic: true           # the smallest unit the queue hands out
    attributes:
      story_points:
        type: int
        description: Relative size, Fibonacci
      priority:
        type: enum
        values: [critical, high, medium, low]
        default: medium
    body: |
      As a **<role>**, I want **<capability>**, so that **<benefit>**.

      ## Acceptance Criteria

      - [ ] **Given** <context> **when** <action> **then** <outcome>

# --- time hierarchy (optional, same shape) ---
period_prefix: TL        # period ids: TL-1, TL-2, ... must differ from key_prefix
default_period: TL-2     # optional: where unscheduled new issues land (lpm init writes it)

period_hierarchy:
  - increment
  - sprint

period_types:
  sprint:
    label: Sprint
    attributes:
      goal:
        type: string
      committed_points:
        type: int
    body: |
      ## Sprint Goal

# --- team roster (optional, same shape) ---
resource_prefix: RS      # resource ids: RS-1, RS-2, ... distinct from the others

resource_hierarchy:
  - [person, role]       # one level is usually enough

resource_types:
  person:
    label: Person
    attributes:
      email:
        type: string
  role:
    label: Role
    generic: true        # a pool, not a named person
    attributes:
      discipline:
        type: string

# --- squads (optional, same shape) ---
squad_prefix: SP          # squad ids: SP-1, SP-2, ...
squad_types:
  squad:
    label: Squad
    attributes: {}
squad_hierarchy:
  - squad
```

`hierarchy` is the single source of truth for parenting: a type's position in
the list is the folder depth it must sit at, so `lpm new` and `lpm move` can
reject invalid nesting without you declaring parent/child rules twice.
`period_hierarchy` and `resource_hierarchy` work identically.

`priority_attribute` and `effort_attribute` name issue attributes the engine
itself reads — the first to order `lpm task next`, the second to add up load in
`lpm team`. Both are optional, and both must name an attribute your issue types
actually declare, with a usable type (an enum, and an int or float).

`body` is the markdown scaffolding written into each new document of that type —
this is where the Agile practice lives (story format, acceptance criteria,
definition of done, repro steps, sprint goal, retro prompts).

### The unit of work

`atomic: true` on an issue type says that work of that type is **taken whole**.
It is the answer to "what is one job for one person?", and it is the only thing
that decides what the queue offers.

Without it, only an issue with nothing nested inside it carries work. That reads
well until somebody breaks a story into sub-tasks: the story disappears from
`lpm task next` and three sub-tasks appear in its place, as if they were three
separate tickets for three separate people. Usually they are not — they are a
checklist, and the story is still the job.

So a type marked `atomic` is offered **even when it has children**, and nothing
nested inside it is offered separately:

```
epic                  container — not offered
  feature             container — not offered
    user_story   **   OFFERED (atomic)
      sub_task        inside the unit — never offered
      sub_task        inside the unit — never offered
```

The sub-tasks are not hidden, only un-assignable on their own: they are listed
in the brief `lpm instructions` renders, so whoever picks the story up reads them
with it. `lpm team` counts the same way — the story's `story_points` once, and
not the estimates on the sub-tasks underneath.

Where atomic types nest, the outermost one wins: mark `feature` as well and the
feature becomes the unit, with its stories inside it. A board that marks nothing
behaves exactly as it always has, so this changes nothing on an existing board
until you ask for it. The shipped `scrum` template marks the whole delivery level
(`user_story`, `bug`, `test`, `review`, `research`) and `kanban` marks `story`.

The flag is only meaningful on issue types; `lpm check` refuses it on a period or
resource type rather than ignoring it.

### Attribute types

| Type | Frontmatter value | `--set` input |
| --- | --- | --- |
| `string` | text on one line | `--set owner=jane` |
| `text` | multi-line text | `--set notes="..."` |
| `int` | integer | `--set story_points=3` |
| `float` | number | `--set estimate_hours=1.5` |
| `bool` | `true` / `false` | `--set blocked=yes` |
| `date` | `YYYY-MM-DD` | `--set due=2026-09-30` |
| `enum` | one of `values` | `--set priority=high` |
| `array` | YAML list | `--set labels=web,api` |

Every attribute also accepts `description`, `required: true`, and `default`.
Names must be `lower_snake_case` and cannot shadow the reserved fields:

- **issues** — `id`, `type`, `title`, `status`, `assignee`, `period`, `flag`, `depends_on`, `relates_to`, `related_files`, `created`, `updated`, `author`
- **periods** — `id`, `type`, `title`, `starts`, `ends`, `active`, `created`, `updated`, `author`
- **resources** — `id`, `type`, `title`, `capacity`, `covers`, `created`, `updated`, `author`

### Templates

| Template | Issues | Periods | Resources |
| --- | --- | --- | --- |
| `scrum` *(default)* | Program › Epic › Feature › User Story ∥ Bug ∥ Test ∥ Review ∥ Research › Sub-task | Increment › Sprint | Person ∥ Role |
| `kanban` | Epic › Story › Task | Cycle | Person ∥ Role |
| `blank` | Task | — | — |

```bash
lpm init --template kanban
lpm init --template ./my-process.yml    # your own
```

## Sharing the board through git

A board lives in `.lpm`, which is a git repository of its own. **Git sync**
makes git the board's remote. Every change made from the CLI, the web UI or an
agent pulls the latest board first, then commits and pushes it as one commit
(`lpm: claim LP-12`). A team, or a swarm of agents on several machines, can
then work one board, and nobody runs `git` by hand.

```bash
lpm git setup             # this project's repository, on its own branch _lpm_board_remote
lpm git setup --url https://dev.azure.com/acme/plan/_git/board
lpm git join              # a teammate: clone the shared board into this project
lpm git                   # where it stands; `lpm git sync` to sync now
```

A change that collides with one somebody else pushed first is **refused, and
nothing is written**, so two people cannot both claim one issue: the second is
told, and asking again says who holds it. Changes to different documents both
land. Any host works (GitHub, GitLab, Bitbucket, Azure DevOps, or any server
git can push to), with the credentials git already uses for your code.
light-plan stores none, and never waits on a prompt. With the board on the
project's own repository, the board branch shares no commit with the code, so
the two histories never mix. A board syncs through git or mirrors onto a
tracker (below), never both. Swapping one for the other keeps everything:
`lpm git setup --turn-off-remotes` turns the trackers off (not removed), and
`lpm git off --turn-on-remotes` turns them back on where they left off.

The full guide covers conflicts, offline work (`LPM_GIT_OFFLINE=1`), turning
it off and the design: [`docs/git-sync.md`](docs/git-sync.md). For a step-by-step
walkthrough, CLI and web UI, see [`docs/git-sync-tutorial.md`](docs/git-sync-tutorial.md).

## Remote boards

A **remote** is a mirror: light-plan keeps an external tracker — GitHub Issues,
Jira Cloud or Linear — in step with a `.lpm` board, in either direction. The
board stays the source of truth in your repo; the remote is a reflection of it,
in a tool the rest of the team already has.

**It is git, and it is not git.** The mental model is a git remote: you push
your branch out and pull other people's work back, and the `.lpm` folder is the
working tree. That analogy is load-bearing, so be clear-eyed about where it
stops. Git syncs *files* and knows nothing about what is in them, and when two
sides disagree it hands you the conflict together with a merge base you can
inspect and resolve by hand. A remote syncs *issues*, each with its own id, its
own workflow and its own rules about what a parent, a status or a label may be —
and there is **no merge base you can inspect**. The remote may renumber your
issues, rewrite their markdown, reorder their labels or silently refuse half a
write, and the only way light-plan can tell your edit from theirs is the
snapshot it recorded the last time the two sides agreed. That is why the sync
keeps a link store and a base snapshot per document, why a field the remote
cannot hold is *encoded* rather than dropped in silence, and why the first
write asks once — each is an answer to a question git never had to ask. The
full guide — the files a remote touches, every mapping block, credentials,
people, sprints and what happens to a board deeper than the platform — is
[docs/remotes.md](docs/remotes.md); the reasoning is recorded in
[docs/remote-sync.md](docs/remote-sync.md), and the per-platform audit is
[docs/remote-capabilities.md](docs/remote-capabilities.md).

A remote lives in `.lpm/config.yml` under `remotes:`. Each entry names a
provider plus that provider's own `connection` and `mapping` blocks. Set one up
without hand-writing the YAML — `lpm remote add <name> --provider <provider>
--<key> <value>…` validates the connection against the provider's own schema and
writes the entry in place; `lpm remote` lists what is configured and
`lpm remote rm <name>` removes an entry (the per-remote state is kept unless
`--purge`).

**`lpm remote add` drafts the `mapping:` for you** — you do not write one by
hand, and you should not need to edit one. It reads this board's own types,
statuses and attributes and matches them against what the provider can hold
([src/remote/scaffold.ts](src/remote/scaffold.ts)). Where the words are the
board's own, it uses them. Where the words belong to the *platform* — a Jira
issue type, a Linear workflow state — it uses **that platform's conventional
names**, which the provider states for itself
([src/remote/vocabulary.ts](src/remote/vocabulary.ts)): Jira's `Epic` / `Story` /
`Task` / `Bug` / `Sub-task` and `To Do → In Progress → Done`, a Linear team's
`Backlog` / `Todo` / `In Progress` / `In Review` / `Done`.

**Then the connect wizard turns the convention into your project's own words.**
It checks the remote is reachable, and asks it what its types and statuses
*actually* are — correcting a name your project spells differently, and asking
you about any it does not have at all, with the remote's own names as the
options. Read-only on the remote. So first-time setup is **one command and one
secret**:

```bash
lpm remote connect     # asks which tracker, where it is, and for the credential
lpm remote push --all  # files the plan; the first write asks once
```

Nothing about `connect` is required on the command line — it asks — but every
question is also a flag, so a scripted run asks nothing:

```bash
lpm remote connect jira --site https://acme.atlassian.net --project PAY
```

`connect` is a wizard over three commands that are still there for a script or
a CI job, which have nobody to answer a question — and any question it asks can
be given as a flag instead, so a fully flagged run is non-interactive too:

```bash
lpm remote add jira --provider jira --site https://acme.atlassian.net --project PAY
echo <api-token> | lpm remote login jira     # or JIRA_API_TOKEN in the environment
lpm remote setup jira                        # match the mapping to the live project
```

A convention that is wrong is never filed blind: the push preflight validates
every mapped name against the live project and refuses the push. A `TODO:` line
is what is left where a provider states no convention at all, and the remote
refuses to open until it is answered — none of the shipped providers leaves one
for any of the shipped board templates.

A connection value light-plan owns is filled in too: `jsonfile`'s tracker lands
in `.lpm/remotes/<name>/tracker.json` unless `--file` says otherwise, so the
whole of its setup is one command with no account at all:

```bash
lpm remote connect jsonfile                      # path, mapping and all
lpm remote push --yes                            # …and it syncs
```

```yaml
remotes:
  jira:
    provider: jira
    scope: LP-10            # optional; omit to mirror the whole board
    direction: both         # push | pull | both
    on_delete: unlink       # unlink | close | delete — what a deletion does upstream
    conflict: manual
    comments: push          # push | both — pull remote comments only when both
    connection:
      site: https://acme.atlassian.net   # your Cloud site
      project: PAY                       # the project key issues file into
      email: ${JIRA_EMAIL}               # where the secret comes from, never the secret
      token: ${JIRA_API_TOKEN}
    mapping:
      types: { user_story: { remote: Story } }
      statuses: { backlog: "To Do", in_progress: "In Progress", done: Done }
```

`connection` is where and how — GitHub takes `repo: owner/repo`, Jira `site` +
`project`, Linear `team`. `mapping` is the board's vocabulary renamed into the
remote's: which board type becomes which remote type, which status becomes which
remote status, which attribute travels in which field or label.

`types` and `statuses` both name their counterpart under `remote:`, and both
accept the shorthand — `user_story: Story` and `done: Done` are the same
declarations written short. You never say *where* a name lands: whether a type
rides a native issue-type field or a label is a property of the platform, and
the provider already knows it.

They differ in one way, because the world does. **A type names one remote
type** — there is one issuetype to file under. **A status may name several**,
because a remote often has more than one word for the same thing:

```yaml
statuses:
  done: { remote: [Done, "Won't Fix", Duplicate], push: Done, closed: true }
```

All three pull back as the board's `done`; `push:` says which one a push
writes. Reach for the list on the day you need it — the mapping `lpm remote
add` drafts names one state per status.

What the remote cannot hold degrades down a ladder — **native → custom field →
label → a managed block in the body → a comment** — and a field that is
`required` with none of those available is **refused** (the sync stops) rather
than silently dropped. The table below states, per provider, which rung each
construct lands on.

**Credentials never sit in the committed config.** `email` and `token` name
*where* the value comes from and resolve through a chain at sync time: a
`${VAR}` reference into the environment, then `.lpm/credentials.json` (written
by `lpm remote login`, git-ignored and owner-only), then the platform's own
env var (`JIRA_EMAIL`, `JIRA_API_TOKEN`). A literal secret in `config.yml` is
refused. `lpm remote add` and `lpm remote setup` both print which credentials
are still missing, where to create each one and the command that stores it, so
the page to open is never something to go looking for. At a terminal `lpm remote
login <name>` **asks** for each key that provider declares — Jira's email and
its API token in the one command — with echo off and a bare Enter keeping a
value that already resolves; with no terminal it reads one value from stdin, so
a script pipes it in. Either way the value is never a flag, and it lands under
the provider's own secret key — `api_key` for Linear, `token` for GitHub, and
`--key` names one of several. The Basic Auth header is built by the wrapped client (`jira.js`, which is
not installed with light-plan — see [the Jira page](docs/remote-jira.md)) — never by hand, and
the resolved values are redacted wherever this run prints anything.

### Commands

```bash
lpm remote                        # list the declared remotes and their state
lpm remote connect [<provider>] [--<key> <value>…]  # declare + credential + match the mapping
lpm remote push [<id>...]         # file these documents — the ledger knows where they go
lpm remote pull [<key>...] [--parent <id>]   # bring remote issues onto the board
lpm remote ledger [<name>] [--unlinked]      # which remote holds each document
lpm remote add <name> --provider <p> --<key> <value>…
lpm remote setup [<name>]         # credential + reachability + match the mapping to the remote
lpm remote rm <name> [--purge]
lpm remote off [<name>…]          # turn mirrors off, keeping links, mapping and credentials
lpm remote on <name>              # turn one back on, carrying on from its last sync
lpm remote login <name> [--key <k>]   # store a credential (asks, or reads stdin — never a flag)
lpm remote push [<id>…|--all] [--dry-run] [--limit N] [--yes]   # an issue or a period
lpm remote pull [<name>] [--dry-run] [--changed]
lpm remote sync  [<name>]         # pull, then push — the git pull --rebase && git push order
lpm remote status [<name>] [--local] [--changed]   # drift per document, and what arrived upstream
lpm remote log    [<name>]        # the audit trail — every applied sync, most recent first
lpm remote resolve <id> --local|--remote     # settle a conflict; the next sync applies it
lpm remote link <name> <id> <key> # adopt an existing remote issue into a document
lpm remote decouple <id>          # drop the link and never re-file; the twin is left alone
```

`push` and `sync` take `--dry-run` to render the plan without writing, `--limit
N` to cap the write operations in a run, and `--yes` to confirm
non-interactively (CI, an agent). `sync` pulls first, so remote edits merge
before local ones are written over them.

`status` exits 0 in sync, 1 drifted, 2 conflicted, so CI can fail a branch that
left the tracker behind. It reports six buckets, and one of them is not about a
document on this board at all: **`incoming`** is an issue in the tracker with no
document here yet — a story somebody added upstream — named by its remote key
and the local document a pull would file it under. `--local` skips the remote
half entirely (no credential, no request); `--changed` narrows the read to what
moved since the last sync, which cannot tell you what is *absent*, so `incoming`
stands down for it.

**A push creates the vocabulary it needs** — labels a GitHub repository does not
define, Projects v2 fields a status needs — and reports each one. None of that
is a decision: it is implied by the mapping the board already wrote down, which
is why it is not a command of its own.

**A sprint is not vocabulary; it is a document on the board.** So a push of work
never files the timeline: `lpm remote push TL-3` files that sprint, `--all`
files the timeline with everything else, and an issue scheduled into a sprint
the tracker has not got is filed *unscheduled* — the push that files the sprint
writes the assignment, and picks up everything already filed into it. The
board's plan and the board's calendar move at different speeds, and requiring
the calendar first made it a precondition for filing a single story.

Any subcommand may be written with the remote's name first — `lpm remote jira
push LP-12` — which is how most people say it out loud.

**Pushing part of a plan is expected.** `lpm remote push LP-12` files the
documents you name, asks whether to file the work inside them, and says what it
cannot carry yet: a parent that is not upstream (the document files at the top
level) and a dependency whose other end is missing (the edge is left off).
Neither is permanent — push the parent later and the document moves under it in
that same run, push the other end and the edge is written. **A document is
mirrored by one remote at a time**, so a second twin is never created: a
targeted push refuses and names the holder, a whole-board push reports it as
skipped. `lpm remote ledger` is the record, derived from the link stores
themselves, and `lpm remote decouple <id>` releases a document so another
tracker may take it.

### A worked example

Mirror the `LP-10` feature into a GitHub repository:

```bash
lpm remote connect github --repo acme/payments --scope LP-10 --name upstream
#   declares it, asks for the token, checks reachability and the mapping
lpm remote push --dry-run      # read the plan, and what it would create first
lpm remote push --all          # first write asks once; then the plan lands
lpm remote push LP-12          # or file one document at a time, later
lpm remote status              # 0 when the board and the tracker agree
lpm remote ledger              # which remote holds each document
lpm remote log                 # the record of every sync, for "who filed these?"
```

### What each provider can carry

The honest version of the question every sync has to answer: *where does each
part of the board go?* Four outcomes, from the ladder above; the full matrix,
with the platform specifications it was verified against, is
[docs/remote-capabilities.md](docs/remote-capabilities.md).

**native** — the platform has a real place for it · **provisioned** — it can be
given one (a push creates it) · **encoded** — it must ride a label or the
managed block, and round-trips with that loss · **refused** — a `required` field
with no carrier at all: the sync stops rather than dropping it.

| Board construct | GitHub (Issues + Projects v2) | Jira Cloud | Linear |
| --- | --- | --- | --- |
| **hierarchy** | native, 1 level (sub-issues); deeper → encoded | native, ~3 levels (Epic → issue → subtask); deeper → encoded | native, 1 level (sub-issues); deeper → encoded |
| **issue type** | native where org issue types are on, else encoded (label) | native | encoded (label) |
| **status** | native open/closed; richer workflow → provisioned | native (workflow transitions) | native (workflow states) |
| **`depends_on`** | encoded (no blocking edge) | native | native |
| **`relates_to`** | encoded (no relates edge) | native | native |
| **attributes** | provisioned, limited value types | native (extensive) | encoded (no custom fields) |
| **effort / priority** | provisioned | native | native, fixed scales |
| **periods** | native (milestone) + provisioned (Iteration) | native (sprint) | native (cycle) |
| **assignee** | native (user); a generic pool → encoded | native (user); a pool → encoded | native (user); a pool → encoded |
| **comments** | native | native | native |

The structural headline: **Jira is the most capable of the three** — native
types, edges, statuses and rich custom fields — while **Linear is the least
capable for attributes** (no custom fields at all, so every board attribute
rides a label or the managed block) and **GitHub is the least capable for
edges** (no blocking or relates edge anywhere, so `depends_on` and `relates_to`
are always encoded). A hierarchy deeper than the native depth is encoded on all
three. This table is the platform's capability; the verdict for *your* mapping
is `lpm remote push --dry-run`, whose preflight reports every value that cannot
be mapped and refuses the push rather than dropping the field. (`lpm remote
check` is narrower than its name: it lists the mapped **labels** a repository
does not define yet, and only for a provider whose connector can list them.)

**What "refused" and "dropped" mean.** A construct is refused only when it is
`required` *and* no rung of the ladder can carry it — with a writable body the
managed block almost always catches it, so a refusal is the rare bottom, not the
normal case. Off the bottom of the ladder, a field that is *not* `required` and
has no carrier is **dropped** with a warning instead. The concrete refusals
worth knowing before you commit: GitHub does not offer `on_delete: delete` at
all (deletion is GraphQL-only, admin-level and hard), so a deletion there is a
close or an unlink, never a delete; Jira refuses Server/Data Center outright
(Cloud only) and a status with no reachable transition, naming the statuses that
are; Linear's `estimate` refuses a value off the team's configured scale. These
are the edges where the remote's own rules win over the board, and they are
reported rather than papered over.

**The first write to a remote asks once, and a large plan stops.** A push that
would make the first write to a remote shows the target and the counts and asks
for confirmation; the consent is recorded in the remote's link store, so it is
asked once. A push whose plan would create or close more than the threshold —
25 by default, settable per remote as `write_threshold` — stops and requires
`--yes`, because a scope typo that makes half the board look deleted would
otherwise close half a backlog. A run with no terminal to ask (CI, an agent)
never prompts: it proceeds with `--yes` or stops with a message. `--limit N`
still caps any run at N remote write operations, reporting the rest as
deferred.

**Deleting a local document never deletes the remote issue by default.** When a
linked document is removed (`lpm rm`) or moves out of the remote's `scope:`,
the remote's `on_delete` policy decides what happens to its twin: `unlink` (the
default) leaves the twin alone and drops the link, `close` closes it with a
comment saying why, and `delete` removes it — only where the platform allows,
and with confirmation every run (a delete never rides a remembered consent).

**Every sync leaves a record.** Each applied `push`, `pull` or `sync` appends a
line to `.lpm/remotes/<name>/log.jsonl` — when it ran, who drove it, the
operation counts and each failure's reason, with secrets redacted. The file is
append-only and line-delimited, so concurrent runs and git merges both leave it
readable. `lpm remote log [<name>]` reads it back, most recent first, with
`--since <iso>` to window it and `--json` for a script. A dry run is never
logged: the log records what a sync did, not what it previewed.

**Jira connection** (`provider: jira`) targets Atlassian Cloud over Basic Auth
with an API token. `site` is an https URL — `https://<org>.atlassian.net`, or a
Cloud site on a custom domain. `project` is the key (`PAY`); `board` is the
optional Agile board id that enables sprint mapping. Server/Data Center
instances are out of scope and get a clear "not supported" rather than a
confusing 401.

**TLS verification is on and stays on.** A corporate MITM proxy with a custom
root CA is handled by injecting that CA into the trust store Node's built-in
`fetch` already verifies against — never by disabling verification:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/your-corporate-root-ca.pem
# or, on Node 22.19+:
node --use-system-ca dist/cli/index.js …
```

`connection.tls_verify: false` exists as an explicit per-remote fallback for a
proxy that cannot be talked into a trust store. It warns on every run, and no
error message suggests it before the trust-store path.

**Comments sync one way by default, and only widen on request.**
`comments: push` (the default) posts new `_comments.md` entries upstream, naming
the local author in the body; `comments: both` also appends remote comments to
the log on pull, with the remote author and timestamp. Either way the link
store records each synced comment's remote id, so nothing is ever posted or
appended twice, and a comment edited or deleted upstream is never rewritten
locally — the log is append-only. The managed comment (the degraded-field block
when `encoding: comment`) is excluded from both directions.

**A Jira status change is a workflow transition, not a write.** Pushing a card
to `in_progress` finds the transition from the issue's current status to the
mapped status and executes it. A target with no direct hop is walked over
several transitions only when `mapping.transitions.multi_hop: true` is set —
off by default, because transitions fire automations, notify people and stamp
resolutions — and is otherwise refused with the path it would have taken. An
unreachable target is refused naming the statuses that *are* reachable. A
transition screen's required fields (a resolution, a reason) are answered from
`mapping.transition_fields`, keyed by the Jira field key, and a required field
with no entry refuses the move naming the field.

```yaml
    mapping:
      transitions: { multi_hop: true }        # opt in to walking the workflow
      transition_fields: { resolution: Done } # answers for required screen fields
```

**Jira addresses assignees by account id, never by email or name** — so how a
board's people become assignees depends on which resource attribute
`mapping.accounts.via` names:

```yaml
    mapping:
      accounts: { via: jira_account_id }  # the attribute holds the account id
      # accounts: { via: email }          # or: resolve the email by search
```

`via: jira_account_id` is the robust choice: the attribute holds the Jira
account id directly and it is written with no search. `via: email` resolves the
person's email to an account id through Jira's user search — and on a
privacy-restricted (GDPR-mode) instance that search returns nothing, which the
sync refuses with the `jira_account_id` alternative named rather than reporting
"user not found". An assignee in Jira who matches nobody on the roster is
reported on pull, never auto-created.

## The template registry

> Full reference: [docs/templates.md](docs/templates.md).

The same shape keeps coming back. Every API feature needs a schema story, an
endpoint story and a docs story; every migration goes through the same four
steps; the team decided months ago how a release is checked. Writing it out
again each time is slow, and each copy comes out slightly different from the
last.

The **registry** (`.lpm/registry/`) is where those go. A template is written in
the board's own issue types and nests the same way, so it is the *shape of real
work* rather than a description of one:

```bash
lpm template list                 # what the registry offers, and what each is for
lpm template show TPL-3           # its parameters, and everything it would create
lpm template apply TPL-3 --params ./payments.json --under LP-14
```

```
TPL-3    Feature      {{name}} API  (+3 documents)
  Delivery / Epic slot
  REST endpoint with schema, tests and docs
  parameters: name, owner
```

### Writing one

```bash
lpm template new folder -t "Delivery" -d "Standard delivery patterns"
lpm template new folder -t "Epic slot" --parent TPL-1
lpm template new feature -t "{{name}} API" --parent TPL-2 \
    -d "REST endpoint with schema, tests and docs" \
    --param name:string:required --param owner:string=nobody
lpm template new user_story -t "Design the {{name}} schema" --parent TPL-3
lpm template new user_story -t "Implement {{name}} endpoints" --parent TPL-3
lpm link TPL-5 --depends-on TPL-4
```

The registry **mirrors the issue hierarchy**: a template of a feature sits at the
feature's depth, exactly where the issue it produces will sit. Something has to
occupy the levels above it, and that is what a `folder` is — a container standing
in for a level nobody templatized. So to keep a feature template on its own you
file it under a folder where the epic would go, and to templatize an epic you put
it at the top level beside that folder. A folder is never instantiated, and never
sits *inside* a template.

The template somebody instantiates — the one whose parent is a folder, or
nothing — is its **root**. Everything nested under it comes with it, and only the
root declares parameters.

### Parameters

A parameter is declared exactly like a board attribute (`type`, `required`,
`default`, `values` for an enum), and `{{name}}` is written wherever the answer
goes: in titles, in bodies, in `related_files` and in attribute values.

```yaml
---
id: TPL-3
type: feature
title: "{{name}} API"
description: REST endpoint with schema, tests and docs
params:
  name:
    type: string
    required: true
    description: What the API is for
  owner:
    type: string
    default: nobody
---
```

Answers arrive as a JSON object, from a file or one at a time:

```bash
lpm template apply TPL-3 --params ./payments.json --under LP-14
lpm template apply TPL-3 --set name=Payments --set owner=Ana --under LP-14
lpm template apply TPL-3 --set name=Payments --dry-run
```

An attribute whose *whole* value is one placeholder keeps the parameter's own
type, so `story_points: "{{points}}"` writes the number 8 rather than the string
"8" — which is what lets a template carry a value the board would otherwise
reject.

Three things it refuses rather than guessing at:

- a **required parameter with no answer**, naming it;
- an **answer the template never asked for**, because a typo in a parameter file
  is otherwise a template that quietly produced the wrong board;
- a **placeholder no parameter declares**, for the same reason — `{{nmae}}` would
  otherwise be copied onto the board verbatim. `lpm check` reports that one as a
  warning on the template itself, before anybody instantiates it.

And one it refuses out of respect for the hierarchy: a feature template has to
land somewhere a feature can sit, so `--under` is checked before anything is
written.

Instantiating creates the whole tree at once, fills in every answer, and
**repoints the dependencies between the templates at the issues it just
created** — so a feature template with three chained stories lands as three
chained stories. Dependencies leaving the template are dropped, exactly as they
are when a structure is duplicated: a fresh copy stands on its own. The registry
itself is never touched, so the same template can be applied as often as you like.

### For agents

The MCP server carries `list_templates`, `get_template` and
`instantiate_template`, and its instructions tell an agent to check the registry
*before* creating documents by hand. That is the point of the feature as much as
the typing it saves: a template named "Database migration" is the team saying
"this is how we do those", and an agent that writes its own four tickets instead
has quietly skipped a process somebody wrote down. `list_templates` is cheap and
returns enough — the description, the parameters, how much it would create — to
decide in one call.

### Building one on the canvas

`lpm ui` → New view → **Template registry**. The same canvas, table and side
panel as a board view, over the registry instead: drag templates into folders,
draw dependencies between them, edit descriptions and parameters in the panel
— every edit reaches the registry on its own within moments, the same as
anywhere else in the app. There is nothing new to learn, which is the whole
design — building a reusable feature-with-three-stories is the same gesture as
building a real one.

Instantiating stays on the CLI and MCP, where the parameter file lives.

### What it is not

`.lpm/templates/context/` is a different folder doing a different job: those are
the layouts `lpm instructions` renders a working brief with, and they *are*
executable ([see above](#-context-templates-are-code)). A registry template is a
document. `{{name}}` is replaced with a value; there is no logic, nothing is
compiled and nothing is evaluated.

Nothing in the registry gates work, ranks a queue or appears in `lpm task next`.
It is a catalogue.

## What has to happen first: upstream work

`lpm task next` answers "what can I pick up **now**", and stops at the first
thing standing in the way. `lpm upstream` answers the longer question behind it
— everything that would have to happen for one issue to be closed at all:

```bash
lpm upstream LP-42
```

```
LP-42  Pay as a guest
  3 issues must be finished first

  ← LP-31  Payment gateway  (Feature — Backlog)
    · LP-33  Webhook receiver  (User Story — Backlog, Ana Ruiz, Sprint 7)
    · LP-34  Vault credentials  (User Story — Backlog)

  ← something it waits on   · open work inside one
```

Two kinds of line, and the second is the one a list of edges would miss:

- **`←` something it waits on.** The dependency as it is *written*, inherited
  from the issues above exactly as the queue inherits it: a story inside a
  feature waits on whatever the feature waits on.
- **`·` open work inside one.** A container is finished when its contents are,
  so a feature standing in the way is really its unfinished stories standing in
  the way — and those are what somebody can actually be handed.

Finished work drops out on both counts, so the list shrinks as the plan
progresses rather than having to be maintained.

Ask it about a **container** and the report ends with what the work inside it
puts the container after — the reflection described under
[dependencies](#dependencies), naming the written edge each line comes from:

```
LP-3  Guest flow
  nothing upstream — everything it waits on is finished

  the work inside it puts it after:
  ← LP-6  Sign-up  (Feature)  via LP-4 → LP-7
  Nothing is written on either container; both stand for the work inside them.
```

That part is read off the graph and is never touched by `--schedule`: the work
it stands for is already reachable through the story that declares it.

### Pushing it into the queue

Seeing the chain and staffing it are the same gesture with one flag:

```bash
lpm upstream LP-42 --schedule
```

Every unclaimed piece of upstream work goes into the **same period** as LP-42
and to the **same person or pool**, so a chain nobody had scheduled becomes work
the queue offers. Two rules, both deliberately narrow:

- **Work somebody already holds is left alone**, its period included. It is
  their work, and shuffling it between sprints would be a worse surprise than a
  short list. It is still reported, so you can see who has it.
- **Only work units are scheduled.** A period written on an epic offers nobody
  anything, because the queue hands out units — so containers are listed and
  left as they are. It is the same rule dragging a feature into a sprint box
  follows on the canvas.

`--dry-run` says what would happen. `--period` and `--assignee` override what is
copied, and `--unscheduled` / `--unassigned` turn off one half:

```bash
lpm upstream LP-42 --schedule --dry-run
lpm upstream LP-42 --schedule --assignee RS-2 --period TL-3
lpm upstream LP-42 --schedule --unscheduled    # assign, but do not schedule
```

Both halves are on the canvas as well — right-click an issue for **Add upstream
dependencies** (draws the whole chain, changing nothing) and **Schedule upstream
dependencies** (the same edit, queued for the next Push) — and on the MCP server
as `upstream_work` and `schedule_upstream`. All three read the one definition in
`src/shared/blocking.ts`, so they cannot tell different stories.

## Reshaping the plan

Plans do not survive contact with the work. Four commands do the rewiring that
makes changing one painless — the same operations the web UI offers on a
right-click, so a board reshaped from the terminal and one reshaped by dragging
nodes come out identical.

**Break an issue up.** A 12-point story is a guess, not a plan:

```bash
lpm split LP-7 --into 3 --replace --split-effort
lpm split LP-7 --titles "Schema,API,UI" --replace
lpm split LP-7 --into 5                     # as children, keeping LP-7
```

`--replace` puts the pieces where the original stood and deletes it;
`--children` (the default) nests them inside it. Either way the graph is kept
intact: **whatever blocked the original blocks the first piece, and whatever
waited on it waits on the last**, with the pieces chained in between.
`--split-effort` divides the board's effort attribute across them, and skips
quietly when the pieces are measured in something else.

**Change what something is.** A type that belongs at another depth takes the
document with it:

```bash
lpm convert LP-7 bug          # same level, different type
lpm convert LP-7 feature      # promoted, and moved up to its epic
lpm convert LP-7 --under LP-9 # demoted to fit under LP-9
lpm convert LP-7 --under LP-1 --build-parents
```

The third form is the command-line spelling of dropping a node onto another in
the canvas: it works out what type LP-7 has to become to live under LP-9, and
refuses if anything nested under it would end up with nowhere to sit.

A move that skips levels has a second answer, and `--build-parents` is it: a
story dropped onto a program either becomes an epic, or *keeps its type* and
gets the epic and feature it was missing, created on the way. Nothing nested
under it changes at all, which is the reason to prefer it.

**Insert a step into a dependency.** `a -> b` becomes `a -> new -> b`, replacing
the edge rather than adding to it:

```bash
lpm insert --between LP-4..LP-7 -t "Validate the payload"
lpm insert --between LP-4..LP-7 --issue LP-9   # move an existing issue in
```

**Duplicate a structure.** Dependencies between the copied documents are kept
and repointed at the copies; those leaving the selection are dropped, so the
duplicate stands on its own:

```bash
lpm copy LP-3               # the feature and its stories
lpm copy LP-3 --under LP-9
```

Every one of these takes `--dry-run`, and every one refuses a change that would
break the hierarchy or close a dependency cycle before writing anything.

## Comments

Documents say what the work *is*. Comments say how it went:

```bash
lpm comment LP-7 "Blocked on the sandbox credentials; asked infra"
lpm comment LP-7 --file ./run-notes.md
lpm comment LP-7 --list
lpm comment LP-7 --remove 2
```

They live in a `_comments.md` beside the document, as a flat append-only list:

```markdown
## 2026-08-02T09:14:02.104Z — Alice Smith (RS-1)

Tried the naive join first; too slow at 100k rows.

## 2026-08-02T11:40:55.881Z — a jr. developer

Added an index on `created`. 40ms now.
```

That shape is chosen for what actually happens to comments: someone appends one,
and two people do it on different branches. Appends merge; a growing list in the
frontmatter would not, and it would push the fields tools read down the page.
The engine never loads them — `lpm check` does not care what you wrote — so the
log can be as long as the work deserves.

The author is whoever `lpm me` says you are, and the side panel in the web UI
writes to the same file.

## Working with agents

`lpm mcp` serves the board over the [Model Context
Protocol](https://modelcontextprotocol.io), so an agent can use light-plan the
way a person does — the same operations, the same rules, the same files.

`lpm mcp setup` writes the host configuration for you:

```bash
lpm mcp setup                              # -> <board>/.mcp.json
lpm mcp setup --user "Planner Bot"         # the agent acts as this team member
lpm mcp setup --file ~/.cursor/mcp.json    # merge into an existing config
lpm mcp setup --print                      # just show it
```

```jsonc
{
  "mcpServers": {
    "light-plan": {
      "command": "lpm",
      "args": ["mcp", "--user", "Planner Bot"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

With `--file` the entry is merged in place: the rest of the file is untouched,
and the key is matched to the one it already uses — `servers` for VS Code,
`mcpServers` for Claude Code, Claude Desktop and Cursor. Without it a new file
is written, and an existing one is never clobbered unless you pass `--force`.
Add a second, differently-named entry with `--name`:

```bash
lpm mcp setup --file .mcp.json --name light-plan-ro --read-only
```

The tools come in three groups. **Reading** — `board_overview` (call it first:
boards define their own types and statuses, and every other tool speaks in
those names), `list_documents`, `get_document`, `get_instructions`,
`check_board`. **Planning** — `create_document`, `update_document`,
`convert_document`, `split_issue`, `insert_between`, `copy_documents`,
`delete_document`, `link_issues`.
**Working** — `next_tasks`, `current_tasks`, `start_task`, `finish_task`,
`flag_issue`, `clear_flag`, `flagged_issues`, `add_comment`, `list_comments`,
`team_load`.
**Remote** — `remote_status` and `remote_preview` report the drift between the
board and its tracker, and what a sync would do, without writing anything;
`remote_sync` is the one tool that writes to a system outside the checkout and
is registered only under `--allow-remote` (see below).

`get_document` and `get_instructions` are the pair worth telling apart.
`get_document` returns one document as a record — fields, attributes, links,
ancestors as ids — and is what an agent wants before *changing* something.
`get_instructions` returns [the working brief](#working-briefs-the-context-to-actually-do-it):
the same document with the titles and bodies of its whole ancestry laid out above
it, as markdown to work from. An agent that reads only the story builds the right
code for the wrong reason, which is why the shipped `lpm-developer` agent calls
it before writing anything.

The reshaping tools go through the same planners as the CLI and the canvas, so
an agent that splits a story gets exactly the rewiring a person would.

This is meant for a mixed team. One agent writes the plan; others pick work up
with `next_tasks`, record what they tried with `add_comment`, and close it with
`finish_task` — while a human watches the same board in `lpm ui` and a reviewer
comments on the same issues. Because dependencies gate what `next_tasks` offers,
finishing one issue is what hands the next to whoever asks first.

`flag_issue` is the tool for the case that otherwise goes badly. An agent that
cannot finish something has three bad options — guess at the requirement, build a
workaround nobody asked for, or drift onto another issue leaving this one open —
and one good one, which is to say so and stop. A flag keeps the issue assigned,
turns it red for the human reading the board, and forces the comment that makes
it actionable. `clear_flag` is deliberately described as the plan owner's tool:
an agent should call it when it is the one answering somebody else's flag, not to
get past its own.

Three flags matter for that:

- `--user <id|name>` is **per session and never written to `.lpm/local.json`**,
  so a dozen agents can share one checkout without overwriting each other's
  answer to "who am I". It sets who work is assigned to and who comments are
  signed by.
- `--profile <file>` points the session at a [profile](#profiles-giving-one-developer-one-part-of-the-board),
  which is how five agents get five slices of one plan. It can carry the
  identity too, so one file per agent is the whole setup:

  ```bash
  lpm mcp setup --name frontend --profile ./profiles/frontend-agent.yml --file .mcp.json
  ```

  `board_overview` reports the scope in force and anything wrong with the file,
  and `list_documents` says how many issues it left out — an agent is told what
  it is not being shown rather than left to wonder why the board looks small.
  As on the CLI, the scope narrows `next_tasks` and `list_documents` and nothing
  else: `get_document` still reads any id, because an agent handed a dependency
  it cannot open is worse off than one shown work it should leave alone.
- `--read-only` registers only the tools that do not write, for an agent that
  should report on the plan rather than change it.
- `--allow-remote` registers `remote_sync`, the one tool that writes to a
  tracker outside the checkout. `remote_status` and `remote_preview` are always
  registered; `remote_sync` is not registered at all without the flag — absent,
  not present-and-failing, so a model does not keep retrying it. `--read-only`
  excludes every writing tool, remote included, regardless of `--allow-remote`.
  The remote's credentials are the *board's*, not the agent's: every agent that
  runs `remote_sync` pushes as the same tracker account.

The SDK is an optional dependency, so it installs by default but the engine
itself keeps its four. If you installed with `--no-optional`, `lpm mcp` says what
to install.

### Ready-made agents and skills

The package ships two agent definitions and five skills in [`assets/`](assets),
and `lpm agent` installs them into a project in whatever layout your harness
expects:

```bash
lpm agent --list                              # what ships, and where it lands
lpm agent --target claude                     # asks project or user account
lpm agent --target copilot --type developer --project
lpm agent --target reasonix --global
lpm agent --target claude --dry-run           # say what would happen
```

| `--target` | Agents | Skills | MCP |
| --- | --- | --- | --- |
| `claude` | `.claude/agents/*.md` | `.claude/skills/*/SKILL.md` | `.mcp.json` |
| `copilot` | `.github/agents/*.agent.md` | `.github/skills/*/SKILL.md` | `.mcp.json` |
| `reasonix` | `.reasonix/commands/*.md` (`runAs: subagent`) | `.reasonix/commands/*.md` | `.mcp.json` |

All three read a project `.mcp.json` in the standard format, so a project set up
for all of them ends up with one MCP config rather than three. User-level
installs differ more: `~/.claude/` + `~/.claude.json`, `~/.copilot/` +
`~/.copilot/mcp-config.json`, and `~/.reasonix/commands/` — where the MCP entry
is printed rather than written, because Reasonix keeps user servers in TOML.
[`docs/harness-layouts.md`](docs/harness-layouts.md) records every path, where it
came from, and what to check when adding a target.

`--type developer` installs the agent that picks work up, implements it and
leaves a reviewable trail on the issue, plus the skills it needs; `--type pm`
installs the one that writes epics, features and stories and sequences them.
Without `--type` you get both. `--global` installs for your user account instead
of the project, and with neither `--project` nor `--global` you are asked.

**An install never destroys what was already there.** An existing directory is
added to, an existing MCP config is merged into with its other servers and keys
untouched, and a file the harness owns — Copilot's `copilot-instructions.md` —
gets a delimited block that is replaced in place on the next run rather than
appended twice. A file the command wrote before is only overwritten with
`--force`.

Only the frontmatter differs between targets; the bodies are the same everywhere,
because the instructions are about light-plan rather than about who is reading
them. Read them as a description of how the tools are meant to be used, whichever
host you run.

The assets are a **neutral tree** and each layout is a **declarative mapping**,
so no code knows a harness by name:

```
assets/
  agents/<name>.md        the canonical assets — any files at all
  skills/<name>.md
  harnesses/<name>.yml    a list of copy rules, for one harness
  hcm/<name>.yml          the same, for one hcm bundle (lpm hcm init)
```

A mapping selects source files the way a `.gitignore` does and says where each
one goes:

```yaml
files:
  - from: skills/*.md                    # markdown: rewrite the frontmatter
    to: "{root}/skills/{name}/SKILL.md"
    frontmatter:
      name: "{name}"
      description: "{description}"

  - from: "scripts/**"                   # no frontmatter: copy byte for byte
    to: "{root}/scripts/{path}"
```

So supporting a new host is one YAML file, and shipping a new asset — a skill, a
hook script, a config template — is a file plus a pattern that selects it.
[`assets/README.md`](assets/README.md) is the short version and
[`docs/harness-layouts.md`](docs/harness-layouts.md) the long one, including what
each host's layout actually is and where that was verified from.

### The same assets as an hcm bundle

If you manage agent configuration with
[hcm](https://www.npmjs.com/package/harness-config-manager), `lpm hcm init`
registers light-plan's agents, skills and MCP server as the `light-plan` bundle,
and from then on any project installs them the hcm way:

```bash
lpm hcm init                                 # once, and again after each upgrade
hcm install light-plan -t claude-code        # in any project
hcm install light-plan -t copilot --flavor developer
hcm update light-plan                        # after re-running init
```

Without a global install, run it from the package — `npx light-plan hcm init`
from anywhere, or `npx --no lpm hcm init` in a project that depends on
`light-plan` (`--no` is what stops npx fetching the unrelated `lpm` package).

The bundle is **rendered, not kept**: `init` builds it from the same `assets/`
that `lpm agent` installs, at this package's version, into your per-user data
folder (`%LOCALAPPDATA%\light-plan\hcm`, `~/Library/Application Support/…`,
`~/.local/share/…`), then runs `hcm registry add` on it. Every bundle in
`assets/hcm/` is registered by the one command. The two roles are hcm flavors,
so `--flavor developer` is `lpm agent --type developer`. `lpm hcm build --dir
<path>` renders without registering, for publishing the bundle from a repository;
`lpm hcm remove` unregisters it; `lpm hcm init --dev` registers it in place for
working on the assets. [`docs/hcm.md`](docs/hcm.md) has the details.

## Git strategy

`.lpm` is initialised as **its own git repository** and added to the surrounding
project's `.gitignore`. The board sits inside your code checkout but keeps a
separate history and can have its own remote:

```bash
cd .lpm
git add -A && git commit -m "Plan the payments work"
git remote add origin git@github.com:you/my-project-board.git
git push -u origin main
```

This was chosen over a submodule deliberately: a submodule needs a commit in the
board *plus* a pointer commit in the parent for every change, and contributors
have to remember `clone --recursive`. A plain nested repo gives the same
independence with none of that ceremony.

Use `lpm init --no-git` to skip it and manage tracking yourself.

Because every document is its own file, concurrent edits rarely collide — two
people working on different issues never touch the same file, and dependencies
only ever write to the file that declares them. The one shared file is
`.lpm/state.json` (the id counters); if a merge mangles it, `lpm check --fix`
resyncs all three counters from disk, and ids are never reused because
allocation skips any id already present.

`init` also writes a `.lpm/.gitignore` holding `local.json`, the per-checkout
file that remembers who you are, and `lock`, the file that exists only while
somebody is part-way through a change. Neither is the team's.

## Several people and agents, one checkout

Git covers two people on two machines. This section is the other case: two
people, a browser session and a swarm of agents all writing to the *same* `.lpm`
folder at the same moment, with no server in front of it. Every one of them is a
separate process that read the board, decided something, and is about to write.

Three rules make that safe, and all three are in the engine, so the CLI, the MCP
server, the web app and `lpm queue agent` get them without asking.

**Nobody ever reads half a document.** Every write — a document, `state.json`,
`INDEX.md`, a saved view, `local.json` — goes to a temporary file beside the
target and is renamed into place. A reader sees the whole old version or the
whole new one; it can never catch a `_issue.md` mid-sentence, which on a YAML
frontmatter file reads as a corrupt board.

**One writer at a time.** Every operation that changes the board takes
`.lpm/lock` first — created with `O_EXCL`, so exactly one process can hold it —
and gives it up when the operation returns. It is held for the write and never
for the work: an agent may spend twenty minutes on a task and holds the lock for
the milliseconds it takes to record that it started. If somebody else has it you
are told who and what they are doing, rather than left to interleave with them:

```
error The board is busy: alice is doing "push 14 change(s)" (pid 5512 on lima)
      Gave up waiting after 10s to claim LP-12.
```

A process that is interrupted gives the lock up on its way out, including on
Ctrl-C, so the ordinary crash costs nothing. A kill nothing can catch does leave
the lock behind, and it is then broken for being **old** — two minutes by
default. Age is deliberately the only test: "is that process still running?"
looks like the obvious shortcut and is not one, because the answer is
occasionally wrong on a loaded machine, and a lock broken on a wrong answer lets
two writers into the same change. Waiting too long costs a wait; breaking too
early costs the guarantee.

Say what it does not do: the lock is advisory and cannot stop a text editor
writing `_issue.md`, and breaking a stale one cannot be made perfectly safe
without a filesystem primitive nobody has. That is why there is a third rule
rather than two.

**A stale write is refused, not applied.** Every load records what each document
looked like when it read it, and every operation checks that against disk before
writing. If somebody else changed the file in between, the operation refuses and
nothing is written:

```
error LP-12 changed on disk while you were working on it
      Somebody else — a person, an agent or an editor — wrote .lpm/board/LP-12/_issue.md.
      Nothing was written, so nothing was lost. Read it again and repeat the change.
```

That is deliberately a refusal rather than a merge: light-plan cannot know
whether your title and their status change belong together, and the board is in
git, so reading again and repeating the change costs a second. The one operation
that does not stop there is [claiming](#claiming-is-atomic) — a queue runner's
answer to losing a race is obvious, so it re-reads and reports the winner
instead of asking a person.

Two consequences worth knowing. `lpm new` cannot hand two processes the same id,
because the counter is read and written under the lock. And `INDEX.md` is
rewritten incrementally for speed, so when another process has moved it on since
your board was loaded, the operation reloads and renders the whole thing rather
than publishing a table of contents missing their work.

| Variable | What it does |
| --- | --- |
| `LPM_LOCK_TIMEOUT_MS` | How long to wait for another writer before giving up (default 10000) |
| `LPM_LOCK_STALE_MS` | How old a lock has to be before it is assumed to be a crash (default 120000) |
| `LPM_NO_LOCK` | Skip locking entirely |

`LPM_NO_LOCK=1` is the escape hatch for a filesystem where `O_EXCL` does not
mean what it says — some network mounts — on which every command would otherwise
fail. It removes the first line of defence and leaves the third: a stale write is
still refused.

## Commands

| Command | What it does |
| --- | --- |
| `lpm init [dir]` | Create a board. `--template`, `--prefix`, `--no-git` |
| `lpm new <type> [title]` | Create an issue, period or resource. `-t/--title`, `-p/--parent`, `-s/--status`, `--period`, `--assignee`, `--depends-on`, `--relates-to`, `--related`, `--starts`, `--ends`, `--capacity`, `--covers`, `--set k=v` |
| `lpm set <id>` | Edit content. `-t/--title`, `--body`, `--body-file`, `--set k=v`, `--related`, `--unrelated`, `--starts`, `--ends`, `--capacity` |
| `lpm move <id>` | `-s/--status <id>`, `-p/--parent <id>\|root`, `--period <id>\|none`, `--assignee <id>\|none` |
| `lpm convert <id> <type>` | Change the type, moving it if the type belongs elsewhere. `--under <id>`, `--build-parents`, `--dry-run` |
| `lpm link <id>` | `--depends-on <ids>`, `--relates-to <ids>`, `--covers <ids>`, `--remove` |
| `lpm insert` | Put an issue inside a dependency. `--between <a>..<b>`, `--issue`, `--type`, `-t/--title` |
| `lpm split <id>` | Break an issue up. `--into <n>`, `--titles`, `--replace`, `--children`, `--no-chain`, `--split-effort`, `--dry-run` |
| `lpm copy <id>...` | Duplicate documents and their subtrees. `--under <id>`, `--dry-run` |
| `lpm rm <id>` | Delete a document. `-r/--recursive`, `--dry-run` |
| `lpm comment <id> <text>` | Add to the work log. `-m/--message`, `-f/--file`, `--list`, `--remove <n>`, `--author` |
| `lpm flag [<id>]` | Say work has stopped, and why. `clear <id>`, `list`, `-m/--comment`, `-f/--file`, `--reason`, `--author` |
| `lpm open <id>` | Open in `$VISUAL`/`$EDITOR`. `--path` prints the path instead. Alias: `lpm edit` |
| `lpm me [<id\|name>]` | Show or set who is using this checkout. `--clear`. Alias: `lpm whoami` |
| `lpm profile [<file>]` | Use a profile: who you are, and which part of the board is yours. `--file`, `--init`, `--user`, `--clear`, `--force`. Alias: `lpm user` |
| `lpm task <sub>` | `next`, `current`, `prev`, `start [id]`, `done [id]`. `--limit`, `--unassigned`, `--parked`, `--force` |
| `lpm upstream <id>` | Everything that must be finished first. `--schedule`, `--period`, `--assignee`, `--unscheduled`, `--unassigned`, `--dry-run`. Aliases: `lpm blockers`, `lpm prerequisites` |
| `lpm period <id>` | How it stands. `--on`, `--off`, `--dates`, `--start-now`, `--complete`, `--carry-over`, `--dry-run` |
| `lpm instructions [<id>]` | Print the working brief for an issue. `--id`, `--template`, `--no-comments`, `--list`, `--init`, `--force`. Aliases: `lpm brief`, `lpm context` |
| `lpm team` | Roster and load. `--period <id>`, `--open`. Alias: `lpm roster` |
| `lpm queue simulate` | Work the queue through as one person. `--user <id\|name>`, `--role <id\|name>`, `--unassigned`, `--parked`, `--limit <n>`, `--skipped` |
| `lpm queue agent` | Drain the queue with the pi coding agent. `--user`, `--max-tasks`, `--model`, `--effort`, `--commit`, `--unassigned`, `--parked`, `--timeout`, `--command-timeout`, `--plain`, `--file`, `--dry-run` |
| `lpm remote [<sub>]` | Mirror the board onto an external tracker. No subcommand lists the remotes. `connect`, `push [<id>…]`, `pull [<key>…]`, `sync`, `status`, `ledger`, and the less common `add`, `login`, `setup`, `rm`, `log`, `resolve`, `link`, `unlink`, `decouple`, `relink`, `rebase`. `--remote <name>`, `--all`, `--children`, `--recursive`, `--parent <id>`, `--scope <id>`, `--force`, `--purge`, `--dry-run`, `--changed`, `--limit N`, `--yes`, `--refresh`, `--since <iso>`, `--json` |
| `lpm check` | Validate. `--fix` repairs, `--strict` also fails on warnings |
| `lpm ui` | Open the board in a browser. `--port`, `--host`, `--no-open`, `--api-only`, `--experimental`. Alias: `lpm web` |
| `lpm export` | Publish the board as a static site. `-o/--out`, `--site <dir>`, `--workflow`, `--pretty`. Alias: `lpm publish` |
| `lpm mcp` | Serve the board to AI agents over MCP. `--user`, `--profile`, `--read-only`, `--allow-remote`, `--root` |
| `lpm mcp setup` | Write the MCP config a host needs. `--file`, `-o/--output`, `--name`, `--user`, `--profile`, `--read-only`, `--allow-remote`, `--print`, `--force` |
| `lpm agent` | Install the agents, skills and MCP config into a project. `--target`, `--type`, `--project`, `--global`, `--dir`, `--name`, `--user`, `--profile`, `--read-only`, `--no-mcp`, `--force`, `--dry-run` |
| `lpm hcm init` / `build` / `remove` | Register the agents, skills and MCP server as hcm bundles; render them without registering; unregister them. `--dir`, `--dev` |

`lpm check` exits 1 when errors remain, so it drops straight into CI or a
pre-commit hook. Run `lpm <command> --help` for full options.

### Environment

| Variable | What it does |
| --- | --- |
| `LPM_BOARD_PATH` | The board to work on, from any folder |
| `LPM_USER` | Act as this resource ([who you are](#working-as-a-team-member)) |
| `LPM_PROFILE` | The profile file to use ([profiles](#profiles-giving-one-developer-one-part-of-the-board)) |
| `LPM_LOCK_TIMEOUT_MS`, `LPM_LOCK_STALE_MS`, `LPM_NO_LOCK` | The write lock ([sharing a checkout](#several-people-and-agents-one-checkout)) |

Normally `lpm` finds the board by walking up from the current folder, the way
`git` finds a repository. `LPM_BOARD_PATH` says which board instead, so the CLI
works from anywhere — a scratch directory, your home folder, an agent host that
starts somewhere you did not choose:

```bash
export LPM_BOARD_PATH=~/work/payments/.lpm
cd /tmp && lpm task next          # still the payments board
```

Point it at the `.lpm` folder or at the folder holding it; either reads. If it
names no board that is an error rather than a fall back to the search, because
a typo that quietly worked on whichever board you happened to be standing in is
the failure nobody notices.

Two commands are deliberately deaf to it. `lpm init` always creates the board
where you told it to — creating a board somewhere is not the same as reading
the one you work on — and says so if the variable points elsewhere. And an
explicit path wins: `lpm mcp --root`, `lpm mcp setup --root` and `lpm agent
--project` are about the folder they name.

## Web UI

`lpm ui` opens the board in a browser: a left-to-right dependency graph, a
resizable drawer with a table, the increments and sprints, a Gantt chart and the
team roster, and a side panel for editing whatever is selected.

```bash
lpm ui                 # serve the board and open a browser
lpm ui --port 8080     # somewhere else
lpm ui --api-only      # just the JSON API, for the dev server below
lpm ui --experimental  # also offer features that are not finished yet
```

The server binds to `127.0.0.1`, serves one board — the checkout it was started
in — and has no notion of users or sessions. It is the same engine the CLI uses,
behind a small REST API.

**Tracker remotes are experimental in the web UI.** Mirroring the board onto
Jira, GitHub or Linear — the Sync tab's tracker panel and its **Connect…**,
readiness and **to fix** windows, the drift badges on the canvas, the **Push**
and **Pull** entries in the canvas menu and the side panel's remote and conflict
sections — is shown only by `lpm ui --experimental`. Without the flag the server
does not register the `/api/remotes` routes at all, and the Sync tab offers
[sharing the board through git](docs/git-sync.md) and nothing else. The bullets
below marked *(experimental)* describe that mode. The `lpm remote` commands are
unaffected.

### Views

Work in the UI happens inside a **view**: a saved slice of the board, stored as
JSON in `.lpm/views/<name>.json` and committed like everything else. A view
records which issues are on the canvas, where they sit, how big they were
dragged, which subflows are collapsed, which levels are drawn as badges rather
than as nodes, how the panes are sized, and any edits that have not been written
to the board yet.

Every change is queued in the open view and autosaved there — but there is
nothing to press to send it. A debounce (~1.5s, so a dragged slider or a few
fields typed in a row still land as one write) replays the queue through the
same operations the CLI uses (`createIssue`, `updateNode`, `retypeNode`,
`moveNode`, `removeNode`) and reports anything the board rejected — a push is
partial rather than all-or-nothing, so one bad edit does not hold the rest
up. The top bar has no Push or Pull button any more, just a status label —
*pushing…*, or how many edits are still waiting for the debounce to fire —
because "have I written this down yet?" stopped being a question anybody has
to ask. Pulling is the same: the open view polls the board every few seconds
and lays your unpushed work back over whatever it finds, so a file changed by
another window, `lpm`, or an agent working the queue shows up here on its
own. That poll is not a filesystem watcher — it is a plain re-read on a timer
— so "instantly" is closer to "within a few seconds".

Anything the board refuses — a rejected change, a cycle, a board that will not
load — is a red card across the top of the screen that stays until it is
dismissed. Anything merely informative is a quieter one that clears itself.

Because the queue lives in the view file, closing the tab loses nothing, and a
teammate who pulls your branch sees the same canvas you were looking at.

### What it does

- **Home** — before you open a view, three readings of the board. *Now* is the
  increment and sprint running today, what is in flight in it, and what is
  unblocked and unstarted, ranked the way `lpm task next` ranks work; when
  today's sprint is finished it looks ahead to the next one with work in it and
  says so. *Just added* is the last handful of issues written, newest first.
  *Open pathways* ignores the calendar and asks the graph instead: the epics and
  features whose blockers are all done, so work could start anywhere inside
  them, ordered by how much finishing one would release.
- **Graph** — nodes carry a target handle on the left and a source handle on the
  right; issues with children render as collapsible subflows, and collapsing one
  reroutes its descendants' dependencies onto it. Colour follows status, the
  icon follows type, and edges into work in progress animate. Edges are routed
  orthogonally, and selecting a node lights up everything one hop from it —
  its blockers, what it blocks, and the edges between — while selecting an edge
  lights up the two issues it joins. Those edges are drawn in a contrasting
  colour with the dash travelling the way the dependency runs, so the chain you
  asked about is findable in a graph of hundreds; everything else fades back.
  Edges *leaving a flagged issue* are drawn red and slightly heavier with
  nothing selected at all, so the work stalled behind a flag is a shape you can
  see from across the board rather than something to go clicking for — a folded
  feature holding a flagged story shows it too.
  A scheduled issue carries a badge naming the periods it sits in
  (`PI-1 · Sprint A`), and the ones in the period running *today* are washed in
  amber with a strip along the top — so the work to pick up now is a shape on
  the canvas rather than something to go looking for. The layout flows left to
  right along the dependencies, subflows stretch in both directions to hold what
  is inside them, and issues added later are set down clear of the ones already
  placed. *Arrange* lays the whole thing out again.
- **Interaction** — context menus on the canvas, on a node and on an edge; drag a
  node onto another to reparent it, hold <kbd>Alt</kbd> and drop one onto an
  edge to splice it in, rubber-band or <kbd>Shift</kbd>-click to multi-select,
  <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>V</kbd> to copy structures. Holding
  <kbd>Ctrl</kbd> turns every surface into the pane: dragging pans the camera
  even when it starts inside a node, which is what makes a subflow the size of
  the screen navigable. A pan does not stop at the edge of the display — the
  cursor is taken off screen for the length of the drag and given back where it
  started, so a board several screens wide crosses in one gesture. Select a node
  to get resize handles: the size is saved with the view, and a subflow will not
  be dragged smaller than its contents.
- **Editing a selection** — <kbd>Shift</kbd>-click or rubber-band as many issues
  as you like, then right-click *anywhere* — one of them, or the empty canvas —
  and the menu addresses all of them: **Change status**, **Assign to** (everyone
  on the roster, the generic pools listed after the people), **Schedule into**
  (the period tree, indented, plus the backlog), remove from the view, delete.
  A tick means every selected issue is already there. The same menu is on a
  table row, and dropping a teammate from the roster onto one of several
  selected nodes assigns all of them — so fifteen stories reach somebody in one
  gesture rather than fifteen trips through the side panel. Right-clicking never
  changes the selection unless the click lands outside it.
- **Push and pull** *(experimental)* — right-click a selection for **Push** and **Pull** when
  the board mirrors a remote. Push files exactly what is selected, never the
  subtrees beneath it; Pull fetches the twins of the selected documents, and
  counts them, so pulling something with no twin is offered as nothing rather
  than as a smaller pull. The side panel does the same for the one document it
  is showing, with the twin's key linked out to the tracker, a line saying
  which way it has drifted, and an **include everything under it** tick for a
  container. Both go through the same run as the Sync tab, so the refusal to
  sync over queued edits holds here too: Push your edits to the board first —
  the board is what travels upstream. Until the remote's drift report arrives
  — it reads every twin, which on a large tracker takes a minute or two — the
  panel says *Reading the remote…* and Pull is greyed with the same reason,
  rather than showing nothing and looking as if the document were not
  mirrored.
- **Before a push writes** *(experimental)* — every push asks the tracker two questions first
  (who it can assign work to, which periods it holds) and shows what will not
  land the way the board says: a person with no account upstream, an account
  that went stale, a pool, a sprint nobody filed. Each row offers the same two
  answers — **leave it** (filed blank, and a later push writes it once the far
  side exists) or **fix it** (the account written onto that person's roster
  document, the period filed in the same run, an assignee the board has lost
  cleared) — and the dialog offers the third, **cancel**. Only a board
  contradicting itself blocks the push; everything else is a degradation you
  can accept with one click.
- **How the mirror is doing** *(experimental)* — the Sync tab shows the local half of the drift
  report as soon as the board opens: which documents have twins, what has never
  been pushed, what has been edited here since the last sync. Asking the tracker
  what moved *upstream* needs a credential and can fail, so it reads the project
  in one paginated listing, and while it runs the tab says how many twins it is
  comparing and for how long, can stop it, and keeps any failure on screen. The
  result of that read is remembered in the browser, so reopening the board shows
  the same "checked" state and counts it showed last time — with a "checked
  Xm/h/d ago" note beside them — rather than reading the tracker again before
  anybody asked; **Check again** forces a fresh read, and any sync forgets the
  cache for the remote it just wrote to, since that run is exactly what would
  make the old numbers wrong. Because it reads the whole project it also reports
  **incoming** work — issues in the tracker with no document here yet, which is
  what a story somebody added upstream looks like. Each row names the local
  document a pull would file it under, with **Pull** beside it. At the terminal
  the same split is `lpm remote status --local`, and `--changed` is the cheaper
  incremental read (the terminal has no browser cache to fall back on, so it
  always reads live when asked).
- **Which documents, and why** *(experimental)* — under the counts is a table of what a sync
  would actually do: one row per document, the direction it moves, and the
  fields that say so. Clicking a count (**to push**, **to pull**,
  **conflicts**) scrolls to the table and narrows it to that count; clicking it
  again shows everything. Each row links to the document on the canvas. Edits this remote
  *cannot* store are deliberately not in the table — a sync will not write
  them, so they would only bury what it will. The **to fix** chip counts them
  instead, and opens a window grouping them by the cause they share (one person
  with no account value, say) with the change that clears each one — a window
  rather than a panel section, because most of these are differences between
  the two tools rather than mistakes, and a list of things nobody can fix this
  week should not be on screen every time the tab is opened.
- **Coverage** *(experimental)* — the Sync tab lists what the remote is *missing* around what it
  already holds: the work inside a filed container, the containers above filed
  work, the period mirrored issues were filed without, and the far end of a
  dependency that could not be written. Each group says what it costs and each
  row names the mirrored documents behind it, so nothing in the list is
  unexplained. Tick what you want and **Push selected** files exactly those —
  a container ticked beside its contents is created first and they are filed
  under it in the same run. It is read from the board and the link store rather
  than from the tracker, so it is on screen at once and re-read after every
  push; the side panel shows the same for one document and the canvas menu
  offers it for a selection. A document you decoupled, or one outside the
  remote's scope, is reported rather than offered — both were decided.
- **Connect a remote** *(experimental)* — the Sync tab's **Connect…** (or **Connect a remote…**
  on a board with none) asks which tracker, where its project is, and the
  credential, in one form drawn entirely from what each provider declares: the
  fields it needs and which are optional, a worked example beside each, the
  page where its token is created, and which credential keys are secret. A
  secret field is masked; a value that is no secret to look at, such as an
  account email, is not. The credential is stored in `.lpm/credentials.json`,
  which is git-ignored, and is never shown again — the page reports only where
  each value comes from. **Connection** opens the selected remote: edit where
  it points, replace an expired token (a blank keeps what is stored), **Test
  connection** to ask the tracker about itself — what it answers
  unambiguously, such as a Jira board id, is written for you, and what it
  cannot decide is offered as a choice — and remove it. A remote that already
  mirrors documents cannot be pointed at a different project in place: remove
  it and connect again.
- **Upstream work** — right-click one issue for **Add upstream dependencies**
  and everything that has to be finished before it lands on the canvas: the
  chain of edges behind it, the open stories inside each blocking container, and
  the features and epics around them so nothing floats free. Nothing is edited —
  it is a way of looking, and the canvas is where "absolutely everything
  required to close this" is a shape rather than a list. **Schedule upstream
  dependencies** beside it is the other half: every unclaimed piece of that work
  is queued into the same sprint, for the same person or pool, as the issue
  waiting on it. Work somebody already holds is left alone and reported, so a
  chain six people are already on does not come back as "nothing to schedule".
  Both are `lpm upstream` [described above](#what-has-to-happen-first-upstream-work),
  reading the same rule.
- **Options ▸ DAG ▸ Hierarchy display** — how deep the canvas draws. A board four
  levels deep drawn as boxes inside boxes is a picture of the hierarchy, not of
  the work: the dependencies run between the stories at the bottom, and every
  level above is a frame around the part you are reading. Set a level to
  **badges** and its issues leave the canvas — everything under them moves up a
  level wearing their id, so the graph is the work and the structure is a label.
  Several levels can be badged at once, a level with nothing underneath to carry
  its badge stays a node, and the choice is saved with the view (and published
  with it). The canvas is laid out again when it changes, because badging a
  level moves everything below it.
- **Options ▸ Planning** — whether this view plans with a calendar at all.
  *Sprints and increments* is the default and gives the drawer its Periods and
  Gantt tabs. *Queue* is for the way plenty of teams actually work — nobody
  plans a fortnight, work is taken off the top as the graph unblocks it — and
  swaps both tabs for the Queue. Nothing about the board changes either way:
  the same documents, the same dependencies, a different question in front of
  you. A board whose config declares no period types is always in the second
  mode, because there is nothing to plan with.
- **Dropping something where it does not fit** — a story dragged onto a program
  skips two levels, and there are exactly two honest answers, so the app asks
  rather than guessing: *change its type*, and the story becomes an epic, or
  *create containers to hold it*, and the epic and feature it was missing are
  built for it (titles editable before they exist) while it stays a story with
  everything underneath it untouched. That is `lpm convert --under` and
  `--build-parents`, from the same planner.
- **Table** — the whole board as collapsible rows, with inline editing and a
  checkbox per row for what appears on the canvas. The checkbox in the header
  puts everything the filter matches on the canvas at once, and
  <kbd>Shift</kbd>- or right-clicking a row's checkbox takes that issue's whole
  subtree. Quick filters answer the usual questions without typing — what is in
  progress, what just finished, what was just added, what is on the canvas — and
  *Show down to* folds the tree to a level, so one click leaves the programmes
  showing with their epics closed. Clicking a row moves the graph to it, and
  selecting anything anywhere scrolls this list to it and opens whatever it was
  folded inside.
- **Periods** — the timeline as boxes of work, nested the way the periods are:
  each sprint is drawn *inside* the increment it belongs to, one band under
  another down the pane, with everything unscheduled in a box at the end. Every
  level holds cards of its own, because an epic can sit in the increment while
  its stories sit in the sprints. Drag a card into a box to schedule it — a drop
  lands in the innermost box under the pointer — or select issues anywhere and
  press *← selection* on the box that should have them; the × on a card takes it
  back out.

  Work can also come straight off the canvas: **hold Alt and drag a node into a
  box**. What lands in the sprint is the *work under* what was dragged — drop an
  epic and its user stories are scheduled, drop a feature and only its own are,
  drop a story and it goes in by itself. Containers are never scheduled by this,
  because a feature is not a thing you pick up, it is the name of the stories
  you do; nor are the sub-tasks inside an `atomic` story, which travels whole. Dropping onto the unscheduled box takes the whole subtree back out
  again.

  Nothing on the canvas moves while you do it: the node stays exactly where it
  is, the camera holds still, and no position is saved. Being scheduled into a
  sprint is not a change to the picture, so the picture does not change — only
  the box under the pointer lights up. Escape puts it down with nothing altered.
  Without Alt a drag still moves the node, as it always did.

  Headers edit the period's name and dates in place, and each box
  counts its issues and its effort: its own, and the total including everything
  nested inside it. Every box folds to a single line — when it runs, what is in
  it, how many boxes are inside — with *Collapse all* and *Expand all* in the
  toolbar; a folded box still takes a drop, so a run of folded sprints is a fast
  way to file a card into a distant one.

  Drag a box by its grip to move it in the running order. A sprint has no
  position to change — the order sprints run in *is* their dates — so dropping
  one on another rewrites the run: each period keeps its own length, the gaps
  between them stay where the calendar had them, and the whole sequence shifts
  around the move.

  The period that is running is washed in the same amber the canvas uses, and
  the increment holding it is outlined, so "where are we?" is answered by
  looking. Every other period offers **Start now**, which is the button for the
  Monday when the plan and the team disagree: it moves that sprint onto today
  keeping how long it runs, takes the periods nested inside it along by the same
  number of days, closes whatever *was* running the day before, and stretches
  the increment around the new dates. It always says exactly which dates it is
  about to rewrite and waits for an answer — starting a sprint is a sentence
  somebody says in a stand-up, and moving six documents' dates is not.

  Beside that sits the **switch**, which runs in parallel with the calendar and
  is the control for a team that does not plan by date, or one that has to
  reroute people mid-sprint. On is on whatever the dates say; off parks the
  period and everything nested inside it, and its work sinks to the bottom of
  every queue; clicking again hands it back to the dates. Switching a period on
  when today has fallen outside it asks whether to move the dates to match —
  reusing the plan in an increment that was started and abandoned is exactly a
  restart — and declining still flips the switch, leaving the dates as the
  record of what was planned.

  A period whose end date has passed with work still open in it is drawn in
  **red** with a **Fix…** button, which offers the two honest answers side by
  side: mark the open work done, which records that the team stopped, or carry
  it into the next period and leave what was finished where it was delivered.
  No period is invented to hold it, so carrying work down a run makes the last
  sprint's backlog grow — and when there is no next period the dialog says so
  instead of offering the button. Both are queued like any other edit, so they
  can be read in the pending list before a push.

  Adding a period seeds its dates from the one before it,
  so filling a quarter is a row of clicks; the × deletes one with everything
  nested in it, and *Clear all* deletes the whole timeline after a confirmation.
  Deleting periods never deletes work: the issues in them simply become
  unscheduled.
- **Queue** — the same board for a team that does not plan in sprints. *Ready*
  is every unstarted work unit with no unfinished blocker, in the order `lpm task
  next` would offer them: priority first, then how much finishing one would
  release. *In progress* is what is being worked on, *Blocked* says what each
  waiting issue is waiting on rather than hiding it, and *Just finished* is the
  tail. Drag a card between lanes, or press *Start* and *Finish* — either way it
  is one status change. This is what the drawer offers instead of Periods and
  Gantt when a view is set to work off the queue (Options ▸ Planning), and the
  only thing it offers on a board whose config declares no periods at all.
- **Gantt** — the plan on a date scale, read at whichever level you want:
  *by period*, with the issues scheduled in each one nested underneath it, or
  *by hierarchy*, where every parent gets a bar covering the work beneath it
  (dashed when the dates are borrowed from that work rather than its own
  period). Rows fold, and *Show down to* folds them a whole level at a time —
  one click for increments, sprints, or any level of the issue hierarchy inside
  them. The critical path is highlighted.
- **Team** — the roster with load against capacity, grouped by discipline, team,
  assignment or pool. Drag a card onto a node to assign it. The pencil on a card
  opens the rest of a resource: its type, its team, its attributes and notes,
  and the pools it covers — from either side, so a pool's own editor is a list
  of who can pick work up from it.
- **Side panel** — every reserved field and every configured attribute with a
  type-appropriate editor, the body rendered as markdown (*Edit* — or a
  double-click — swaps it for the source), the immediate upstream and downstream
  issues (plus, on a container, the ones the work inside it puts it in order
  with — see [dependencies](#dependencies); those carry no unlink button,
  because nothing is written on the document to break), and *Break down*, which
  splits an issue into N pieces either as
  children or as a chain that replaces it — rewiring both ends of the graph
  either way. Drag its edge to widen it; the width is saved with the view.
- **Panes that spend the room** — dragging the drawer taller or the panel wider
  grows the type and spacing inside it, so a pane made bigger shows bigger rows
  rather than more empty space. Growth is gentler than the drag and stops at
  half again, because the point of the drag was to see more.

### Building it

The app lives in [`web/`](web/) and is a separate package, so the published CLI
keeps its four runtime dependencies.

```bash
make build         # engine + app + viewer
make ui            # serve a throwaway demo board in a browser
make site          # export the demo board as a static site and serve that
make dev           # rebuild both as you edit; reload the browser to see changes
make dev-web       # Vite dev server with hot reload, against the demo board
```

`make ui` and `make dev-web` create a sample board in `.demo/` first, so you have
something to look at without touching a real one. `lpm ui` serves `web/dist`, and
says so if it has not been built.

## Publishing a board

`lpm ui` needs a checkout, a Node install and a running process. `lpm export`
needs none of that: it writes the board into a single JSON file and, with
`--site`, drops a read-only viewer next to it. The result is an ordinary static
site — point GitHub Pages at it and anyone with the link can read the graph.

```bash
lpm export                      # refresh .lpm/board.json
lpm export --site docs          # a complete site in docs/, ready for Pages
lpm export --site docs --workflow   # ...and a workflow that keeps it current
```

`--site docs` writes `docs/index.html`, its assets, `docs/board.json` and a
`.nojekyll`. Commit the directory, then **Settings → Pages → Source: `/docs`**,
and the board is at `owner.github.io/repo/`. `--workflow` instead writes
`.github/workflows/lpm-board.yml`, which regenerates `board.json` from `.lpm/`
and deploys on every push — for that one, set **Source: GitHub Actions**.

The viewer is deliberately less than the editor: the dependency graph, a picker
for the board's saved views, and a details panel for whatever is selected. No
editing, no drawer, no comments, no push — there is no server to push to. You
can still pan, zoom, fold subflows, drag nodes around and re-*Arrange*; tidying
the picture you are reading is not editing the board.

Boards with no views in `.lpm/views/` still work: the picker always offers
**All issues**, the whole board with every parent folded, so it opens at its top
level and unfolds where you are interested.

### Reading someone else's board

The published page is a viewer, not just a rendering of one board. Give it a
repository and it will read that one instead:

```
https://acme.github.io/plan/?repo=other-org/their-repo
https://acme.github.io/plan/?repo=other-org/their-repo@release/2026
https://acme.github.io/plan/?repo=other-org/their-repo&path=docs/board.json
https://acme.github.io/plan/?src=https://example.com/anywhere/board.json
```

`?repo=` reads `.lpm/board.json` over `raw.githubusercontent.com`, so the other
repository needs nothing installed — just a committed export. It is one GET of
one file: no GitHub API, no token, no rate limit worth planning around, and
public repositories only. `#/view/<id>` in the address names the open view, so
any picture on screen is a link.

### What travels, and what does not

The exported file is the board **as committed**. A view's queued-but-unpushed
changes are somebody's draft and never appear in it, and a view is narrowed to
its `members` and `layout` — drawer and panel state mean nothing to a reader.
Members naming a document that no longer exists are dropped.

Everything else in the file is what `.lpm/` already publishes to anyone who can
read the repository, including issue bodies. Treat `board.json` as exactly as
public as the board it came from. The viewer renders bodies as plain text, never
as markup, because it will happily read a board from a URL you were handed.

`board.json` is generated, so it goes stale like any build output. Either let
the workflow rebuild it, or re-run `lpm export` before you commit.

## Using the engine directly

The CLI is a thin shell over `src/core`, which is exported as a library so a GUI
can drive the same board:

```ts
import {
  findBoardPaths, loadBoard, createIssue, createPeriod, createResource,
  linkIssue, issuesInPeriod, periodChain, checkBoard,
  nextTasks, currentTasks, resourceLoad, currentUser, currentScope,
} from 'light-plan';

const paths = findBoardPaths()!;
const board = loadBoard(paths);

board.roots;                     // issue tree, each node with .children
board.periodRoots;               // period tree
board.resourceRoots;             // roster tree
board.byId.get('LP-4');          // flat lookup
board.dependents.get('LP-4');    // derived inverse of depends_on
board.coveredBy.get('RS-4');     // derived inverse of covers
issuesInformedBy(board, 'LP-4'); // what rests on that research, resolved
issuesInPeriod(board, 'TL-1');   // sprint/increment contents
periodChain(board, 'TL-2');      // [increment, sprint]
nextTasks(board, 'RS-1');        // ranked recommendations for one person
nextTasks(board, 'RS-1', { scope: currentScope(board) });  // ...through their profile
currentTasks(board, 'RS-1');     // what they have in flight
resourceLoad(board, { periodId: 'TL-2' });   // who is carrying what
checkBoard(board);               // Problem[]
```

Everything is synchronous filesystem work with no ambient state, so it is easy
to test and easy to call from an editor extension or a desktop app.

### How `src/core` is organised

Eight layers, each depending only on the ones above it:

| Folder | Responsibility |
| --- | --- |
| `model/` | What an issue, period, resource, type and problem *are*, plus pure logic over them (attribute types, the dependency graph). No I/O — the one layer everything else may depend on. |
| `config/` | Parsing `.lpm/config.yml` into a validated `BoardConfig` (`schema.ts`) and answering questions about it (`lookup.ts`). Every rule about hierarchy depth, statuses and type namespaces resolves here. |
| `storage/` | How a board is encoded on disk: `paths`, `frontmatter`, `document` (serialize/write), `comments` (the work log beside a document), `state` (id counters), `local` (current user and profile path), `views` (saved UI views), `templates` (the context layouts), `git` (authorship). Knows the layout, not what makes it valid. |
| `board/` | Reading all three collections into a `LoadedBoard` (`load.ts`), navigating it (`query.ts`), narrowing it to one person's part of it (`scope.ts`) and recommending work (`tasks.ts`). |
| `profile/` | The file one developer is handed: parsing it (`schema.ts`) and finding the one in force (`current.ts`). Never board truth — `check` neither reads one nor knows it exists. |
| `instructions/` | One issue plus its ancestry, rendered as a working brief: the little template language (`template.ts`), the values it can see (`context.ts`), the layout every board falls back to (`builtin.ts`) and which layout to use (`instructions.ts`). Read-only, like `tasks.ts`. |
| `operations/` | The commands that change a board: `init`, `create`, `update`, `retype`, `move`, `link`, `comment`, `remove`, `user`, `profile`. Each validates fully before touching the filesystem. |
| `validation/` | `check.ts` (read-only, reports everything) and `fix.ts` (repairs exactly what check marks `fixable`). Sharing a folder is what keeps the two from drifting. |

`errors.ts` sits outside the stack — any layer may throw a `BoardError`.

Each folder has an `index.ts` describing it, and `src/core/index.ts` re-exports
them all, so importing from `light-plan` is unaffected by the internal layout.

Three more folders sit above the engine, shared by everything that drives it:

| Folder | Responsibility |
| --- | --- |
| `src/shared/` | The contract: the DTOs that cross the wire, the `Change` protocol edits are expressed in, and `plans.ts` — the multi-step edits (split, insert, copy, convert, reparent) as pure functions from a board to a list of changes. Imports nothing, so it compiles for Node and the browser alike. |
| `src/sync/` | Replaying a change list through the engine, and mapping the core model onto the DTOs. |
| `src/server/`, `src/mcp/` | The two remote front ends: HTTP for the web app, MCP for agents. |

That is why `lpm split`, the canvas's *Break down* button and an agent's
`split_issue` tool produce the same board: all three plan with `src/shared` and
apply with `src/sync`.

## Development

There are two packages here: the engine and CLI at the root, and the web app
under `web/` with its own `node_modules`. The [`Makefile`](Makefile) drives both,
so you rarely have to think about which is which. `make` on its own lists
everything.

| Target | What it does |
| --- | --- |
| `make doctor` | Check Node, npm, git and the installed dependencies before you start |
| `make setup` | Fresh clone to working `lpm`: install both packages, build, `npm link` |
| `make dev` | Watch `src/` and `web/src/` and rebuild on every change |
| `make dev-web` | Vite dev server with hot reload, against the demo board |
| `make ui` | Serve a throwaway demo board in a browser |
| `make mcp` | Serve that demo board to an agent over MCP |
| `make demo` | Create that demo board in `.demo/`, seeded with issues, sprints and a roster |
| `make test` | Both test suites |
| `make typecheck` | `tsc` over the engine, `svelte-check` over the app |
| `make verify` | Typecheck, test and build: what a pull request should pass |
| `make dist` | Build a publishable tarball in `release/` and check its contents |
| `make publish CONFIRM=yes` | Verify, build the tarball and publish it to npm |
| `make version-patch` | Bump the version, commit and tag it (also `-minor`, `-major`) |
| `make outdated` | Dependencies with newer releases |
| `make clean` / `make fresh` | Remove build output / wipe everything and set up again |

`make dev` is the working loop: it links the CLI globally and keeps rebuilding,
so `lpm` and `lpm ui` always run the code you just edited — reload the browser to
pick up the web app. For UI work, `make dev-web` is faster: Vite serves the app
with hot module reload and proxies the API to a real board server.

Targets that produce files depend on their sources, so `make build` does nothing
when nothing has changed. Every target runs from `cmd.exe` and PowerShell as well
as from a POSIX shell — GNU Make and Node are all it needs (on Windows,
`choco install make`).

Without Make, the same steps are npm scripts:

```bash
npm run build          # compile src/ to dist/
npm run typecheck      # src + tests
npm test               # builds, then runs vitest (unit + end-to-end CLI + API)

npm run install:web    # install the web app's dependencies
npm run build:all      # engine + web app
npm run typecheck:web  # svelte-check over web/
npm run test:web       # the web app's unit tests
```

Runtime dependencies are `yaml` and `zod` (config and schemas), plus `eta` and
`acorn` — the template engine behind `lpm instructions` and the parser its safety
check reads templates with. Argument parsing uses Node's built-in
`util.parseArgs`. The web app is its own package under `web/` with its own
dependencies (Svelte 5, SvelteFlow, dagre), and is built to static assets that
the `lpm ui` server hands out.

### Releasing

`make dist` builds both packages, packs a tarball into `release/`, and fails if
the CLI, the built web app or the templates are missing from it — a package
without `web/dist` installs cleanly and then serves an empty page, which is the
mistake worth catching before publishing. Install the result anywhere with
`npm install -g ./release/light-plan-<version>.tgz` (the `./` matters — without
it npm reads the path as a GitHub repository).

**A release is a pushed version tag.** The
[Publish workflow](.github/workflows/publish.yml) takes it from there:

```bash
make version-patch                         # or -minor / -major: bumps, commits, tags
git push --follow-tags                     # the workflow verifies, packs and publishes
```

It runs the same targets a release from a laptop does — `make ci` (lockfile
install, typecheck, build, assets, both test suites), then `make dist` — and
publishes the tarball `make dist` checked. Before any of that it refuses a tag
that does not match the version in `package.json`, and a version npm already
has. Starting it by hand (Actions → Publish → Run workflow) is a dry run:
everything happens except the upload.

It authenticates with npm **trusted publishing**, so no npm token is stored in
GitHub. That needs one setting on npmjs.com, made once: in the package's
settings, add a trusted publisher for GitHub Actions with owner `fleskovar`,
repository `light_plan_manager` and workflow filename `publish.yml`. The filename has to
match exactly; renaming the workflow breaks publishing until the setting is
changed too. Builds published this way carry
[provenance](https://docs.npmjs.com/generating-provenance-statements), which
npm shows on the package page.

To publish from a laptop instead, `make publish CONFIRM=yes` does the same
steps locally (after `npm login`); the flag is required so it cannot happen by a
mistyped target, and it is checked before anything runs. A bare `npm publish`
from the repository root is refused by `prepublishOnly`, because it would skip
the build and the contents check.

## Scope

Deliberately not included: a terminal board renderer, burndown charts, time
tracking, and any attempt to schedule work for you — `lpm team` reports load, it
does not level it, and neither does the web team view or the `team_load` tool.
The web app does not do multi-board sessions, authentication, real-time
collaboration, or conflict resolution beyond "pull again" — and profiles do not
change that: a profile routes work on the CLI and over MCP, `lpm ui` shows the
whole board, and nothing anywhere treats a scope as a permission. Flags follow
the same line: "the plan owner clears it" is a convention the docs and the agents
state, not a rule the engine enforces, because enforcing it would mean inventing
the permission model the rest of the tool deliberately does without. The template
registry is on the same side of that line: `{{name}}` is replaced with a value
and nothing else, because a registry with conditionals and loops in it is a
programming language somebody has to learn before they can read the plan. The published viewer
is read-only by construction and stays that way: an exported board is a file, and
a page that could write to it would need the server this whole feature exists to
avoid. `lpm remote` mirrors a tracker; it does not replace one, and it does not
grow a server: there are no webhooks and no daemon watching the remote, no
federation of two boards, and no attempt to own the remote's own workflow — the
board stays the source of truth, and where the remote's rules are stricter they
win and are reported rather than forced. `loadBoard()` already
returns all three trees, the dependency and coverage indexes, and period
membership, so anything missing is a small addition on top of the existing
engine rather than a change to it.
