# The central store: boards outside their projects

A board can keep its documents in one folder on your computer instead of in its
project folder. That folder is the **central store**. This page is the user
guide (sections 1 to 7), the list of decisions that the first iterations rest
on (section 8) and the list of known issues (section 9). It also covers the
project index, which lists every board on the computer, local or central.

The code is in `src/core/storage/paths.ts` (finding a board through a pointer),
`src/core/storage/central.ts` (writing the pointer and `project.json`),
`src/core/operations/central-store.ts` (the setting, the folder names, the
list), `src/core/operations/relocate.ts` (moving a board and the whole store),
`src/core/storage/project-index.ts` and `src/core/operations/project-index.ts`
(the project index), `src/server/launcher.ts`, `src/server/routes/projects.ts`
and `src/server/hub.ts` (opening boards from the web app), and
`web/src/features/projects/` (the "All projects" page).

---

## 1. Quick start

```bash
cd ~/boards && lpm set central_store      # once per computer: this folder is the store

cd ~/work/shop
lpm init --central                        # the board goes to ~/boards/.lpm_central/shop
lpm task next                             # every command follows the pointer

cd ~/work/blog
lpm store move --to central               # an existing local board moves there too

cd ~
lpm ui                                    # no board here: the page lists both boards
```

## 2. The setting

| Item | Value |
| --- | --- |
| File | `settings.json` in the user folder: `~/.light-plan`, or the folder that `LPM_HOME` names |
| Key | `central_store` |
| Value | The absolute path of a folder. `lpm config set` expands `~`, resolves a relative path from the current folder, and creates a missing folder. A path to a file is refused. |
| Default | Absent. Without the key, there is no central store, and every board is local. |
| Written by | `lpm set central_store` (or `lpm config set central_store`): the current folder, or `--path <dir>`. `lpm config unset central_store` removes it. |
| Read by | `lpm init`, `lpm git join`, `lpm store`, `lpm ui` and the hub server. A command inside a project does not read it: the pointer holds the full path. |

`lpm config` with no arguments lists every user setting. `lpm config get
central_store` prints only the value, and exits 1 when the key is absent.

### Changing the central store

When another folder is already the central store, `lpm set central_store`
warns and asks what to do with its boards:

| Answer | Flag | What happens |
| --- | --- | --- |
| Cancel (default) | — | Nothing changes. |
| Move the store | `--move` | Each board of the old `.lpm_central` moves to the new one, under its board lock, with the copy-compare-switch steps of `lpm store move`. The pointer of each project is rewritten. The old `.lpm_central` is removed when it is empty. Then the key changes. |
| Abandon the old store | `--abandon` | Only the key changes. The old boards stay where they are. Their projects still reach them, because each pointer holds the full path, and `lpm projects` still lists them. |

Without a terminal and without a flag, the command fails, names both flags,
and changes nothing. A move stops at the first board that fails: that board
and the key stay as they were, the boards that moved already work from the new
store, and the same command run again moves the boards that are left. A board
keeps its folder name unless the new store has a folder of that name.

Removing the key does not touch the boards in the central store. A project that
points at a central board keeps working, because the pointer holds the full
path.

## 3. The folders and files

```
~/boards/                             the central store (central_store)
└── .lpm_central/
    ├── shop/                         the central board folder of ~/work/shop
    │   ├── config.yml                the board config, as in a local .lpm
    │   ├── board/  timeline/  team/  ...
    │   ├── .git/                     the board's own repository
    │   ├── .gitignore
    │   └── project.json              { "project_path": "/home/ada/work/shop" }
    └── shop-2/                       the board of another folder called shop
~/work/shop/
├── .lpm/
│   └── config.yml                    the pointer: store: "/home/ada/boards/.lpm_central/shop"
└── src/ ...
```

**The central board folder** holds the same files as a local `.lpm` folder.
That includes `local.json` (who uses this checkout), `credentials.json` and the
write lock `lock`, so these per-checkout files stay with the board.

**The folder name** is the name of the project folder. When a folder of that
name exists, the name gets the lowest free suffix: `-2`, `-3` and so on. Names
are compared without case, as Windows and macOS compare them. A character that
Windows refuses in a folder name (`<>:"/\|?*`) becomes `-`. A name that Windows
reserves for a device (`CON`, `NUL`, `COM1`, ...) gets `-board` appended.

**The pointer** is `<project>/.lpm/config.yml` with one key, `store`. The value
is the absolute path of the central board folder. A file with this key holds no
board config. `findBoardPaths` reads the key and returns a `BoardPaths` whose
`lpmDir` is the central board folder and whose `root` is the project folder.
Every `lpm` command, the MCP server (`lpm mcp --root <project>`) and `lpm ui`
find the board this way. A pointer to a folder without `config.yml`, or to
another pointer, fails with an error that names both paths.

**`project.json`** in the central board folder names the project folder, in the
key `project_path`. `lpm store list` and the landing page read it to show the
project of each board, and the landing page reveals `<project>/.lpm` from it.
`lpm check` warns when the file is missing, or names a project other than the
one that the command came from. `lpm check --fix` writes the current project.

Neither file is shared through git: the project's `.gitignore` lists `.lpm/`,
and the board ignores `project.json` (in its `.gitignore`, or in
`.git/info/exclude` when the board came from a shared repository).

**Paths in messages.** A message names a board file relative to the parent of
the board folder: `.lpm/board/LP-1/_issue.md` for a local board, and
`shop/board/LP-1/_issue.md` for a central board. `related_files` on an issue
stay relative to the project folder.

`LPM_BOARD_PATH` accepts the project folder, its `.lpm` folder, or the central
board folder. For the central board folder, the project comes from
`project.json`. Without that file, the board is its own project folder.

## 4. Creating and moving a board

`lpm init` asks where to create the board when `central_store` is set and stdin
is a terminal. The default answer is the central store. `--central` and
`--local` answer without the question. Without a terminal and without a flag,
`lpm init` creates a local board, so a script keeps its old result.

`lpm store` prints where the board of the current folder is:

```
$ lpm store
central  /home/ada/boards/.lpm_central/shop
project  /home/ada/work/shop
```

`lpm store move --to central` and `lpm store move --to local` move a board.
The move runs under the board lock and takes three steps:

1. Copy the board folder to the target, without the lock file. The move to
   `local` does not copy `project.json`.
2. Compare the file lists and file sizes of the two folders.
3. Switch with renames inside one parent folder, then delete the old folder.

A failure before step 3 removes the copy and leaves the board where it was. The
git history, the remotes, `local.json` and `credentials.json` move with the
board. `lpm move` is a different command: it changes the status, parent,
period or assignee of an issue.

`lpm store list` lists every board in the central store, from any folder:

```
$ lpm store list
blog    BL  /home/ada/work/blog
shop    SH  /home/ada/work/shop
shop-2  SH  /home/ada/old/shop  project missing
in /home/ada/boards/.lpm_central
```

"project missing" means that the project folder is gone, or that its pointer
names another board. `--json` prints the list as JSON.

## 5. Git sync

Git runs every board command (commit, fetch, pull, push, status) in the central
board folder. `lpm git setup --project` reads the remote of the code in the
project folder. [`git-sync.md`](git-sync.md#central-boards) has the details.

`lpm git join --central` clones a shared board into a new folder in
`.lpm_central`, and writes the pointer and `project.json`. `lpm git join
--local` clones into `<project>/.lpm`. Without a flag, it asks the same
question as `lpm init`.

## 6. Every project on this computer: the project index

Each `lpm` command that finds a board records its project in `projects.json`
of the user folder, beside `settings.json`:

| Item | Value |
| --- | --- |
| File | `projects.json` in `~/.light-plan`, or in the folder that `LPM_HOME` names |
| Content | `{ "projects": [ { "root", "lpmDir", "store", "lastUsed" } ] }`, one entry for each project folder |
| Written by | Every CLI command that finds a board, before it runs. `lpm init`, `lpm git join` and `lpm store move` after they run. A board server that `lpm ui` opens from the projects page. |
| Read by | `lpm projects`, `GET /api/projects`, the "All projects" page |
| Turned off by | `LPM_PROJECT_INDEX=off`. The test suites set it. |

The list joins the index with the boards of the central store, so a central
board that no command used yet is listed too. It resolves each project again
from `<root>/.lpm/config.yml`, so a board that moved is listed where it is now.
Each project has a state: `ok`, `project missing` (a central board whose
project folder is gone, or points elsewhere) or `missing` (no board at the
recorded place).

```
$ lpm projects
blog  central  BL  2026-10-24  /home/ada/work/blog
shop  local    SH  2026-10-24  /home/ada/work/shop
old   local    OL  2026-09-01  /home/ada/old           missing
in /home/ada/.light-plan/projects.json
```

`lpm projects forget <path>` removes one entry. `lpm projects prune` removes
each entry in the state `missing`. Neither deletes a board or a folder.

## 7. The "All projects" page, and `lpm ui` outside a board

The web app has a page that lists the project index: File > "All projects…"
goes to `/projects` on the same server. Each row shows the name, `local` or
`central`, the key prefix, the folder, the state and the day of the last use.

- **Open** asks the server for a board server. For its own board, the server
  answers with its own address. For another board, it starts a board server in
  the same process, on the first free port from 4571 upward, or goes to a
  server that already serves the board. Open is off for a project in the state
  `missing`.
- **Reveal** shows `<project>/.lpm` in the file manager. The server takes the
  path from the list, never from the request. Reveal is off unless the state is
  `ok`.
- **Back to the board** returns to `/`.

When `lpm ui` finds no board from the current folder and `central_store` is
set, it starts the **hub** instead of a board server. The hub serves the same
page as its landing page, without the link back. Without `central_store`,
`lpm ui` outside a board fails as before.

The boards that a page opens run in the process of the `lpm ui` that served
the page. When that process stops, they stop.

| Route | Server | Answer |
| --- | --- | --- |
| `GET /api/projects` | both | The list of the project index |
| `POST /api/projects/open` `{ lpmDir }` | both | `{ url }`. 404 for a board folder that is not in the list, 409 for a `missing` project |
| `POST /api/projects/reveal` `{ lpmDir }` | both | Shows `<root>/.lpm`. 404 as above, 409 when the project folder is not known |
| `GET /api/health` | both | The hub adds `hub: true` |
| `GET /api/hub` | hub | `{ hub: true, store, boardsDir }`. A board server answers 404, and the web app uses that answer to choose the page. |
| `GET /api/hub/boards`, `POST /api/hub/boards/:name/open`, `/reveal` | hub | The central boards only, by folder name (the first landing page used these) |

## 8. Assumptions

fleskovar requested the feature on 2026-10-24. The planner took these
decisions without a review so that the work could start (epic LPM-2). The
review LPM-39 confirms or changes each one.

| # | Decision | Status after the implementation |
| --- | --- | --- |
| 1 | The key `central_store` in `settings.json` of the user folder holds the path. | As planned. The command is `lpm set central_store` (the current folder, or `--path <dir>`), which runs `lpm config set central_store`. It moves or abandons a previous store (LPM-46). |
| 2 | A central board lives in `<central_store>/.lpm_central/<name>`, with `-2`, `-3` for a taken name. | As planned. Added: refused characters become `-`, and a reserved device name gets `-board`. |
| 3 | The project keeps `.lpm/config.yml` with the one key `store`. | As planned. The pointer also has three comment lines that say what the file is. |
| 4 | `project.json` names the project, and git does not share it. | Changed in one detail: a board cloned by `lpm git join --central`, or moved to the central store with a git repository, ignores the file in `.git/info/exclude`. A committed `.gitignore` therefore does not change. |
| 5 | `local.json`, `credentials.json` and `lock` stay with the board documents. | As planned. |
| 6 | `git init` runs in the central board folder, and the project's `.gitignore` lists `.lpm/`. | As planned. |
| 7 | `lpm init` asks only with a central store and a terminal. The default answer is central. | As planned. `lpm git join` asks the same question. |
| 8 | The command is `lpm store` (`lpm store`, `move`, `list`), because `lpm move` exists. | As planned. |
| 9 | The landing page starts board servers in the `lpm ui` process. | As planned. Since LPM-50, the landing page is the "All projects" page. |

The second iteration (epic LPM-41, requested on 2026-10-24) added these
decisions. The review LPM-54 confirms or changes each one.

| # | Decision | Status after the implementation |
| --- | --- | --- |
| 10 | The project index is `projects.json` in the user folder. The request said "a config file that lives along the lpm installation". The npm package folder was not used: `npm install -g light-plan` replaces it on each update, and with `npm link` it is the source repository. | As planned. |
| 11 | Each CLI command that finds a board records it, before it runs. `lpm init`, `lpm git join` and `lpm store move` record after they run. Library use of `src/core` records nothing. | As planned. Added `LPM_PROJECT_INDEX=off`, which the test suites set. |
| 12 | The list joins the index with the central boards and resolves each project again. | As planned. |
| 13 | `lpm set central_store` runs `lpm config set central_store`: the current folder, or `--path`. | As planned. |
| 14 | With another store set, the command asks Cancel (default), Move or Abandon. `--move` and `--abandon` answer without the question. | As planned. |
| 15 | A move of the store stops at the first failure and keeps the key until every board moved. | As planned. |
| 16 | File > "All projects…" opens `/projects` on the same server. The hub shows the same page. | As planned. The first landing page (central boards only) and its web code were removed. Its server routes `/api/hub/boards/...` stay. |

## 9. Known issues

| Issue | How to reproduce it | Workaround |
| --- | --- | --- |
| The pointer and `project.json` hold absolute paths. | Rename the project folder or the central store, then run `lpm check` in the project. It fails with "... which holds no board". | Write the new path in the key `store` of `<project>/.lpm/config.yml`, then run `lpm check --fix` to update `project.json`. No command repairs the pointer. |
| A clone of the project has no pointer. | Clone the code repository of a project with a central board. `.lpm/` is not in the clone. | Run `lpm git join --central` (with git sync), or ask for the board folder. |
| A running server keeps the old paths after a move. | Start `lpm ui` or `lpm mcp` on a board, run `lpm store move`, then edit in the running server. The server still uses the paths that it resolved at start, which name the old folder. Not tested. | Stop `lpm ui` and `lpm mcp` before the move, and start them again after. |
| A writer that waited for the lock during a move can write to the old local path. | Not reproduced. A second `lpm` process that resolved the board before the move holds the old paths when it gets the lock. | Do not run other `lpm` commands on the board during a move. |
| On Windows, a move fails when a program holds a file of the board open. | Open a file of `<project>/.lpm` in an editor that locks it, then run `lpm store move --to central`. The move stops with "Could not move ... aside" and "Nothing was moved". | Close the program and run the move again. |
| When the old folder cannot be deleted after a move, it stays on disk. | The move prints a warning that names the folder. | Delete the folder by hand. |
| Two projects that point at one board make `lpm check --fix` rewrite `project.json` in turn. | Copy a pointer from one project to another, then run `lpm check --fix` in each. | Give each project its own board. |
| Boards opened from the landing page stop with the hub. | Open a board from the page, then stop `lpm ui` with Ctrl-C. | Run `lpm ui` in the project folder for a board server of its own. |
| A board with "project missing" cannot be revealed. | Delete a project folder, then open the landing page. | Find the central board folder with `lpm store list`, or restore the project folder. |
| A board without `project.json`, named directly by `LPM_BOARD_PATH`, uses the central board folder as its project. `related_files` then resolve from that folder. | Delete `project.json` and set `LPM_BOARD_PATH` to the central board folder. `lpm check` warns, and cannot fix it. | Run the command from the project folder, or run `lpm check --fix` there. |
| Not tested automatically: the question of `lpm init` and `lpm git join`. | A spawned test process has no terminal. | The flags `--central` and `--local` are tested. |
| Not tested: a second `lpm ui` outside a board reusing a running hub. | — | The code checks `hub: true` on `/api/health`, as `serveBoard` does for a board. |
| Not checked in a browser: the layout of the "All projects" page and the File menu entry. | The tests cover the view-model and the menu entry (`web/test/projects-page.test.ts`), and the routes against the built bundle. | — |
| Two processes that record at the same moment can lose one entry of `projects.json`. | Run many `lpm` commands in parallel in different projects. `recordProject` reads, changes and writes the whole file without a lock. | The next command in that project records it again. |
| `lpm ui` outside a board without `central_store` does not open the "All projects" page, even when the project index holds projects. | Unset `central_store`, then run `lpm ui` in an empty folder. It fails with "No light-plan board found". | Run `lpm ui` in any project, then File > "All projects…". |
| The question of `lpm set central_store` (move, abandon, cancel) is not tested at a terminal. | A spawned test process has no terminal. | The flags `--move` and `--abandon` and the refusal without a terminal are tested. |
| A move of the store skips a folder in the old `.lpm_central` that holds no `config.yml`, and the old folder then stays. | Create an empty folder in the old `.lpm_central`, then run `lpm set central_store --move`. The command prints "left ... holds no board". | Delete the folder by hand. |

A bug found on the way, and fixed: on Windows with `core.autocrlf=true`, a
board cloned by `lpm git join` had a CRLF `INDEX.md`, and `lpm check` reported
it as stale (LPM-40). The check now compares the index without line ends.

## Out of scope for the first iteration

- More than one central store.
- Syncing the central store between computers, other than through git sync.
- A command that repairs a pointer after a folder moved.
- Editing `central_store` from the web app.
