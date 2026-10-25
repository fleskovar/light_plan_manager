# Case: move a local board to the central store

The project `project` has a local board in `project/.lpm`. The central store is
`store`. The command is `lpm store move --to central`.

## The folder tree before the move

`inputs/case.json` lists the files. The runner writes them to a temporary
folder, called `<tmp>` below, and replaces `{{tmp}}` with that folder. It sets
`LPM_HOME` to `<tmp>/home`, so `home/settings.json` is the user settings file.

```
<tmp>/
├── home/settings.json        { "central_store": "<tmp>/store" }
├── project/
│   ├── .lpm/
│   │   ├── .gitignore
│   │   ├── config.yml        the board config
│   │   ├── local.json        who uses this checkout
│   │   ├── state.json
│   │   └── board/LP-1/_issue.md
│   └── src/main.ts           code of the project, not part of the board
└── store/                    the central store, empty
```

## The expected result, step by step

1. `relocateBoard` asks the allocator for a folder name. The project folder is
   called `project`, and `store/.lpm_central` holds no folder, so the name is
   `project`.
2. It backs the board up. It copies every file of `project/.lpm` to
   `store/.lpm_backups/project_backup/board`, compares the copy, and writes
   `backup.json` beside `board/`.
3. It copies every file of `project/.lpm` to `store/.lpm_central/project`. The
   board has no `lock` file in this case. A lock file is never copied.
4. It compares the two trees: the file lists, the sizes and the SHA-256
   digests. They are equal.
5. It renames `project/.lpm` aside, then writes:
   - `store/.lpm_central/project/project.json`, which names `<tmp>/project`;
   - the line `project.json` in `store/.lpm_central/project/.gitignore`,
     because the board is not a git repository (a git board gets the line in
     `.git/info/exclude` instead);
   - the pointer `project/.lpm/config.yml`, with `store:` and the path of the
     central board folder.
6. It deletes the old folder that it renamed aside.

`outputs/tree.txt` lists every file after the move, without `home/`:

| File | Why it is there |
| --- | --- |
| `project/.lpm/config.yml` | The pointer. It is the only file left in `project/.lpm`. |
| `project/src/main.ts` | The move does not touch the code. |
| `store/.lpm_backups/project_backup/backup.json` | The record of the backup: the project folder, the time and the source store. |
| `store/.lpm_backups/project_backup/board/*` | The five board files, as they were before the move. |
| `store/.lpm_central/project/*` | The five board files, and the new `project.json`. |

## Run it

```bash
npx vitest run test/board-move-cases.test.ts -t local-to-central
```
