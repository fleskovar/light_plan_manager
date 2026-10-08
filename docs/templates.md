# The template registry

The full reference for `.lpm/registry/`: reusable pieces of plan a team has
already worked out, and the process templates that capture how a particular kind
of change has to be done. `README.md` has the tour; this is the specification.

Read it before touching `src/core/board/registry.ts`, `src/shared/plans/instantiate.ts`
or `src/shared/template-params.ts`, and update it after.

> **Not to be confused with `.lpm/templates/context/`.** Those are the layouts
> `lpm instructions` renders a working brief with. They are compiled and run, and
> `docs/context-templates.md` is their reference — including the safety analyzer
> that stands between them and the shell. A registry template is a *document*;
> nothing about it is executable.

## What a template is

A fifth collection, structurally identical to the other four:

| | |
| --- | --- |
| Directory | `.lpm/registry/` |
| Document | `_template.md` |
| Ids | `TPL-1`, `TPL-2`, … (`template_prefix`, default `TPL`) |
| Counter | `template_counter` in `.lpm/state.json` |
| `NodeKind` | `template` |

It carries one of the board's **own issue types** and sits at that type's depth,
because it is the shape of the issue it produces. What it adds is a
`description` (so the registry reads as a catalogue) and, on a root, the `params`
whoever instantiates it has to answer. What it drops is everything about *this*
piece of work: no status, no assignee, no period, no flag.

```markdown
---
id: TPL-3
type: feature
title: "{{name}} API"
description: REST endpoint with schema, tests and docs
params:
  name:
    type: string
    required: true
    description: What the API is for
  owner:
    type: string
    default: nobody
depends_on: []
relates_to: []
related_files: []
created: 2026-08-14T09:12:00.000Z
updated: 2026-08-14T09:12:00.000Z
author: Jane Doe <jane@example.com>
---

## Context

The {{name}} API, owned by {{owner}}.
```

## The namespace is derived, never declared

There is no `template_types` and no `template_hierarchy`, and there never will
be: a second declaration could only ever drift from the first. Both are computed
in `src/core/config/lookup.ts`:

```
templateTypes(config)     = { ...config.issue_types, folder }
templateHierarchy(config) = config.hierarchy.map(level => [...level, 'folder'])
```

So a board whose issue hierarchy is `program › epic › feature › user_story` has
a registry hierarchy of:

| Depth | Types allowed |
| --- | --- |
| 0 | `program`, `folder` |
| 1 | `epic`, `folder` |
| 2 | `feature`, `folder` |
| 3 | `user_story`, `bug`, …, `folder` |

Two consequences worth stating out loud:

- **`folder` is reserved across every namespace.** `config/schema.ts` refuses a
  board that declares an issue, period, resource or squad type called `folder`,
  because the registry reuses the issue types by name and "which folder?" would
  have no answer.
- **`template_prefix` is always in the prefix-collision check**, unlike the
  optional namespaces. Every board has a registry, because every board has issue
  types.

## Folders, roots, and what sits where

A **folder** is the registry's one own type. It stands in for a level nobody
templatized: to keep a feature template on its own, file it under a folder where
the epic would go. It is never instantiated.

A **root** is the template somebody instantiates: one whose parent is a folder,
or nothing. Everything nested under it comes with it. `isTemplateRoot` in
`src/core/board/registry.ts` is the one definition; `TemplateDto.root`
denormalizes it so no front end has to walk the registry to find out.

Two rules on top of the hierarchy:

| Rule | Enforced by |
| --- | --- |
| A folder may sit at any depth, so `allowedDepths` is a list rather than one number | `config/lookup.ts`, used by `resolveParentFor` and `retypeNode` |
| A folder never sits *inside* a template | `placementProblem` / `requirePlacement`, called by create, retype and `check` |
| Only a root declares `params` | `createTemplate`, `updateNode`, `checkTemplates` |

```
.lpm/registry/
  TPL-1/                    folder   "Delivery"          (program level)
    TPL-2/                  folder   "Epic slot"         (epic level)
      TPL-3/                feature  "{{name}} API"      <- a root
        TPL-4/              story    "Design the {{name}} schema"
        TPL-5/              story    "Implement {{name}} endpoints"   after TPL-4
        TPL-6/              story    "Document {{name}} for {{owner}}"  after TPL-5
```

## Parameters

Declared exactly like a board attribute, and validated by the same
`validateAttributeValue`, so an `enum` of three values refuses a fourth for the
same reason a document does.

| Field | Meaning |
| --- | --- |
| `type` | One of `string`, `text`, `int`, `float`, `bool`, `date`, `enum`, `array` |
| `description` | Shown in `lpm template show` and in `get_template`; write one |
| `required` | Refused at instantiation when unanswered and undefaulted |
| `default` | Used when unanswered |
| `values` | Required for, and only for, `enum` |

`src/shared/template-params.ts` is the single definition, imported by core and by
the browser — the seventh import-free rule module in `src/shared`.

### Placeholders

`{{name}}`, with optional spaces inside the braces. A name and nothing else:
there is no expression syntax, no logic, no escape for a literal `{{name}}`, and
nothing is ever compiled or evaluated. A template that needs braces writes them
apart.

Substituted in **titles, bodies, `related_files` and attribute values**,
throughout the whole subtree — not just on the root.

**A whole-string placeholder keeps the parameter's type.** `story_points:
"{{points}}"` with `points: 8` writes the number 8, not `"8"`. Anything else is
interpolated as text, and a list is filled entry by entry.

That is also why a template's attributes are exempt from type validation while
they hold a placeholder: `holdsPlaceholder` is checked by `buildAttributes`,
`updateNode` and `checkCollection`, and nothing relaxes on the board itself —
the value is filled in before an issue is written.

## Instantiating

`planInstantiate` in `src/shared/plans/instantiate.ts` is the one definition, so
`lpm template apply`, the MCP `instantiate_template` and anything the web grows
later cannot disagree. It is a planner like the others: pure, `BoardView` in,
`Change[]` out, replayed through `src/sync`.

```bash
lpm template apply TPL-3 --params ./payments.json --under LP-14
lpm template apply TPL-3 --set name=Payments --set owner=Ana --under LP-14
lpm template apply TPL-3 --set name=Payments --dry-run
```

```
instantiate_template { id: "TPL-3", params: { name: "Payments" }, parent: "LP-14" }
```

What it does:

1. resolves the parameters, refusing a missing required one and an answer the
   template never asked for;
2. checks the target against the **issue** hierarchy, before anything is queued;
3. refuses a placeholder no parameter declares, rather than copying `{{nmae}}`
   onto the board;
4. creates the whole subtree, filling in every answer;
5. **repoints the dependencies between the copied templates at the issues just
   created**, and drops the ones that left the subtree — exactly as duplicating a
   structure does, so a fresh copy stands on its own.

Options: `parentId`, `params`, `period`, `assignee`, `status`. Scheduling is the
caller's, never the template's: a reusable piece of plan that pinned a sprint
would be wrong the second time it was used.

The registry itself is never written to. `test/templates.test.ts` asserts the
root's file is byte-identical afterwards.

## Checking

`checkTemplates` in `src/core/validation/checks/templates.ts` reports what is the
registry's own; `checkCollection` already covers ids, types, depths and
attributes, because the registry is a collection like the others.

| Level | Reported |
| --- | --- |
| error | a folder inside a template |
| error | `params` on a folder, or on anything but a root |
| error | a `params` default its own declaration rejects |
| error | `depends_on` / `relates_to` naming something outside the registry |
| warn | a root with no description |
| warn | a placeholder no parameter of its root declares |

A template can never make the *board* wrong — nothing in `board/` reads one — so
none of this blocks anything. `--fix` dedupes the link lists and does no more:
nothing can invent a description, and nothing should guess at a parameter.

## Surfaces

| Surface | Reading | Writing |
| --- | --- | --- |
| CLI | `lpm template list`, `lpm template show` | `lpm template new`, `lpm link`, `lpm template apply` |
| MCP | `list_templates`, `get_template`, `board_overview` (`counts.templates`), `get_document`, `list_documents { kind: "template" }` | `instantiate_template` |
| Web | a view with `mode: "templates"` — the same canvas, table and panel | create, nest, link, edit descriptions and parameters, Push |

`lpm link` takes a template id and routes to `linkTemplate`: a template's
`depends_on` means the same thing one level removed, so it is added, removed and
cycle-checked by the same code as an issue's.

Instantiating is deliberately **not** in the web app. The parameter file lives
where the CLI and the agent are, and a form that collected the same answers would
be a second way of doing it.

## Why an agent is told to look first

The MCP server's instructions name `list_templates` before anything about
creating documents, and both shipped agents carry the read tools. That is the
point of the feature as much as the typing it saves: a template named "Database
migration" is a team saying *this is how we do those*, and an agent that writes
its own four tickets instead has quietly skipped a process somebody wrote down.

`list_templates` is cheap and returns enough to decide in one call — the
description, the parameters, and how many documents it would create.

## Where the code is

| File | Responsibility |
| --- | --- |
| `src/shared/template-params.ts` | Parameters and placeholders. Imports nothing; core and the browser both read it |
| `src/shared/plans/instantiate.ts` | The one definition of what instantiating means |
| `src/core/board/registry.ts` | Roots, folders, paths, and the placement rule |
| `src/core/board/load/fields.ts` | `readParams` — forgiving, like the rest of loading |
| `src/core/operations/create.ts` | `createTemplate` |
| `src/core/operations/link.ts` | `linkTemplate`, sharing `linkNode` with issues |
| `src/core/validation/checks/templates.ts` | What is true of a template beyond any document |
| `src/cli/commands/template.ts` | `list` / `show` / `new` / `apply` |
| `src/mcp/tools/templates.ts` | The three agent-facing tools |
| `web/src/features/panel/sections/params.ts` | The parameter editor's rules, DOM-free |
