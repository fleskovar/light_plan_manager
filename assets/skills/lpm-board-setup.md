---
name: lpm-board-setup
description: Create and configure a light-plan board, and set up the people and agents who will work it. Load this for `lpm init`, editing `.lpm/config.yml` (types, hierarchy, statuses, attributes, priority/effort), adding sprints or increments, building the team roster and pools, writing developer profiles for scoped routing, wiring the MCP server into an agent host with `lpm mcp setup`, or questions about the git strategy for `.lpm`.
roles:
  - pm
---

# Setting up a light-plan board

Load the `lpm` skill first for the tool map and the hard rules.

## Creating the board

```bash
lpm init                              # scrum template, prefix from the folder name
lpm init --template kanban --prefix ACME
lpm init --template blank             # types you define yourself
lpm init --template ./our-config.yml  # your own config as the starting point
lpm init --no-git                     # skip the nested git repo
```

Three built-ins ship: **scrum** (program > epic > feature > story/bug/test/review/
research > sub-task, with sprints and increments and a roster), **kanban**
(flatter), **blank** (minimal). `lpm init` validates the config before writing
anything.

**`.lpm` becomes its own git repository** nested inside the project and added to
the surrounding repo's `.gitignore` — deliberately not a submodule. The board has
its own history and can have its own remote, so plan changes and code changes stay
separate:

```bash
cd .lpm && git remote add origin git@github.com:acme/plan.git && git push -u origin main
```

Commit the board like anything else. Conflicts are ordinary markdown conflicts.

## `.lpm/config.yml`

This one file is the board's whole vocabulary. `lpm check` validates it and the
board against it.

```yaml
version: 1
key_prefix: LP                 # issue ids: LP-1, LP-2, …

statuses:                      # in board order
  - id: backlog
    label: Backlog
  - id: in_progress
    label: In Progress
    active: true               # `task start` moves here; `task current` lists these
  - id: done
    label: Done
    terminal: true             # `task done` moves here, and a parent moves here
                               # when everything inside it has: a container's
                               # status is derived from its contents

default_status: backlog

priority_attribute: priority       # must be an enum, most important value first
effort_attribute: story_points     # must be an int or a float

hierarchy:                     # folder depth IS this list
  - program
  - epic
  - feature
  - [user_story, bug, test, research]   # same line = same level
  - sub_task

issue_types:
  user_story:
    label: User Story
    attributes:
      priority:
        type: enum
        values: [critical, high, medium, low]
      story_points:
        type: int
    body: |
      ## Context

      ## Acceptance Criteria

      - [ ]
```

### The rules that bite

- **`hierarchy` is the only parenting truth.** A type's index in the list *is*
  the folder depth it must sit at. Creating a `user_story` under an `epic` is
  rejected. Types on the same line share a level.
- **Every declared type must appear in the hierarchy, and vice versa.** A type
  declared but not placed is a config error.
- **Type names are unique across all three namespaces**, because `lpm new <type>`
  resolves the collection from the type name alone.
- **Prefixes must differ** (`key_prefix`, `period_prefix`, `resource_prefix`) so
  ids never collide.
- **`priority_attribute` and `effort_attribute` are the only user-defined
  attributes the engine reads.** Both optional; both validated at parse time.
  Priority ranks `task next`; effort feeds `lpm team` and `split --split-effort`.
- **A type's `body` is its template.** Creating a document without a body
  pre-populates it — this is how you make every story on the board read alike.
- Attribute types: `string`, `text`, `int`, `float`, `bool`, `date`, `enum`,
  `array`. Any may add `required: true` and `default:`. An `enum` needs `values`.
- **Reserved field names cannot be attributes** (`id`, `type`, `title`, `status`,
  `assignee`, `period`, `flag`, `depends_on`, `relates_to`, `related_files`,
  `created`, `updated`, `author`, and the period/resource
  equivalents). The config refuses the shadow. In particular you do not need an
  attribute for "which files is this about" (`related_files`) or for "is this
  stuck" (`flag`) — both are built in.

After any config edit:

```bash
lpm check          # and `--fix` for anything it marks fixable
```

## Context templates: what a developer is told

`lpm instructions <id>` / `get_instructions { id }` prints the **working brief**
for an issue — the titles and bodies of its whole ancestry, then the issue, its
breakdown, its blockers, the research it rests on and its work log. It is the
call a developer or an agent makes before writing any code, so the layout is a
board-level decision, like the statuses.

Layouts live in `.lpm/templates/context/<issue type>.md`, with `default.md`
behind them and a built-in layout behind that. `lpm init` writes starters for the
types the chosen config declares; on an existing board:

```bash
lpm instructions --init          # write the starters (never overwrites)
lpm instructions --init --force  # replace them with the shipped ones
lpm instructions --list          # which layout each type resolves to
lpm instructions LP-42           # see what a developer will actually be handed
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

Every issue type the board declares is available by name (`epic`, `feature`, …)
and resolves to the **nearest ancestor of that type**, so one template can say
"this story's epic". `heading(n)` re-levels a body so it nests under the heading
above it. `lpm instructions --help` lists every value and helper.

Four things to keep true when editing them:

- **The issue is `issue`, never `this`.** `this` inside a template is the engine,
  not the document — and writing it is refused.
- **Guard anything optional.** `.length` for lists (an empty array is truthy in
  JavaScript), the bare name for a document that may be absent. A board where
  some stories have no epic still has to produce a brief.
- **Templates are not board truth.** They live under `.lpm/templates`, `lpm check`
  does not know they exist, and no template can make a board invalid. A broken
  one is a rendering error on one command, not a broken board.
- **They are, however, code.** See below.

### Context templates are executable — say so when you set a board up

Eta compiles a template into a JavaScript function and runs it. A `.lpm` folder
arrives over `git pull` from whoever wrote it, so **rendering somebody else's
board can run somebody else's JavaScript, as the person at the keyboard.**

light-plan reads every template before compiling it and refuses the known
escapes — `process`, `require`, `this`, `import()`, a property reached by a
computed key, Eta's file-reading `include`. Run the check over a whole board:

```bash
lpm instructions --audit    # exits 1 on a finding, so it belongs in CI
```

When you set up a board, or bring in one you did not write, tell the humans:
this refuses the known escapes, it **cannot make an untrusted template safe**,
and a `.lpm/templates/context/` from a stranger deserves the same reading as a
`postinstall` script. `--unsafe` overrides the refusal and is for a template you
wrote and meant; the MCP tool has no equivalent, so an agent can never opt out.

## The timeline (optional)

Periods answer "when". The namespace is all-or-nothing — declare
`period_prefix`, `period_types` and `period_hierarchy`, or none of them and
`timeline/` never exists.

```yaml
period_prefix: TL
period_hierarchy: [increment, sprint]
period_types:
  increment: { label: Product Increment }
  sprint:    { label: Sprint }
```

```bash
lpm new increment -t "PI-1" --starts 2026-08-03 --ends 2026-10-24
lpm new sprint -t "Sprint 12" -p TL-1 --starts 2026-08-17 --ends 2026-08-28
lpm move LP-42 --period TL-8
lpm move LP-42 --period none
```

Dates are `YYYY-MM-DD` and both are required on a period. Nothing in light-plan
ever works a date out for you: it learns dates only from period documents, and it
never levels or schedules on your behalf. A period containing today is "now", and
when periods nest only the innermost running one counts.

## The roster (optional)

Same all-or-nothing rule. Two kinds of resource, and the distinction is
load-bearing:

```yaml
resource_prefix: RS
resource_hierarchy: [person, role]
resource_types:
  person: { label: Person }
  role:   { label: Role, generic: true }    # a pool, not a human
```

`generic: true` belongs to the **type**, never to a document, and only resource
types may set it.

```bash
lpm new person -t "Alice Smith" --set email=alice@example.com
lpm new role -t "Web developer" --capacity 3      # a pool of three
lpm link RS-1 --covers RS-4                       # Alice can take web-pool work
lpm team                                          # who is carrying what
```

- **A named person** is one human's queue.
- **A generic pool** is a role. Work parked there is offered to everyone covering
  it, and the first to ask gets it.
- **Coverage is one hop and does not chain.** A pool covering a pool buys nothing.
- **A pool nobody covers is a dead end** — `lpm team` flags it, and work in it can
  never be picked up.

Capacity is full-time equivalents: `1` a person, `0.5` part-time, `3` a pool of
three. `lpm team` reports demand against it and **never levels it** — the
judgement stays yours.

## Setting up a developer

```bash
lpm me "Alice Smith"       # per checkout, stored in .lpm/local.json (git-ignored)
LPM_USER=RS-2 lpm task next   # override for one command
```

For a distributed team, give each developer a **profile** — one YAML file naming
who they are and which part of the board they are offered:

```yaml
# profiles/alice.yml
user: Alice Smith
scope:
  under:   [LP-2]         # only work at or below these documents
  exclude: [LP-9]         # never these, nor anything below them
  types:   [user_story, bug]
  periods: [TL-8]         # or a period below one of these
```

```bash
lpm profile --init ./profiles/alice.yml --user "Alice Smith"   # write a starter
lpm profile ./profiles/alice.yml                               # adopt one
lpm profile                                                    # what is in force
lpm profile --clear
LPM_PROFILE=./profiles/bob.yml lpm task next                   # one shell
```

Every scope key narrows; combining them is an AND; `exclude` beats `under`; a
period folds its child periods in. Unknown keys are an error, and a stale `under`
offers nothing rather than silently widening.

**Scope decides what is offered, never what is reachable.** It filters `task
next`, bare `task start`, `next_tasks` and `list_documents` — not `get_document`,
`lpm open`, `lpm set` or work already in flight. It is routing, not access
control. Full reference: `docs/profiles.md`.

## Setting up an agent

```bash
lpm mcp setup                                        # -> <board>/.mcp.json
lpm mcp setup --user "Planner Bot"
lpm mcp setup --profile ./profiles/frontend-agent.yml --name frontend
lpm mcp setup --file ~/.cursor/mcp.json              # merge into an existing config
lpm mcp setup --read-only --name light-plan-ro
lpm mcp setup --print                                # just show it
```

`--file` merges in place, matching the key the file already uses (`servers` for
VS Code, `mcpServers` for everyone else) and leaving the rest untouched. Without
it a new file is written and an existing one is never clobbered without `--force`.
Add one entry per agent with `--name`.

`--user` and `--profile` are **per session and never written to
`.lpm/local.json`**, so a dozen agents can share one checkout without overwriting
each other's identity or scope. `--read-only` registers only the tools that do
not write.

A profile can carry the identity too, so one file per agent is the whole setup:

```yaml
user: Frontend Bot
scope:
  under: [LP-2]
  types: [user_story, bug]
```

The MCP SDK is an *optional* dependency — installed by default, but if the
project was installed with `--no-optional`, `lpm mcp` says what to install.

## End-to-end: a new board for a team of four

```bash
lpm init --template scrum --prefix ACME

# people and a pool
lpm new person -t "Alice Smith"
lpm new person -t "Bob Jones"
lpm new role -t "Web developer" --capacity 2
lpm link RS-1 --covers RS-3
lpm link RS-2 --covers RS-3

# the calendar
lpm new increment -t "PI-1" --starts 2026-08-03 --ends 2026-10-24
lpm new sprint -t "Sprint 1" -p TL-1 --starts 2026-08-03 --ends 2026-08-14

# check it holds together before anyone plans against it
lpm check
lpm team

# route each developer, and each agent
lpm profile --init ./profiles/alice.yml --user "Alice Smith"
lpm mcp setup --name planner --user "Planner Bot" --file .mcp.json

# commit the board's own repo
cd .lpm && git add -A && git commit -m "Board scaffold: roster, PI-1, Sprint 1"
```

Then load `lpm-planning` to populate it.
