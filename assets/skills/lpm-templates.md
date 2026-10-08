---
name: lpm-templates
description: The template registry on a light-plan board — reusable pieces of plan a team has already worked out, and the process templates that capture how a particular kind of change has to be done. Load this before creating documents on a board, whenever a task involves `lpm template`, `.lpm/registry/`, the MCP tools list_templates / get_template / instantiate_template, or a request to "add the standard stories", "follow our process for X", "make this reusable" or "turn this into a template".
roles:
  - developer
  - pm
---

# The template registry

Load the `lpm` skill first for the tool map.

A board's **registry** (`.lpm/registry/`) holds reusable pieces of plan: a
feature with the three stories it always needs, the checklist a release goes
through, the sequence a schema migration has to follow. They are written in the
board's own issue types and nest the same way, so a template is the shape of
real work rather than a description of it.

## Check the registry before you create anything

This is the rule the registry exists for. A team that wrote down "every API
feature needs a schema story, an endpoint story and a docs story" and then
watched an agent create two of them has a registry that is not doing its job.

```
list_templates                       # everything, with what each one is for
list_templates { search: "api" }     # narrow it
```

```bash
lpm template list
```

Ask two questions of the result:

1. **Does one of these cover what I am about to write?** If so, instantiate it —
   it is faster and it is the shape this team agreed on.
2. **Does one of these describe a *process* my work falls under?** A template
   called "Database migration" is a team saying "this is how we do those". Follow
   it even when the work looks small enough to skip a step.

If nothing matches, create documents the ordinary way. An empty registry is a
perfectly good answer; a *skipped* registry is not.

## Reading one before you use it

```
get_template { id: "TPL-3" }
```

```bash
lpm template show TPL-3
```

You get what it is for, every parameter with its type and whether it is
required, and the whole tree of documents it would create with the dependencies
between them. Read it: the parameter names are rarely self-explanatory, and the
tree tells you whether it fits where you meant to put it.

## Putting one on the board

```
instantiate_template {
  id: "TPL-3",
  params: { name: "Payments", owner: "RS-4" },
  parent: "LP-14",
  dryRun: true            # see what would land first
}
```

```bash
lpm template apply TPL-3 --params ./payments.json --under LP-14
lpm template apply TPL-3 --set name=Payments --set owner=RS-4 --under LP-14 --dry-run
```

Everything in the template is created at once, `{{parameters}}` are filled in
throughout — titles, bodies, related files and attribute values — and the
dependencies between the templates become dependencies between the new issues.
The registry itself is never touched.

Three things it refuses, all of them on purpose:

- **a missing required parameter**, naming it;
- **a parameter the template never declared**, so a typo in a JSON file is not a
  template that silently produced the wrong board;
- **a parent the hierarchy will not accept** — a feature template needs an epic
  to sit under, and it says so before anything is written.

`--under` / `parent` is almost always needed. Without it the template lands at
the top level, which only works for a template of a top-level type.

## Writing a template

Only do this when asked, or when you have just created the same shape for the
third time and can say so.

```bash
lpm template new folder -t "Delivery" -d "Standard delivery patterns"
lpm template new folder -t "Epic slot" --parent TPL-1
lpm template new feature -t "{{name}} API" --parent TPL-2 \
    -d "REST endpoint with schema, tests and docs" \
    --param name:string:required --param owner:string=nobody
lpm template new user_story -t "Design the {{name}} schema" --parent TPL-3
lpm template new user_story -t "Implement {{name}} endpoints" --parent TPL-3
lpm link TPL-5 --depends-on TPL-4
```

Three rules, and they are all consequences of the registry mirroring the issue
hierarchy:

- **A template sits where its issue would.** A template of a feature is at the
  feature's depth, which means something has to occupy the levels above it.
- **A `folder` is what occupies them.** It stands in for a level nobody
  templatized — the "epic slot" above — and groups templates for reading. A
  folder is never instantiated and never sits *inside* a template.
- **Parameters are declared on the root**: the template somebody instantiates,
  the one whose parent is a folder. Its children take the same answers.

A parameter is declared exactly like a board attribute — `type`, `required`,
`default`, `values` for an enum — and `{{name}}` is written wherever the answer
should go. An attribute whose whole value is one placeholder keeps the
parameter's type, so `--set story_points='{{points}}'` on an integer attribute
works.

Give every template a **description**. A registry listing with no descriptions
is a folder of ids nobody will read twice.

## Building one on the canvas

`lpm ui` → New view → **Template registry**. The same canvas, table and panel as
a board view, over the registry instead: drag templates into folders, draw
dependencies between them, edit descriptions and parameters in the panel, and
Push when it is right. Instantiating is a CLI and MCP job, because that is where
the parameter file lives.

## What a template is not

- **Not a context template.** `.lpm/templates/context/` holds the layouts
  `lpm instructions` renders a working brief with. Different folder, different
  job, and those *are* executable — see `docs/context-templates.md`.
- **Not board truth.** Nothing in the registry gates work, ranks a queue or
  appears in `lpm task next`. It is a catalogue.
- **Not a script.** `{{name}}` is replaced with a value. There is no logic, no
  loops and nothing is evaluated.
