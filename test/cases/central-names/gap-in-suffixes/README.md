# Case: a gap in the suffixes

Three projects called `shop` already have central boards: `shop`, `shop-2` and
`shop-4`. Somebody deleted `shop-3` earlier. A fourth project called `shop`
gets a board.

## Input

`inputs/input.json`:

| Field | Value |
| --- | --- |
| `projectName` | `shop` |
| `existingNames` | `shop`, `shop-2`, `shop-4` |

## The expected result, step by step

1. The cleaned name is `shop`. It is taken.
2. The allocator tries the suffixes in order, starting at `-2`:

   | Candidate | Taken? |
   | --- | --- |
   | `shop-2` | yes |
   | `shop-3` | no |

3. The first free candidate is `shop-3`. The allocator stops there and does not
   look at `shop-4` or later.

`outputs/expected.json`: `{ "name": "shop-3" }`.

The allocator takes the lowest free suffix, not the highest suffix plus one. A
gap left by a deleted board is used again.

## Run it

```bash
npx vitest run test/central-names-cases.test.ts -t gap-in-suffixes
```
