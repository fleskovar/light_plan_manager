# Case: two names that differ only in case

`.lpm_central` holds the board `shop`. A project folder called `Shop` (capital
S) gets a board.

## Input

`inputs/input.json`:

| Field | Value |
| --- | --- |
| `projectName` | `Shop` |
| `existingNames` | `shop` |

## The expected result, step by step

1. The cleaned name is `Shop`.
2. The allocator compares names without case: `Shop` and `shop` are both
   `shop`. On Windows and on macOS (by default), the file system also treats
   them as one folder. A folder `Shop` would therefore be the existing board
   `shop`.
3. The name is taken. The first free suffix is `-2`, so the result is
   `Shop-2`. The allocator keeps the case of the project name.

`outputs/expected.json`: `{ "name": "Shop-2" }`.

On Linux, the file system accepts both `shop` and `Shop`. The allocator still
gives `Shop-2`, so a central store gives the same names on every platform.

## Run it

```bash
npx vitest run test/central-names-cases.test.ts -t case-only-difference
```
