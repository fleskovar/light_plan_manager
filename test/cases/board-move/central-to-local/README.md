# Case: move a central board back into its project

The project `project` points at the central board
`store/.lpm_central/project`. A second central board, `other`, belongs to
another project. The command is `lpm store move --to local`.

## The folder tree before the move

`inputs/case.json` lists the files. The runner writes them to a temporary
folder, called `<tmp>` below, and replaces `{{tmp}}` with that folder.

```
<tmp>/
├── home/settings.json             { "central_store": "<tmp>/store" }
├── project/
│   └── .lpm/config.yml            store: "<tmp>/store/.lpm_central/project"
└── store/.lpm_central/
    ├── project/                   the board of this project
    │   ├── .gitignore
    │   ├── config.yml
    │   ├── project.json           { "project_path": "<tmp>/project" }
    │   ├── state.json
    │   └── board/LP-1/_issue.md
    └── other/config.yml           the board of another project
```

## The expected result, step by step

1. `findBoardPaths(<tmp>/project)` follows the pointer. The board folder is
   `store/.lpm_central/project`, and the project folder is `<tmp>/project`.
2. `relocateBoard` backs the board up. It copies every file of the board
   folder to `store/.lpm_backups/project_backup/board`, compares the copy, and
   writes `backup.json` beside `board/`. The backup keeps `project.json`.
3. It copies the board folder into the pointer folder `project/.lpm`, without
   `project.json` and without `config.yml`. A local board has no use for
   `project.json`, because its project is the parent folder.
4. It compares the two trees: the file lists, the sizes and the SHA-256
   digests. The comparison leaves out the pointer. The trees are equal.
5. It writes the board `config.yml` over the pointer `project/.lpm/config.yml`
   in one file rename. It renames no folder.
6. It deletes `store/.lpm_central/project`.

`outputs/tree.txt` lists every file after the move, without `home/`:

| File | Why it is there |
| --- | --- |
| `project/.lpm/*` | The four board files. `config.yml` is the board config now, not the pointer. |
| `store/.lpm_backups/project_backup/backup.json` | The record of the backup: the project folder, the time and the source store. |
| `store/.lpm_backups/project_backup/board/*` | The five files of the central board folder, as they were before the move. |
| `store/.lpm_central/other/config.yml` | The move does not touch another board. |

`project.json` is in no folder. `.gitignore` keeps its line `project.json`,
which does no harm.

## Run it

```bash
npx vitest run test/board-move-cases.test.ts -t central-to-local
```
