# Case: the project name is free

A project folder called `shop` gets a central board. `.lpm_central` already
holds the boards `blog` and `crm`.

## Input

`inputs/input.json`:

| Field | Value |
| --- | --- |
| `projectName` | `shop` |
| `existingNames` | `blog`, `crm` |

## The expected result, step by step

1. `shop` holds no character that Windows refuses (`<>:"/\|?*`), and it does
   not end in a dot or a space. The cleaned name is `shop`.
2. The allocator compares names without case. The taken names are `blog` and
   `crm`. Neither one is `shop`.
3. The name is free, so the result is `shop`, with no suffix.

`outputs/expected.json`: `{ "name": "shop" }`.

## Run it

```bash
npx vitest run test/central-names-cases.test.ts -t free-name
```
