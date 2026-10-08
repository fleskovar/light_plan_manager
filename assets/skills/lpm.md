---
name: lpm
description: How to drive a light-plan board — the `lpm` CLI and the light-plan MCP server. Load this whenever a task involves a `.lpm` folder, the `lpm` command, a light-plan board, or the light-plan MCP tools (board_overview, next_tasks, create_document, …); when asked to read, populate, work or fix a board; or when a repository turns out to contain a `.lpm` directory and you need to know what it is. Start here, then load lpm-board-setup, lpm-planning, lpm-delivery or lpm-board-health for the specific job.
roles:
  - developer
  - pm
---

# Working a light-plan board

**light-plan** is a file-based issue tracker. A board is a `.lpm/` folder of
nested directories, each holding one markdown document (YAML frontmatter + a
body). It is versioned with git, has no server and no database, and is driven
three ways that all produce the same board: the `lpm` CLI, an MCP server for
agents, and a web app (`lpm ui`).

This skill is the orientation and the map. Five companions cover the jobs:

| Skill | Load it when |
| --- | --- |
| `lpm-board-setup` | creating a board, editing `.lpm/config.yml`, adding people, wiring up developers or agents |
| `lpm-planning` | writing epics/features/stories, breaking work down, sequencing, assigning, scheduling |
| `lpm-templates` | the reusable pieces of plan in `.lpm/registry/` — **check these before creating anything** |
| `lpm-delivery` | picking work up, recording progress, closing issues |
| `lpm-board-health` | `lpm check`, repairing a board, "why is nobody offered work", publishing |

## The first rule: the board defines its own vocabulary

There is no universal "epic", "story", "sprint" or "done". Every board declares
its own types, its own hierarchy and its own statuses in `.lpm/config.yml`.

**Find out before you act.**

```bash
lpm check          # validates, and fails loudly if you are not on a board
cat .lpm/config.yml
```

Over MCP, one call answers everything:

```
board_overview
```

It returns the types and the hierarchy they nest in, the statuses (marking which
are `active` and which `terminal`), the `priorityAttribute` and `effortAttribute`
the engine ranks by, who you are, the scope you are being offered, and how much
of each collection the board holds. **Every other tool speaks in those names.**
Never guess one.

## Three collections, one engine

| Folder | Holds | Answers |
| --- | --- | --- |
| `.lpm/board/` | **issues** | what gets built |
| `.lpm/timeline/` | **periods** — sprints, increments | when it gets built |
| `.lpm/team/` | **resources** — people and pools | who builds it |

They are structurally identical: nested folders, one markdown document each, one
id namespace apiece (`LP-1`, `TL-1`, `RS-1`). Periods and resources are optional —
a board that declares no period types simply has no `timeline/`.

**A folder is named after its id and nothing else** — `board/LP-1/LP-2/_issue.md`.
The titles are in `.lpm/INDEX.md`, a generated outline of the whole board with a
link to every document, nested the way the folders are. Read it to get your
bearings on an unfamiliar board; never edit it, since every command that adds,
removes, moves or renames a document rewrites it.

An issue at **any** level can be scheduled into any period and assigned to any
resource. An epic can sit on an increment while its stories sit on sprints.

## How work reaches a person

This is the mechanic everything else serves. `lpm task next` / `next_tasks`
offers an issue only when **all** of these hold:

1. it is a **work unit** — an issue with no children, or one whose type the board
   declares `atomic`, which is offered whole and hides what is nested in it.
   Containers are never offered; the units under them carry the work;
2. its status is neither terminal nor already active;
3. it is assigned to that person, **or** parked in a generic pool they cover;
4. everything it waits on is finished — **`depends_on`, its own and every
   ancestor's**. A story sits inside a feature, and a feature that waits on
   another feature waits on it with everything in it, so no story under the
   second feature is offered until the first one's work is done.

A dependency on a **container** is cleared by the work inside it, not by the
container's own status — nobody moves a feature through the columns, so waiting
for one to say `done` would idle the team for ever. Closing it outright still
answers for everything under it.

And the container's status follows: finishing the last open issue in a feature
finishes the feature, and its epic with it, as far up as it goes. Reopening one,
or adding a new issue inside a finished container, reopens them. Never close a
parent by hand — `finish_task` reports what it carried in `rolledUp`, and
`lpm check --fix` repairs a board where a hand edit or a merge left one behind.

Ranking, in order: the running or overdue period first, then unscheduled work,
then periods that have not started; within that the board's priority attribute,
then the status closest to done, then the part of the plan already under way (a
feature somebody is inside, then one closest to finished — so a queue finishes a
feature rather than opening one in each), then how much each issue unblocks, then
age.

Four practical consequences: **assigning an epic assigns nothing**, **a
dependency is a gate that idles somebody**, **one edge between two features
sequences every story under them**, and **work in a pool nobody covers can
never be picked up**.

## The surface, side by side

Everything is available both ways. Use MCP tools when you have them — they are
one call and return structured JSON; fall back to the CLI in a shell.

### Reading

| Intent | MCP | CLI |
| --- | --- | --- |
| What kind of board is this | `board_overview` | `cat .lpm/config.yml` |
| Survey documents | `list_documents { kind, type, status, assignee, period, parent, under, workUnitsOnly, search, limit }` | `lpm team`, `lpm task next` |
| One document in full | `get_document { id }` | `lpm open <id> --path`, `lpm comment <id> --list` |
| **The brief for an issue** | `get_instructions { id }` | `lpm instructions <id>` |
| Validate | `check_board` | `lpm check` (exit 1 while errors remain) |
| Who is loaded | `team_load { period }` | `lpm team [--period <id>] [--open]` |

`get_document` is the one that answers "can I start this?" — it returns the body,
attributes, `ancestors`, `children`, `blockedBy` / `blocks` and the whole
comment log together.

`get_instructions` is the one that answers "what do I need to know to do it?" It
walks the hierarchy and returns **one piece of markdown**: the titles and bodies
of every ancestor (the epic and feature this issue belongs to, whatever the board
calls them), then the issue itself, its breakdown, **the files it names**, **where
the work comes from and where it is going**, the research it rests on and its work
log. `get_document` hands you a record; `get_instructions` hands you the reason it
exists. **Read it before writing any code.**

If the brief opens with a **flag**, somebody picked this up and stopped — read the
work log before anything else.

The layout comes from the board — `.lpm/templates/context/<type>.md`, falling back
to `default.md` and then to a built-in layout — so a team decides what its
developers are told. Do not pass `template` unless you were asked to use a
specific one.

Those layouts are **Eta templates, which means executable JavaScript**. Every one
is checked before it is compiled, and one that reaches for the host (`process`,
`require`, `this`, a computed property key) is refused. If `get_instructions`
comes back refusing a template, **do not work around it** — no `--unsafe` exists
for agents, and the right response is to report it: the board is carrying a
layout that can run code, which a human needs to look at. `lpm instructions
--audit` is the whole-board version of that check and exits 1 on a finding.

### Planning

| Intent | MCP | CLI |
| --- | --- | --- |
| Create | `create_document { type, title, parent, body, status, assignee, period, dependsOn, relatedFiles, starts, ends, capacity, attributes }` | `lpm new <type> -t "..." -p <parent> --set k=v --related <path>` |
| Edit content / placement | `update_document { id, title, body, status, assignee, period, relatedFiles, starts, ends, capacity, attributes }` | `lpm set <id> …` (content) and `lpm move <id> …` (placement) |
| Change what it is | `convert_document { id, type, under, buildParents, dryRun }` | `lpm convert <id> <type> [--under <id>] [--build-parents] [--dry-run]` |
| Break up | `split_issue { id, titles, count, mode, chain, splitEffort, dryRun }` | `lpm split <id> --titles "A,B,C" [--replace] [--no-chain] [--split-effort] [--dry-run]` |
| Insert into an edge | `insert_between { source, target, issue, type, title }` | `lpm insert --between LP-4..LP-7 -t "..."` |
| Duplicate | `copy_documents { ids, under }` | `lpm copy <id> --under <id>` |
| Delete | `delete_document { id, recursive, dryRun }` | `lpm rm <id> -r [--dry-run]` |
| Dependency | `link_issues { blocked, blockedBy, remove }` | `lpm link <id> --depends-on <ids>` |
| Non-blocking link | *(CLI only)* | `lpm link <id> --relates-to <ids>` |
| Coverage | *(CLI only)* | `lpm link RS-1 --covers RS-4` |

### Working

| Intent | MCP | CLI |
| --- | --- | --- |
| What should I do | `next_tasks { assignee, includeUnassigned, limit }` | `lpm task next [--unassigned] [--limit n]` |
| What do I hold | `current_tasks { assignee }` | `lpm task current` |
| Claim | `start_task { id, assignee, force }` | `lpm task start [<id>] [--force]` |
| **Get the brief for it** | `get_instructions { id }` | `lpm instructions [<id>]` |
| Finish | `finish_task { id, comment }` | `lpm task done [<id>]` |
| **Say the work stopped** | `flag_issue { id, reason, comment }` | `lpm flag [<id>] --reason blocked\|paused\|help --comment "..."` |
| Say it can resume | `clear_flag { id, comment }` | `lpm flag clear <id> --comment "..."` |
| What has stopped | `flagged_issues` | `lpm flag list` |
| Comment | `add_comment { id, body, author }` | `lpm comment <id> -m "..."` / `-f file` / `-f -` |
| Read the log | `list_comments { id }` | `lpm comment <id> --list` |
| Delete a comment | `remove_comment { id, index }` | `lpm comment <id> --remove <n>` |
| Identity | — | `lpm me [<id\|name>]`, `lpm profile` |
| Look at it | — | `lpm ui` |
| Publish it | — | `lpm export [--site docs] [--workflow]` |

`lpm <command> --help` documents the rest. `lpm --help` lists every command.

## Hard rules

- **Never hand-edit files under `.lpm/`** to make a change you could make with a
  tool. The tools validate the hierarchy, allocate ids, keep forward and derived
  links consistent, and write frontmatter in the order the engine expects.
  (Hand-editing is *supported* — see `lpm-board-health` — but it is a repair
  path, not a workflow.)
- **Never invent a type, status or attribute name.** Use what `board_overview`
  returned.
- **Ids are never reused.** Deleting `LP-7` does not free the number.
- **Only forward edges are stored.** `depends_on` and a resource's
  `covers` live in the file; "what does this block" and "who covers this pool"
  are derived at load. Never try to write an inverse.
- **`depends_on` is the only edge that gates the queue**; `relates_to` implies
  nothing. A cycle is refused, and `lpm check` also catches one that appears
  only after the edges are inherited.
- **`dryRun` first** on `split_issue`, `convert_document` and `delete_document`
  whenever children or dependencies are involved.
- **A cycle is refused**, by the tools and by `lpm check`.
- **Comments are not board state.** They live in a `_comments.md` beside the
  document, are read on demand, and are written straight through — even in the
  web app, which queues everything else.
- **Never start an issue without reading its brief.** `get_instructions` /
  `lpm instructions` is one call and it is the difference between building the
  requirement and building your guess at it.
- **A flag is not board state either**, and for the same reason as a comment: it
  says work stopped *now*. It is written straight through, never queued, and the
  web app writes it the moment you press the button.
- **When work stops, flag it.** An issue that is going nowhere and does not say so
  is a lie the board tells everyone who looks at it. Clearing a flag is the plan
  owner's call, not the implementer's — `clear_flag` says "carry on".
- **`related_files` is never resolved or checked.** An issue may name a file that
  does not exist yet; that is often the point. Treat an entry as a lead, and add
  the files you actually touched.

## Two edits that look alike and are not

`lpm set` / `update_document`'s content fields change **what a document holds**
(title, body, attributes, dates, capacity). `lpm move` / `update_document`'s
`status`, `assignee` and `period` change **where it sits**. `lpm convert` /
`convert_document` changes **what it is**, and may relocate it to the depth its
new type belongs at.

Reach for the one that matches the intent; the engine enforces the difference.

## The web app, in one paragraph

`lpm ui` serves a local editor: a dependency canvas, a drawer (table, periods,
Gantt, queue, team) and a side panel. **Editing there is queued, not immediate** —
every action updates a working copy and appends to a pending list, and nothing
touches `.lpm` until Push. A push is partial rather than atomic: what lands,
lands, and failures stay pending. `lpm export` publishes a read-only static
viewer, and it publishes the board **as committed** — queued changes never travel.

## Identity and scoping

Who you are decides what `lpm task next` offers. `lpm me <id|name>` stores it per
checkout in `.lpm/local.json` (git-ignored). `LPM_USER` overrides it for one
command. Over MCP it is `--user`, held per session and never written to disk, so a
swarm of agents can share one checkout.

A **profile** additionally narrows which part of the board you are offered — see
`lpm-board-setup` and `docs/profiles.md`. Scope decides what is *offered*, never
what is *reachable*: `get_document` reads any id. It is routing, not access
control.

## Orientation checklist

Run this before doing anything on an unfamiliar board:

1. `board_overview` (or read `.lpm/config.yml`) — types, hierarchy, statuses,
   ranking attributes, whether periods and resources exist at all.
2. `list_documents { workUnitsOnly: true, limit: 50 }` — the shape of what is there.
3. `lpm check` / `check_board` — is it currently valid?
4. `team_load` — who exists, and is anything uncovered or unowned?
5. `lpm me` — do you have an identity, and does work route to it?

Then, before doing any single issue: `get_instructions { id }`.
