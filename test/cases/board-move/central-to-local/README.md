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
2. `relocateBoard` copies the board folder to a new folder beside
   `project/.lpm`, without `project.json`. A local board has no use for the
   file, because its project is the parent folder.
3. It compares the two file lists and sizes. They are equal.
4. It renames the pointer folder `project/.lpm` aside, and renames the copy to
   `project/.lpm`.
5. It deletes the pointer folder and `store/.lpm_central/project`.

`outputs/tree.txt` lists every file after the move, without `home/`:

| File | Why it is there |
| --- | --- |
| `project/.lpm/*` | The four board files. `config.yml` is the board config now, not the pointer. |
| `store/.lpm_central/other/config.yml` | The move does not touch another board. |

`project.json` is in no folder. `.gitignore` keeps its line `project.json`,
which does no harm.

## Run it

```bash
npx vitest run test/board-move-cases.test.ts -t central-to-local
```
