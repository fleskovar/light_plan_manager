# Profiles — giving one developer one part of the board

A **profile** is a small YAML file you hand to one developer, or to one agent.
It says two things: **who they are**, and **which part of the board they should
be offered**. The CLI and the MCP server both pick it up, so a team of ten can
share one board and each be handed only their own work.

This document is the complete reference. The short version is in the
[README](../README.md#profiles-giving-one-developer-one-part-of-the-board).

- [The one rule](#the-one-rule)
- [Quick start](#quick-start)
- [File syntax](#file-syntax)
- [How light-plan finds the file](#how-light-plan-finds-the-file)
- [Who you are](#who-you-are)
- [What a scope changes, and what it does not](#what-a-scope-changes-and-what-it-does-not)
- [Setting up a team](#setting-up-a-team)
- [Setting up agents](#setting-up-agents)
- [When something is wrong](#when-something-is-wrong)
- [Reference](#reference)
- [Worked examples](#worked-examples)

---

## The one rule

> **Scope decides what the board *offers* you. It never decides what is
> *reachable*.**

Everything else follows from that sentence, so it is worth reading twice.

A scope filters the surfaces that *hand you work*: `lpm task next`, `lpm task
start` with no id, and the MCP tools `next_tasks` and `list_documents`. It does
not filter the surfaces where you *name a document yourself*: `lpm open`,
`lpm set`, `lpm move`, `get_document`, `lpm task start LP-42`.

That is deliberate. An issue you are scoped out of can still be a blocker of an
issue you are scoped into, and a developer — or an agent — who is told "LP-12 is
blocked by LP-9" and then cannot open LP-9 is worse off than one who is simply
never *offered* LP-9's work.

It also means this is **routing, not access control**. A board is a folder of
markdown inside a checkout; anyone holding a profile can read every file in it
with `cat`. A profile decides what gets handed to them. Use it to keep ten
people out of each other's epics, or to give five agents five slices of one
plan. **Do not use it to keep a secret.** There is no permission model here, and
none is planned — see [Scope](../README.md#scope).

---

## Quick start

```bash
# 1. Write a starter profile and start using it, in one command.
lpm profile --init ~/.lpm/alice.yml --user "Alice Smith"

# 2. Edit it — everything is commented out by default.
$EDITOR ~/.lpm/alice.yml

# 3. See what it means on this board.
lpm profile

# 4. Work as normal. What is filtered is printed with the work.
lpm task next
```

```
$ lpm profile
Profile  /home/alice/.lpm/alice.yml
  .lpm/local.json
  user     Alice Smith
  scope    under LP-2 · not LP-9
  offers   14 issues of 63

$ lpm task next
Next up for RS-1 Alice Smith
  scope under LP-2 · not LP-9
  LP-12   Guest checkout           User Story · ready     TL-2

Claim the first with lpm task start
```

If you were handed a file rather than writing one:

```bash
lpm profile ./profiles/alice.yml     # or: lpm profile --file ./profiles/alice.yml
```

`lpm user` is an alias for `lpm profile`, so `lpm user --file <path>` works too.

---

## File syntax

A profile is YAML. Because YAML is a superset of JSON, a `.json` file works
just as well. Everything in it is optional — an empty file is a valid profile
that claims nothing.

```yaml
# alice.yml
user: Alice Smith

scope:
  under:   [LP-2, LP-7]
  exclude: [LP-9]
  types:   [user_story, bug]
  periods: [TL-2]
```

### Top-level keys

| Key | Type | Meaning |
| --- | --- | --- |
| `user` | string | The roster entry to act as — a resource id (`RS-1`) or a name (`Alice Smith`). Resolved the same way `lpm me` resolves it, so a unique prefix works. |
| `scope` | mapping | What this developer is offered. Omit it, or leave it empty, to be offered the whole board. |

### Scope keys

All four take a list of names. All four **narrow** — adding one can only ever
reduce what you are offered, never widen it.

| Key | Names | Matches an issue when… |
| --- | --- | --- |
| `under` | issue ids | it *is* one of them, or is nested anywhere below one. |
| `exclude` | issue ids | it is **not** one of them and not nested below one. Wins over `under`. |
| `types` | issue type names | its type is in the list. |
| `periods` | period ids | it is scheduled in one of them, or in a period nested below one. |

Notes that matter in practice:

- **`under` is at-or-below.** `under: [LP-2]` includes LP-2 itself, its
  features, and their stories.
- **`exclude` beats `under`.** `under: [LP-1]` with `exclude: [LP-3]` reads as
  "this whole programme, except that feature and everything under it".
- **`periods` folds child periods in.** Naming an increment includes every
  sprint inside it — otherwise scoping someone to a quarter would exclude all
  the work actually scheduled in its sprints.
- **`types` uses the board's own type names** (`user_story`, `bug`, …), the ones
  `lpm check` and `board_overview` speak. They come from your
  `.lpm/config.yml`, so they differ per board.
- **Combining keys is an AND.** `under: [LP-2]` with `types: [bug]` offers bugs
  under LP-2 and nothing else.

### Shorthand and empty values

A single name may be written without brackets, and a key left empty means the
same as not writing it at all:

```yaml
scope:
  under: LP-2      # same as [LP-2]
  types:           # empty — no opinion, same as omitting the line
```

That last rule is why the starter file — which ships with every scope line
commented out — means "the whole board" rather than "nothing".

### Unknown keys are an error

```yaml
scope:
  excludes: [LP-9]   # error: unknown key
```

```
$ lpm profile ./alice.yml
error /home/alice/alice.yml is not a valid profile
       scope: Unrecognized key: "excludes"
```

This is the one place light-plan is *stricter* than it is elsewhere. A board
config can afford to shrug at a key it does not recognise; a profile cannot,
because the failure is silent and one-directional — a misspelled `excludes:`
would hand someone the whole board and nothing would ever say so.

---

## How light-plan finds the file

Three sources, most specific first. The first one that answers wins.

| # | Source | Scope of the answer | Set with |
| --- | --- | --- | --- |
| 1 | `--profile <path>` | one MCP session | `lpm mcp --profile <path>` |
| 2 | `LPM_PROFILE` | one shell or one command | `LPM_PROFILE=./bob.yml lpm task next` |
| 3 | `.lpm/local.json` | this checkout | `lpm profile <path>` |

Only the **path** is ever recorded, never the contents. It goes in
`.lpm/local.json` beside the current user, which `lpm init` adds to
`.lpm/.gitignore` — the board is shared, but which profile you run under is not
a property of the board.

`--profile` applies to the MCP server only; the CLI uses sources 2 and 3.

### Path resolution

- A leading `~/` expands to your home directory.
- A relative path resolves against the **board root** (the folder containing
  `.lpm`), not the current working directory — so `lpm` gives the same answer
  from anywhere in the checkout.
- The path is stored **as you typed it**. `lpm profile ./profiles/alice.yml`
  records `./profiles/alice.yml`, which keeps working if the checkout moves;
  `lpm profile ~/.lpm/alice.yml` records the `~` form for the same reason.
- `lpm mcp setup --profile` is the exception: it writes an **absolute** path
  into the host's JSON config, because the agent host launches the server from
  its own working directory.

---

## Who you are

A profile's `user:` is one of three ways light-plan learns your identity. Most
specific first:

| # | Source | Applies to |
| --- | --- | --- |
| 1 | `LPM_USER` | one command |
| 2 | the profile's `user:` | wherever the profile applies |
| 3 | `.lpm/local.json`, set by `lpm me` | this checkout |

`lpm me` tells you which one is talking:

```
$ lpm me
RS-1  Alice Smith  1 FTE
  in flight LP-12
  from your profile · under LP-2 · not LP-9
  see lpm profile
```

Two consequences worth knowing:

- A profile with a `user:` means the developer never has to run `lpm me`. One
  file is the whole setup.
- A profile **without** a `user:` leaves whatever `lpm me` set alone. That is
  the right shape for a scope you want to apply to several people — a
  `frontend.yml` that says "under LP-2" and nothing about identity.

If the profile names someone who is not on the roster, light-plan says so and
points at the profile rather than at `lpm me`:

```
error Current user "Alice Smth" is not in the roster
       It came from your profile; fix its `user:` or run `lpm profile --clear`.
```

---

## What a scope changes, and what it does not

| Surface | Scoped? | Why |
| --- | --- | --- |
| `lpm task next` | **yes** | it offers you work |
| `lpm task start` (no id) | **yes** | it claims the top offer |
| `lpm task start <id>` | no | you named it |
| `lpm task current` | no | work already picked up stays yours |
| `lpm task prev` | no | your own history |
| `lpm flag` / `lpm flag clear` | no | you named the issue |
| `lpm flag list` | no | a flag is addressed to whoever runs the plan |
| `lpm open` / `set` / `move` / `link` / `rm` | no | you named the document |
| `lpm team` | no | a report about the roster, not routing |
| `lpm check` | no | validity is a property of the board, not of a reader |
| `lpm ui` | no | the web editor shows the whole board |
| `lpm export` | no | a published board is the board |
| MCP `next_tasks` | **yes** | it offers work |
| MCP `list_documents` | **yes** (issues) | it is the browse surface |
| MCP `get_document` | no | the agent named it |
| MCP `flag_issue` / `clear_flag` | no | the agent named it |
| MCP `flagged_issues` | no | a flag is addressed to whoever runs the plan |
| MCP `board_overview` | reports the scope | so an agent knows it is being filtered |

`current_tasks` is not scoped for a reason that comes up in practice: if you
re-scope someone mid-sprint, the work they have already started must not vanish
from their own in-flight list.

`flagged_issues` and `lpm flag list` are unscoped for a stronger reason. A flag
is a request from somebody who has stopped working, addressed to whoever is
running the plan — and the person running the plan is exactly the sort of reader
who might have a narrow profile. Filtering one out because it sat outside their
slice would hide the one thing on the board that is asking to be seen.

`list_documents` filters issues only — periods and resources are the board's
calendar and roster, which everyone needs to read to schedule and assign.

### Nothing is hidden silently

Every filtering surface says what it filtered by, so a short list is never a
mystery:

- `lpm task next` prints a `scope …` line under its header.
- `lpm profile` prints the resolved scope plus `offers N issues of M`.
- `board_overview` returns `scope` (a readable summary) and `scopeWarnings`.
- `list_documents` returns `outOfScope: N` alongside `total`.

---

## Setting up a team

Two shapes work well. Pick one; mixing them is fine but harder to explain to
new joiners.

### Profiles committed with the code

Keep them in the repository so scopes are reviewable and change with the plan.

```
your-project/
  profiles/
    alice.yml
    bob.yml
    frontend.yml
  .lpm/
```

```bash
# once, per developer, in their checkout
lpm profile ./profiles/alice.yml
```

The relative path is what gets recorded, so it keeps working across machines
and after the checkout moves. Reviewing a change to someone's scope becomes an
ordinary pull request.

### Profiles in the developer's home directory

Better when scopes are personal, or when one person works several boards.

```bash
lpm profile --init ~/.lpm/alice.yml --user "Alice Smith"
```

For a shell that always serves the same person, skip the per-checkout step
entirely:

```bash
# ~/.bashrc
export LPM_PROFILE=~/.lpm/alice.yml
```

### Onboarding checklist

1. `lpm new person -t "Alice Smith"` — they must be on the roster before a
   profile can name them.
2. Write their profile, or have them run `lpm profile --init`.
3. They run `lpm profile <path>` once in each checkout (or set `LPM_PROFILE`).
4. `lpm profile` to confirm — check the `offers N issues of M` line looks right.
5. `lpm task next`.

### Changing a scope later

Edit the file. Nothing is cached: the CLI re-reads it on every command, so the
next `lpm task next` reflects the change. A long-running MCP session reads its
profile once at startup, so restart the agent host to pick up an edit.

---

## Setting up agents

`lpm mcp --profile <file>` is the per-session form of everything above, and
`lpm mcp setup` writes it into the host config for you:

```bash
lpm mcp setup --name frontend \
  --profile ./profiles/frontend-agent.yml \
  --file .mcp.json
```

```jsonc
{
  "mcpServers": {
    "frontend": {
      "command": "lpm",
      "args": ["mcp", "--profile", "/abs/path/to/profiles/frontend-agent.yml"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Because a profile carries the identity too, one file per agent is the whole
setup — no `--user` needed:

```yaml
# profiles/frontend-agent.yml
user: Frontend Bot
scope:
  under: [LP-2]
  types: [user_story, bug]
```

Add a second, differently-named entry per agent with `--name`. Several agents
can share one checkout: `--user` and `--profile` both live in memory for the
session and are never written to `.lpm/local.json`, so none of them can
overwrite another's answer to "who am I" or "what is mine".

With no `--profile`, an MCP session falls back to the checkout's own profile —
so an agent launched inside a developer's working copy is offered what that
developer is.

### What the agent sees

`board_overview` — which the tools tell the agent to call first — reports the
scope in force and anything wrong with the file:

```json
{
  "board": "Platform",
  "currentUser": "RS-3",
  "scope": "under LP-2 · user_story/bug",
  "scopeWarnings": [],
  "counts": { "issues": 63, "periods": 8, "resources": 5 }
}
```

`list_documents` says how much it left out, so the agent is told it is not
seeing everything rather than left to infer a small board:

```json
{ "total": 14, "outOfScope": 49, "documents": [ … ] }
```

Scoping an agent is a good way to keep a planning agent out of a working
agent's epic, or to stop a bulk-editing agent from wandering. It is not a
sandbox: the agent can still `get_document` anything by id, and can still read
the `.lpm` folder through any file tool it has.

---

## When something is wrong

### A name the board does not have

```
$ lpm task next
Next up for RS-1 Alice Smith
  scope under nothing
  warn this board has nothing named LP-404
  nothing ready
```

Unresolvable names are reported and dropped. Everything else in the profile
still applies — but note the important half of this: **a declared list that
resolves to nothing matches nothing.** A stale `under` offers you no work, and
says why. It does *not* quietly widen to the whole board, because that is the
one failure nobody would ever notice.

`lpm profile` shows the same warning with the reason spelled out.

### The file does not parse

```
$ lpm profile
Profile  /home/alice/.lpm/alice.yml
  .lpm/local.json

warn it does not load, so the whole board is in scope
       scope: Unrecognized key: "excludes"
```

light-plan reports it and carries on **unscoped** rather than refusing to run —
a developer whose every command fails because a file they were handed has a typo
in it is helped by nobody. `lpm profile` exits 1 in this state so a script can
catch it. Over MCP, the message appears in `scopeWarnings`.

`lpm profile <file>` validates up front, so a typo is normally caught when the
profile is adopted rather than later:

```
$ lpm profile ./broken.yml
error /path/to/broken.yml is not a valid profile
       scope: Unrecognized key: "excludes"
```

### "It is not filtering anything"

Check in this order:

1. `lpm profile` — is a profile in force at all, and is it the one you think?
   The second line says where the path came from.
2. Does the `scope` line show what you expect, or `the whole board`?
3. Is `LPM_PROFILE` set in this shell, pointing somewhere else?
4. Are you looking at a surface that is scoped? `lpm task current` and
   `lpm open` are not — see [the table above](#what-a-scope-changes-and-what-it-does-not).

### Turning it off

```bash
lpm profile --clear      # stop using one; your `lpm me` identity is kept
unset LPM_PROFILE        # if a shell was overriding it
```

---

## Reference

### Commands

| Command | What it does |
| --- | --- |
| `lpm profile` | Show the profile in force, resolved against this board |
| `lpm profile <file>` | Use this file from now on |
| `lpm profile --file <file>` | The same, spelled out |
| `lpm profile --init <file>` | Write a starter profile there, and use it |
| `lpm profile --init <file> --user <ref>` | …with `user:` filled in |
| `lpm profile --init <file> --force` | Overwrite an existing file |
| `lpm profile --clear` | Stop using a profile |
| `lpm mcp --profile <file>` | Use it for one agent session |
| `lpm mcp setup --profile <file>` | Write that into a host's JSON config |

`lpm user` is an alias for `lpm profile`.

### Environment variables

| Variable | Effect |
| --- | --- |
| `LPM_PROFILE` | Path to the profile to use; beats `.lpm/local.json` |
| `LPM_USER` | Identity for one command; beats a profile's `user:` |
| `LPM_BOARD_PATH` | The `.lpm` folder to work on, whatever the working directory is |

The three go together for an agent that is handed one slice of a board and
started in a directory nobody chose:

```bash
LPM_BOARD_PATH=~/work/payments/.lpm LPM_PROFILE=~/profiles/agent-3.yml lpm task next
```

### Files

| File | Contents | Committed? |
| --- | --- | --- |
| the profile itself | `user:` and `scope:` | your choice — see [Setting up a team](#setting-up-a-team) |
| `.lpm/local.json` | the current user and the **path** to the profile | no, git-ignored by `lpm init` |

### Using it from the library

```ts
import { loadBoard, findBoardPaths, currentScope, nextTasks } from 'light-plan';

const board = loadBoard(findBoardPaths()!);
const scope = currentScope(board);            // resolved, or "the whole board"

nextTasks(board, 'RS-1', { scope });          // offers, filtered
scopedIssues(board, scope);                   // the issues a scope leaves
describeScope(scope);                         // "under LP-2 · not LP-9"
scope.unknown;                                // names this board has nothing for
```

`resolveScope(board, profileScope)` turns a parsed `scope:` block into a
`ResolvedScope`, and `inScope(scope, issue)` asks about one issue. Reading a
profile file directly is `parseProfileText` / `loadProfileFile`; finding the one
in force is `currentProfile(paths)`.

---

## Worked examples

### One epic, nothing else

```yaml
user: Alice Smith
scope:
  under: [LP-2]
```

### A programme, minus one feature another team owns

```yaml
user: Bob Jones
scope:
  under:   [LP-1]
  exclude: [LP-17]
```

### Only bugs, only this sprint

```yaml
user: Carol Diaz
scope:
  types:   [bug]
  periods: [TL-4]
```

### A shared scope with no identity

Several people can use this one; each keeps whatever `lpm me` set.

```yaml
# profiles/frontend.yml
scope:
  under: [LP-2, LP-7]
```

### An agent that only writes stories under one epic

```yaml
# profiles/story-writer.yml
user: Story Bot
scope:
  under: [LP-2]
  types: [user_story]
```

### A whole increment, its sprints included

```yaml
user: Dan Ellis
scope:
  periods: [TL-1]   # the increment; every sprint inside it counts
```
