---
name: lpm-central-store
description: Where a light-plan board keeps its documents, and how to operate the central store and the project index. Load this when `.lpm/config.yml` holds only the key `store:`, when a path in a message points into `.lpm_central`, when a task mentions the central store, `central_store`, `lpm set central_store`, `lpm config`, `lpm store` (show, move, list), `lpm projects`, `projects.json`, `lpm init --central` or `--local`, `lpm git join --central`, the "All projects" page of the web app, or an error such as "The board pointer ... holds no board" or "The central store is already ...".
roles:
  - developer
  - pm
---

# The central store and the project index

Load the `lpm` skill first for the tool map.

A light-plan board keeps its documents in one of two places:

| Store | Board folder | What the project folder holds |
| --- | --- | --- |
| `local` | `<project>/.lpm` | The whole board |
| `central` | `<central_store>/.lpm_central/<name>` | `.lpm/config.yml` with one key, `store`, whose value is the board folder |

The second file is the **pointer**. Every `lpm` command, the MCP server and
`lpm ui` follow it. Inside the project, a central board works exactly like a
local one: the same commands, the same MCP tools, the same ids. This skill is
for the cases where the place matters.

## Find out where the board is

```bash
lpm store
```

```
central  /home/ada/boards/.lpm_central/shop
project  /home/ada/work/shop
```

A local board prints `local  <project>/.lpm`. Run this before you read board
files directly:

- **`.lpm/config.yml` that holds only `store:` is a pointer, not the board
  config.** The types, statuses and attributes are in the `config.yml` of the
  central board folder. Use `board_overview` over MCP, or read the file in the
  folder that `lpm store` prints.
- **Paths in messages.** A message names a file of a central board relative to
  the parent of the board folder: `shop/board/LP-1/_issue.md`, not
  `.lpm/board/LP-1/_issue.md`. That path does not resolve from the project
  folder. Join it to the parent of the folder that `lpm store` prints.
- **`related_files`** on an issue are always relative to the project folder,
  whatever the store.

## Rules for an agent

- **Do not edit the pointer or `project.json` by hand.** `lpm store move` and
  `lpm set central_store --move` rewrite them. `lpm check --fix` repairs
  `project.json`.
- **Do not copy or move a board folder with file commands.** A board folder
  holds a git repository, `local.json` and `credentials.json`. `lpm store move`
  moves all of them, under the board lock, and checks the copy.
- **Do not change where boards live unless a person asked for it.** Setting,
  moving or abandoning the central store and moving a board change files that
  other projects and other people depend on. A planning or delivery task never
  needs it.
- **Answer every question with a flag.** An agent has no terminal, and
  `lpm init`, `lpm git join` and `lpm set central_store` ask only at a
  terminal. Without a flag, `lpm init` and `lpm git join` create a local board,
  and `lpm set central_store` refuses when another store exists. Pass the flag
  that the person asked for.

## The setting

The key `central_store` in `settings.json` of the user folder names the
central store. The user folder is `~/.light-plan`, or the folder that
`LPM_HOME` names. When the key is absent, every new board is local.

```bash
lpm config                                    # every user setting
lpm config get central_store                  # prints the path; exit 1 when it is not set
lpm set central_store                         # the current folder becomes the store
lpm set central_store --path ~/boards         # another folder
lpm config unset central_store                # no store: new boards are local
```

`lpm set central_store` is the same command as `lpm config set central_store`.
A missing folder is created.

### Changing the store when one exists

| Flag | Effect |
| --- | --- |
| *(none, no terminal)* | Refused, exit 1. The message names both flags. Nothing changes. |
| `--move` | Every board of the old `.lpm_central` moves to the new one, and the pointer of each project is rewritten. Then the key changes. |
| `--abandon` | Only the key changes. The old boards stay, and their projects still reach them through their pointers. |

A move stops at the first board that fails. That board and the key stay as
they were, and the boards that moved already work from the new store. Run the
same command again to move the rest. A folder in the old `.lpm_central` that
holds no board stays behind, and the command prints it.

## Creating a board

```bash
lpm init --central       # board in <central_store>/.lpm_central/<folder name>
lpm init --local         # board in .lpm, even when a central store is set
```

The board folder is named after the project folder. A taken name gets `-2`,
`-3` and so on (case not compared). `--central` without a central store fails
and names `lpm set central_store`. `lpm init` with a pointer or a board in the
project fails with "A board already exists".

To clone a board that a team shares through git into the central store:

```bash
lpm git join --central --url <repository>
```

Git sync runs every git command in the central board folder. The pointer and
`project.json` are never committed.

## Moving one board

```bash
lpm store move --to central
lpm store move --to local
```

The move copies the board, compares the copy, then switches, so a failure
leaves the board where it was. It keeps the git history, the remotes,
`local.json` and `credentials.json`.

**A running `lpm ui` or `lpm mcp` keeps the old paths.** That includes the MCP
server you may be talking to now. After a move, the MCP server must be
restarted, so tell the person to restart the host, or use the CLI for the rest
of the task. `lpm move` is another command: it moves an issue.

## Every board on this computer: the project index

Each `lpm` command that finds a board records its project in `projects.json`
of the user folder. `lpm projects` lists the index joined with every board of
the central store:

```bash
lpm projects                 # name, store, key prefix, last use, folder, state
lpm projects --json
lpm projects forget <path>   # remove one entry; deletes no file
lpm projects prune           # remove the entries in the state "missing"
lpm store list               # the central boards only
```

| State | Meaning |
| --- | --- |
| *(none)* / `ok` | The board is where the list says. |
| `project missing` | A central board whose project folder is gone, or points at another board. |
| `missing` | No board at the recorded place. `prune` removes it. |

`LPM_PROJECT_INDEX=off` stops the recording, for example in CI.

In the web app, File > "All projects…" shows the same list with Open and
Reveal. `lpm ui` in a folder without a board shows that page when a central
store is set.

## Errors and what to do

| Message | Cause | Fix |
| --- | --- | --- |
| `The board pointer in <project>/.lpm/config.yml names <dir>, which holds no board.` | The central board folder moved or was deleted. | Ask the person where the board is now. Find candidates with `lpm store list` or `lpm projects`. A person writes the new path in the key `store`. Do not create a new board in its place. |
| `... which holds another pointer.` | The key `store` names a project `.lpm` folder instead of a board folder. | Same as above: a person writes the board folder. |
| `lpm check` warns that `project.json` is missing, or names another project | The project folder moved, or two projects point at one board. | `lpm check --fix` writes the current project. When two projects point at one board, report it instead of fixing it: each fix rewrites the other. |
| `No central store is set. Name one with lpm config set central_store <dir>` | `--central` without the key. | Ask whether the board must be local (`--local`) or which folder is the store. |
| `The central store is already <dir>` | `lpm set central_store` without `--move` or `--abandon`. | Ask the person which one. Never choose `--move` on your own. |
| `Could not move the board <name>: ...` | One board failed during `--move`. | Report the message. The same command run again continues. |
| `Could not move <folder> aside` / `Nothing was moved` | A program holds a file of the board open (Windows). | Ask the person to close it, then run the move again. |
| `The board is already in the central store` / `... in its project` | The board is already where `--to` asks. | Nothing to do. |

## Reference

`docs/central-store.md` in the light-plan repository is the full guide, with
the decisions behind the design and the known issues.
