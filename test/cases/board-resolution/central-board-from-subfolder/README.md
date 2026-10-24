# Case: a central board, found from a subfolder of its project

The board documents are in a central store. The project keeps only a pointer.
`lpm` must use the central board folder for the documents, and the project
folder as the root.

## The folder tree

`inputs/tree.json` describes the tree. The runner writes it to a temporary
folder, called `<tmp>` below, and replaces `{{tmp}}` in each file with that
folder. The pointer holds an absolute path, so the case cannot store it as is.

```
<tmp>/
├── project/
│   ├── .lpm/
│   │   └── config.yml        store: "<tmp>/store/.lpm_central/shop"
│   └── src/
│       └── deep/             the command runs here
└── store/                    the central store
    └── .lpm_central/
        └── shop/             the central board folder
            ├── config.yml    version: 1 / key_prefix: SHOP
            └── project.json  { "project_path": "<tmp>/project" }
```

## The expected result, step by step

1. `findBoardPaths` starts in `<tmp>/project/src/deep` and goes up, as for a
   local board, until it finds `<tmp>/project/.lpm/config.yml`.
2. That file holds the key `store`, so it is a pointer. Its value is
   `<tmp>/store/.lpm_central/shop`.
3. `<tmp>/store/.lpm_central/shop/config.yml` exists and has no key `store`.
   The pointer therefore names a board.
4. The board folder (`lpmDir`) is the folder that the pointer names.
5. The project folder (`root`) is the folder where the search found the
   pointer, `<tmp>/project`. `findBoardPaths` does not read `project.json`
   here. `lpm check` compares the two (LPM-7).

`outputs/expected.json` holds both paths relative to `<tmp>`:

```json
{ "root": "project", "lpmDir": "store/.lpm_central/shop" }
```

## Run it

```bash
npx vitest run test/board-resolution-cases.test.ts -t central-board-from-subfolder
```
