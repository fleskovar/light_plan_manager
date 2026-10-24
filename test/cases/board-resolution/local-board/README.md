# Case: a local board, found from a subfolder

This case shows the rule that existed before the central store. The central
store must not change it.

## The folder tree

`inputs/tree.json` describes the tree. The runner writes it to a temporary
folder, called `<tmp>` below.

```
<tmp>/
└── project/
    ├── .lpm/
    │   └── config.yml        version: 1 / key_prefix: LP
    └── src/
        └── deep/             the command runs here
```

## The expected result, step by step

1. `findBoardPaths` starts in `<tmp>/project/src/deep`.
2. `<tmp>/project/src/deep/.lpm/config.yml` does not exist. The search goes up
   one folder.
3. `<tmp>/project/src/.lpm/config.yml` does not exist. The search goes up one
   folder.
4. `<tmp>/project/.lpm/config.yml` exists. The file has no key `store`, so it
   is a board config, not a pointer.
5. The board folder (`lpmDir`) is `<tmp>/project/.lpm`. The project folder
   (`root`) is its parent, `<tmp>/project`.

`outputs/expected.json` holds both paths relative to `<tmp>`:

```json
{ "root": "project", "lpmDir": "project/.lpm" }
```

## Run it

```bash
npx vitest run test/board-resolution-cases.test.ts -t local-board
```
