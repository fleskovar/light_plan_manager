# The central store: boards outside their projects

A board can keep its documents in one folder on your computer instead of in its
project folder. That folder is the **central store**. This page is the user
guide (sections 1 to 7), the list of decisions that the first iterations rest
on (section 8) and the list of known issues (section 9). It also covers the
project index, which lists every board on the computer, local or central, and
the backups of boards in the central store.

The code is in `src/core/storage/paths.ts` (finding a board through a pointer),
`src/core/storage/central.ts` (writing the pointer and `project.json`),
`src/core/operations/central-store.ts` (the setting, the folder names, the
list), `src/core/operations/relocate.ts` (moving a board and the whole store),
`src/core/operations/backup.ts` (backups and restores), `src/core/storage/tree.ts`
(copying and comparing a folder tree), `withBoardLockAsync` in
`src/core/storage/lock.ts` (the lock of a background job),
`src/core/storage/project-index.ts` and `src/core/operations/project-index.ts`
(the project index), `src/server/launcher.ts`, `src/server/routes/projects.ts`
and `src/server/hub.ts` (opening boards from the web app), `src/server/jobs.ts`
(the background jobs of `lpm ui`), `web/src/features/projects/` (the "All
projects" page) and `web/src/features/config/StorageTab.svelte` (the tab
Storage of the board configuration).

---

## 1. Quick start

```bash
cd ~/boards && lpm set central_store      # once per computer: this folder is the store

cd ~/work/shop
lpm init --central                        # the board goes to ~/boards/.lpm_central/shop
lpm task next                             # every command follows the pointer

cd ~/work/blog
lpm store move --to central               # an existing local board moves there too,
                                          # after a backup in ~/boards/.lpm_backups/blog_backup
lpm store backups                         # lists the backups, with date and age in days
lpm store restore --yes                   # overwrites the board with its backup

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
└── .lpm_backups/
    └── shop_backup/                  the one backup of ~/work/shop
        ├── backup.json               the project folder, the time, the store at that time
        └── board/                    the copy of the board folder
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
The move runs under the board lock and takes five steps:

0. Back the board up into `<central_store>/.lpm_backups/<name>_backup`
   (see [Backups](#backups) below). The backup replaces the earlier backup of
   the project.
1. Copy the board folder to the target, without the lock file. The move to
   `local` copies into the pointer folder `<project>/.lpm`, without
   `project.json` and without `config.yml`.
2. Compare the two folder trees: the file lists, the file sizes and the
   SHA-256 digest of each file. When the trees differ, the move deletes the
   copy, waits 1 second, and copies again. A third copy follows after
   3 seconds. A difference after the third copy fails the move. The second
   and third copies cover git: after each `git commit`, git starts
   `git maintenance run --auto --detach`, which can repack `.git/objects`
   during the copy. A backup and a restore compare and copy again in the
   same way.
3. Switch: replace the file `<project>/.lpm/config.yml`. The move to
   `central` writes the pointer over the board config. The move to `local`
   writes the board config over the pointer.
4. Delete the old files. The move to `central` deletes every entry of
   `<project>/.lpm` except the pointer. The move to `local` deletes the
   central board folder.

The move renames no folder. On Windows, a folder rename fails with `EPERM`
while any program has a file below the folder open, and a terminal, an
editor, a git client or a virus scanner can hold such a file.

The old files are deleted only after step 3. A failure before step 3 removes
the copy and leaves the board where it was. The backup of step 0 stays. When
step 4 cannot delete an entry, the move is complete, and the result holds a
warning that names the entry. Delete that entry by hand. The move to `local`
refuses a pointer folder that holds other entries than `config.yml`, because
the copy would mix with them. The
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

### Backups

A backup is a full copy of one board folder in the central store. Each project
has one backup at most.

| Item | Value |
| --- | --- |
| Folder | `<central_store>/.lpm_backups/<name>_backup/`. Without the key `central_store`, a central board uses the store that holds its folder. A local board without the key has no backup. |
| Name | The name of the central board folder, or the project folder name for a local board, cleaned as section 3 describes, with `_backup` at the end. A taken name gets `-2`, `-3` before the suffix: `shop-2_backup`. |
| Content | `board/`: the copy of the board folder, without `lock`. `backup.json`: the keys `projectPath`, `createdAt` (ISO time), `source` (`local` or `central`), `sourceDir`, `keyPrefix`, `files` and `bytes`. |
| Identity | The key `projectPath`. A board keeps its backup when it moves between its project and the central store. |
| Written by | Each move (`lpm store move`, the Move buttons of the web app), `lpm store backup`, and the Back up buttons of the web app. |
| Read by | `lpm store backups`, `lpm store restore`, `GET /api/projects/backups`, the tab Backups of the "All projects" page, and the tab Storage of the board configuration. |

A backup copies the board into a staging folder beside the backup folder,
compares the copy, writes `backup.json`, and then renames the staging folder
into place. The old backup is deleted only after that rename. A backup that
fails leaves the old backup as it was.

`lpm store backup` refuses when the board has a backup, and names
`--replace`. A move always replaces the backup, because the backup must hold
the board as it was just before the move.

`lpm store restore --yes` overwrites the board of the current folder with the
copy in its backup. Without `--yes`, the command prints the board folder and
the time of the backup, and changes nothing. The restore writes the board
where the board is now: in the project, or in the central store. When the
project has no board, the restore creates `<project>/.lpm`. When the pointer
names a central board folder that is gone, the restore creates that folder
again. A restore to a central folder writes `project.json` for the current
project. A restore to a local folder leaves `project.json` out. The restore
copies the backup into a staging folder beside the board folder, compares the
copy, and then switches the folders with two renames. The backup does not
change.

```
$ lpm store backups
blog_backup  2026-10-24  1 day     central  /home/ada/work/blog
shop_backup  2026-10-13  12 days   local    /home/ada/work/shop
in /home/ada/boards/.lpm_backups
```

`lpm set central_store --move` moves the backups to the new store after the
boards.

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
- **Move to central** (on a local board) or **Move to project** (on a central
  board) moves the board, after a confirmation. The confirmation says that the
  move backs the board up first, and gives the date of the backup that the
  move replaces. Move to central is off without the key `central_store`.
- **Back up** copies the board to its backup, after a confirmation. When the
  board has a backup, the confirmation gives its date and age, and the
  Continue button works only after you type `backup`.
- **Back to the board** returns to `/`.

A move or a backup runs in the background on the server. The row shows a
progress bar with the step ("Step 1 of 2: Backing up", "Step 2 of 2: Copying
the board"), the phase (the copy, then the check of the copy) and the percent.
The page reads `GET /api/projects/jobs` twice a second while a job runs. When
the job ends, the page reloads both lists and shows the result above them.
Open, Move and Back up are off for a board while its job runs.

The tab **Backups** lists each backup of `.lpm_backups`: the project, the store
at the time of the backup, the date and time, the age in days, the number of
files and the size. **Restore** opens a confirmation that says that the
restore overwrites the board. The Continue button works only after you type
`restore`. The restore runs in the background, as a move does.

File ▸ Board configuration… has the tab **Storage**, with the same actions for
the board of the server: Move, Back up (or Replace the backup) and Restore from
backup. The tab shows the board folder, the project folder, the central store,
and the date and age of the backup. After a move, the server writes the new
paths into the paths that its routes read (`followMovedBoard` in
`src/server/jobs.ts`). So the editor keeps working on the board in its new
folder without a restart.

A background job holds the board lock for the whole operation, with
`withBoardLockAsync`. Another process waits for the lock, as for any write. A
write from a request to the same server fails at once with "The board is
busy: this server is doing ...". A wait would stop the server that runs the
job. Every 20 seconds the job writes the current time into the lock file, so a
job that runs longer than `LPM_LOCK_STALE_MS` keeps its lock.

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
| `GET /api/projects/backups` | both | `{ store, backupsDir, backups }`, from `listBackups` |
| `GET /api/projects/jobs` | both | The background jobs of the process: each running job, and each job that ended in the last 10 minutes |
| `POST /api/projects/move` `{ lpmDir, to }` | both | 202 and the job. 400 for a `to` other than `local` or `central`. 404 as above. 409 when the board is not `ok`, is in `to` already or has a job running, or when `to` is `central` without a central store |
| `POST /api/projects/backup` `{ lpmDir, confirm? }` | both | 202 and the job. 409 when the board has a backup and `confirm` is not `"backup"` |
| `POST /api/projects/restore` `{ name, confirm }` | both | 202 and the job. 404 for a name that is not in the list of backups. 400 when `confirm` is not `"restore"`, or when the project folder is gone |
| `GET /api/projects/self` | board server | `BoardStoreInfoDto`: the board folder, the store, the central store, the backup and the last job of this board |

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

The third iteration (requested by fleskovar on 2026-10-25) added moves and
backups to the web app. These decisions were taken without a review.

| # | Decision | Status after the implementation |
| --- | --- | --- |
| 17 | The request said "leave the copy in the central store archived with an _backup". A backup is a folder copy, not a zip or tar file. Node has no zip writer without a new dependency, and a folder copy restores with the same rename steps as a move. | As planned. |
| 18 | The backups are in `<central_store>/.lpm_backups`, not in `.lpm_central`. A folder in `.lpm_central` with a `config.yml` is a board, so `lpm store list`, the project index and `lpm set central_store --move` would treat a backup as a board. | As planned. |
| 19 | The project folder identifies a backup ("one backup per board"). | As planned. |
| 20 | Each move replaces the backup without a typed word. The move confirmation gives the date of the backup that it replaces. Only an explicit backup over an existing one needs the typed word `backup`. | As planned. |
| 21 | The CLI move backs up too ("always"). The CLI has `lpm store backup`, `backups` and `restore`, so the CLI and the web app do the same operations. `relocateBoard` takes `backup: false` for a library caller. | As planned. |
| 22 | The check of a copy compares SHA-256 digests, in addition to the file lists and sizes ("completely copied"). | As planned. The check applies to every move, also to `lpm set central_store --move`. |
| 23 | A restore overwrites the board where it is now, and keeps the backup. A restore does not back up the board first, because that backup would replace the backup that the restore reads. | As planned. |
| 24 | The server runs the operations as background jobs in its own process, with async file calls. The web app polls for the progress. | As planned. A write from a request to the same server fails at once while a job holds the lock of its board. |

## 9. Known issues

| Issue | How to reproduce it | Workaround |
| --- | --- | --- |
| The pointer and `project.json` hold absolute paths. | Rename the project folder or the central store, then run `lpm check` in the project. It fails with "... which holds no board". | Write the new path in the key `store` of `<project>/.lpm/config.yml`, then run `lpm check --fix` to update `project.json`. No command repairs the pointer. |
| A clone of the project has no pointer. | Clone the code repository of a project with a central board. `.lpm/` is not in the clone. | Run `lpm git join --central` (with git sync), or ask for the board folder. |
| A running server keeps the old paths after a move. | Start `lpm ui` or `lpm mcp` on a board, run `lpm store move`, then edit in the running server. The server still uses the paths that it resolved at start, which name the old folder. Not tested. | Stop `lpm ui` and `lpm mcp` before the move, and start them again after. |
| A writer that waited for the lock during a move can write to the old local path. | Not reproduced. A second `lpm` process that resolved the board before the move holds the old paths when it gets the lock. | Do not run other `lpm` commands on the board during a move. |
| On Windows, a move fails when a program holds `<project>/.lpm/config.yml` open. | Open `config.yml` with a program that keeps the file open, then run `lpm store move`. The move stops with "Could not write the pointer ..." or "Could not write the board config ..." and "Nothing was moved". | Close the program and run the move again. |
| When an old file cannot be deleted after a move, it stays on disk. | Hold a board file open with a program that denies delete access, then run `lpm store move --to central`. The move prints a warning that names the entry. | Delete the entry by hand. A move back into the project refuses the pointer folder until the entry is gone. |
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
| Another `lpm ui` or `lpm mcp` process keeps the old paths after a move from the web app. Only the server that ran the move follows the board. | Run `lpm ui` in a project, open the same board from the hub of a second `lpm ui`, and move it from the second one. | Restart the first process. |
| A job runs in the `lpm ui` process. When the process stops during a job, the job stops between two files. | Stop `lpm ui` with Ctrl-C during a long copy. | The board stays where it was. Delete a folder whose name holds `.incoming-` or `.restoring-` by hand. |
| A local board without the key `central_store` has no place for a backup. A central board outside a `.lpm_central` folder, without the key, cannot move to its project, because the move needs a backup. | Unset `central_store`, then run `lpm store backup` on a local board. | Set the key with `lpm set central_store`. |
| The backups of a central board without the key are in the store that holds the board, and `lpm store backups` does not list them. | Unset `central_store`, then back up a central board. | Set the key again. |
| A board without a known project (no `project.json`) has no backup. | Delete `project.json` of a central board, then back it up. | Run `lpm check --fix` in the project folder. |
| A write from the editor fails with "The board is busy" while a job of the same server holds the lock. | Start a move of the open board, and change an issue during the copy. | Wait until the progress bar is gone, then make the change again. |
| Not checked in a browser: the layout of the progress bar, the tab Backups, the typed confirmation and the tab Storage. | The tests cover the view-models (`web/test/store-maintenance.test.ts`) and the routes (`test/server-store-jobs.test.ts`). | — |

A bug found on the way, and fixed: on Windows with `core.autocrlf=true`, a
board cloned by `lpm git join` had a CRLF `INDEX.md`, and `lpm check` reported
it as stale (LPM-40). The check now compares the index without line ends.

## Out of scope for the first iteration

- More than one central store.
- Syncing the central store between computers, other than through git sync.
- A command that repairs a pointer after a folder moved.
- Editing `central_store` from the web app.
