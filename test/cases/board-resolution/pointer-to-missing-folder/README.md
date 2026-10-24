# Case: a pointer to a central board folder that does not exist

Somebody moved or deleted the central board folder. The project still points
at it. `lpm` must fail with an error that names the missing folder. It must not
fall back to another board.

## The folder tree

`inputs/tree.json` describes the tree. The runner writes it to a temporary
folder, called `<tmp>` below, and replaces `{{tmp}}` in each file with that
folder.

```
<tmp>/
├── project/                  the command runs here
│   └── .lpm/
│       └── config.yml        store: "<tmp>/store/.lpm_central/shop"
└── store/
    └── .lpm_central/         empty: the folder shop does not exist
```

## The expected result, step by step

1. `findBoardPaths` starts in `<tmp>/project` and finds
   `<tmp>/project/.lpm/config.yml`.
2. The file holds the key `store`, so it is a pointer to
   `<tmp>/store/.lpm_central/shop`.
3. `<tmp>/store/.lpm_central/shop/config.yml` does not exist.
4. `findBoardPaths` throws a `BoardError`. The message names the pointer file
   and the missing folder:

   ```text
   The board pointer in <tmp>/project/.lpm/config.yml names <tmp>/store/.lpm_central/shop, which holds no board.
   ```

`outputs/expected.json` holds the end of the message. The runner replaces
`{{tmp}}` in it, and compares paths with forward slashes, so the case passes on
Windows too.

## Run it

```bash
npx vitest run test/board-resolution-cases.test.ts -t pointer-to-missing-folder
```
