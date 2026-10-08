# Context templates

The full reference for the layouts `lpm instructions` and the MCP tool
`get_instructions` render a **working brief** with. The user-facing summary is in
[README.md](../README.md#working-briefs-the-context-to-actually-do-it); this is
the part you need when you are writing one — and the part you need before you
run somebody else's.

> **A context template is executable code.** It is compiled to JavaScript and
> run. Read [Safety](#safety) before using a template that arrived with a board
> you did not write.

> **Not the template registry.** `.lpm/registry/` holds reusable pieces of
> *plan* — a feature with the stories it always needs — written as documents and
> copied onto the board. Those are not code: `{{name}}` is replaced with a value
> and nothing is compiled. See [docs/templates.md](templates.md). These, in
> `.lpm/templates/context/`, are the layouts a brief is *rendered* with.

## What a brief is for

`lpm task next` says *what* to work on. A brief answers the question straight
after it: *what do I need to know to start?*

An issue on its own almost never answers that. The epic says why the work is
wanted, the feature says what capability it belongs to, and the story only says
which slice was handed out. So a brief walks up the hierarchy and lays out the
title and body of every ancestor above the issue's own, then adds the issue's
breakdown, the files it names, the two directions along the dependency graph —
where the work comes from and where it is going — the research it rests on, and
its work log, as one piece of markdown meant to be pasted into a prompt.

The two directions are there because neither one alone is enough. What an issue
was sequenced *after* is the history a reader would otherwise re-derive: what was
already decided, and which files it left behind. What is sequenced *after it* is
the shape the work has to end up in — a change that closes this issue and blocks
the next one has not finished the job. And if the issue carries a **flag**, the
brief leads with it: somebody has already picked this up and stopped.

```bash
lpm instructions LP-12          # markdown on stdout, nothing else
lpm instructions                # the issue you have in progress
lpm instructions --list         # which layout each issue type resolves to
lpm instructions --audit        # read every layout on this board for risky code
lpm instructions --init         # write the starter layouts into this board
```

Everything about *how* the brief was made — which template, which warnings — goes
to stderr, so stdout is the brief and only the brief.

## Where a layout comes from

Three places are tried, in order:

1. `.lpm/templates/context/<issue type>.md` — this board's layout for that type.
2. `.lpm/templates/context/default.md` — this board's layout for everything else.
3. A built-in layout compiled into the package (`src/core/instructions/builtin.ts`).

The built-in one names no type, no status and no attribute, so it works on any
board whatever its hierarchy — which is what makes "a board that has never heard
of context templates still gets a brief" true rather than aspirational.
`templates/context/default.md` in this repository is deliberately the same
layout, so ejecting the starters changes nothing until somebody edits them.

`--template <x>` overrides all three. It is taken as a **template name first and
as a file path second**, so `--template user_story` means this board's layout,
not a file that happens to be called that.

### The starters

`lpm init` writes the starter layouts for the issue types the chosen config
actually declares, plus `default.md`. `lpm instructions --init` does the same for
an existing board. Neither ever overwrites a file that is already there without
`--force`: an edited layout is worth more than the starter it grew from.

The package ships starters for `default`, `epic`, `feature`, `user_story`, `bug`,
`test`, `review`, `research`, `sub_task` (the scrum hierarchy) and `story`,
`task` (the kanban one). A declared type with no starter — `program`, say — falls
through to `default.md`, which is the fallback doing its job rather than a gap.

### They are not board truth

Templates live under `.lpm/templates`, which `load.ts` never walks. `check` does
not know they exist, and no template can make a board invalid. A template that
will not parse is an error on one command, not a broken board.

## The language

Templates are [Eta](https://eta.js.org) templates, which is EJS syntax. The code
between the tags is **ordinary JavaScript**.

```
<%= value %>                    print a value
<% code %>                      run a statement
<% /* comment */ %>             a comment, dropped from the output
```

```markdown
# <%= issue.id %> — <%= issue.title %>

<% if (epic) { %>
## Epic: <%= epic.title %>

<%= heading(epic.body, 3) %>

<% } %>
<% for (const task of children) { %>
- **<%= task.id %>** <%= task.title %> — <%= task.status_label %>
<% } %>
```

Because it is JavaScript, `children.length`, `.filter()`, `.map()`,
`.toUpperCase()` and `?.` all work, and there is no filter syntax to learn.

Four things about it are worth knowing before you write one:

- **An empty array is truthy.** Guard a list with `.length`
  (`<% if (children.length) { %>`) and an optional document with the name alone
  (`<% if (epic) { %>`). `<% if (children) { %>` is always taken.
- **Reaching through something absent throws**, exactly as in any JavaScript.
  `<%= a.b.c %>` where `a.b` is undefined is a render error; write `<%= a.b?.c %>`
  or guard the section.
- **A line holding nothing but one `<% %>` control tag takes its newline with
  it.** That is Eta's `-%>`, applied for you, and it is what lets a template be
  laid out like the markdown it produces. Interpolations are never touched:
  those are content. So put a blank line *before* each `<% if %>` — the tag's own
  line disappears, and that blank line is what separates the section from what
  came before it.
- **Runs of three or more blank lines collapse to one**, so a section that turned
  out empty leaves no hole.

### Values

At the root of a brief:

| Name | What it is |
| --- | --- |
| `issue` | the issue the brief is about |
| `parent` | its immediate parent, or nothing |
| `ancestors` | every ancestor, **outermost first** |
| `children` | its direct children |
| `descendants` | everything below it, parents before children |
| `siblings` | documents with the same parent, this one excluded |
| `blocked_by` | issues in its `depends_on` |
| `blocks` | issues that depend on it (derived) |
| `relates_to` | its non-blocking links |
| `related_files` | the file references written on it, as strings |
| `upstream_files` | what the work before it touched: one `{ issue, files }` per entry in `blocked_by` that names a file |
| `period` | the period it is scheduled in, or nothing |
| `assignee` | the person or pool it is assigned to, or nothing |
| `comments` | its work log, oldest first |
| `board` | `.name`, `.key_prefix`, `.statuses` |
| `today` | `YYYY-MM-DD` |
| *every issue type the board declares* | the nearest ancestor of that type, or the issue itself when it *is* one; `null` when there is none |

That last row is the one that makes a shared layout possible: on a story,
`<%= epic.title %>` is *this story's* epic, however deep it sits, and
`<% if (epic) { %>` is how a template stays honest on a board where some stories
have no epic. A type whose name collides with one of the fixed names above — or
with a helper — keeps the fixed meaning.

The issue is `issue`, **not `this`**. Eta puts the data in scope with `with`,
which rebinds identifiers and not the `this` keyword, so `this` in a template is
the template engine itself. Writing it is refused (see below), which turns the
habit into an error message rather than a mystery.

### A document

Every document — `issue`, an ancestor, a child, a blocker — has the same shape:

| Field | Notes |
| --- | --- |
| `id`, `type`, `title`, `body` | `body` is trimmed |
| `type_label` | the label from the config, e.g. `User Story` |
| `attributes.<name>` | one attribute by name |
| `attribute_list` | the same as a list, in config order, empties dropped; each has `name`, `label`, `value`, `type`, `description` |
| `status`, `status_label`, `done`, `active` | issues; empty/false elsewhere |
| `flag`, `flag_label` | why work on it has stopped (`blocked`, `paused`, `help`) and how to print it; **empty strings** when it has not, so `<% if (issue.flag) { %>` reads as expected |
| `related_files` | the file references written on it, as strings, exactly as typed — never resolved, never checked against the filesystem |
| `parent`, `ancestors`, `children`, `descendants`, `siblings` | documents |
| `blocked_by`, `blocks`, `relates_to` | documents |
| `period`, `assignee` | documents, or nothing |
| `starts`, `ends` | periods |
| `capacity`, `generic`, `covers` | resources |
| `comments` | **only on the issue the brief is about** — the ancestry is not opened, because paying for a `_comments.md` read per ancestor to render one heading is not worth it |
| `path`, `depth`, `created`, `updated`, `author`, `kind`, `is_target` | |

`attribute_list` exists beside `attributes` because a layout that does not know
the board's attribute names can still walk a list.

`related_files` is on every document rather than only on the target, which is
what lets a layout show the two directions along the graph as *code* and not
only as titles:

```
<% for (const blocker of blocked_by) { %>
- **<%= blocker.id %>** <%= blocker.title %><% if (blocker.related_files.length) { %>
  — touched <%= join(blocker.related_files, ", ") %><% } %>
<% } %>
```

`upstream_files` at the root is the same thing already gathered and already
filtered to the issues that named a file, because the guard for "is there
anything to print here?" is otherwise written in every layout that wants it.

A `flag` is the one field a brief should lead with. It means somebody picked the
work up, stopped, and wrote down why in the work log — so a layout that renders
the flag but not the comments has told the reader there is a problem and hidden
the description of it. The shipped starters put a block quote above everything
else and point at the log.

### Helpers

Small on purpose: JavaScript already has `.toUpperCase()`, `.length`, `.filter()`
and `.join()`, so these are only the things markdown needs and JavaScript has no
opinion about.

| Helper | Does |
| --- | --- |
| `heading(body, n)` | **re-levels** a body so its shallowest heading sits at level `n`, keeping the structure below it |
| `indent(text, n)` | indents every line but the first by `n` spaces |
| `def(value, "x")` | `"x"` when the value is empty, and no warning for it |
| `text(value)` | the string an interpolation would print, without printing it |
| `join(list, ", ")` | a list into text, each entry stringified the same way |
| `truncate(text, n)` | cap the length, with an ellipsis |

`heading` is a re-level rather than a fixed shift because bodies do not agree
with each other: one document starts at `#`, the next at `##`, and shifting both
by the same amount would nest one of them wrongly. What a template means by
`<%= heading(epic.body, 3) %>` is "put this under the `##` heading I just wrote",
and that is what it does. Fenced code is left alone — a `# comment` in a shell
sample is not a heading.

### What is printed

Every interpolation goes through one stringifier, so a brief never contains
`undefined`, `null` or `[object Object]` — three things a person reading a
working brief should not have to interpret.

- A string, number, boolean or date prints as itself.
- A list prints as its elements joined with `, `.
- `null` and `undefined` print as nothing, and add a warning.
- **A document prints as nothing** and adds a warning: write `.title`, `.id` or
  `.body` on it.

### A name the board does not answer

A layout is a file, and the vocabulary moves underneath it: a value the engine
once offered can be retired, and an install never overwrites the copy a board
already holds. So a name that is neither in the tables above nor a board type is
**empty**, and adds a warning naming it — it does not stop the render.

Empty means empty in every way a layout asks. `<% if (gone) %>` is false,
`gone.length` is `0`, `<% for (const x of gone) %>` walks nothing, `<%= gone %>`
prints nothing, `gone.title` is not an error, and `def(gone, "—")` fills in. What
still throws is reaching *through* it — `gone.a.b` — exactly as anywhere else in
JavaScript.

Warnings never stop a render. They come back on stderr from the CLI and in
`warnings` from the MCP tool. A retired name is the one worth acting on: take the
section out of the layout, or refresh it from the shipped starter.

## Safety

**Eta compiles a template into a JavaScript function and runs it.** A
`.lpm/templates/context/*.md` file is therefore executable code, and a `.lpm`
folder arrives over `git pull` from whoever wrote it. Rendering somebody else's
board can run somebody else's JavaScript, as you, with your filesystem and your
environment variables.

That is a real trade, made deliberately: a standard engine that people and their
tooling already know, at the cost of a capability a layout does not need. What
follows is what makes it survivable.

### The check

Every template is read and parsed **before it is compiled**. One that reaches for
the host is refused rather than run.

```bash
lpm instructions --audit     # read every layout on the board; exits 1 on a finding
```

Two decisions make this worth having rather than security theatre:

1. **It tokenizes with Eta's own parser**, never a regex. Eta's lexer skips `%>`
   inside strings and comments, so `<%= "a %> b" %>` is one tag. A hand-rolled
   scanner would disagree with the engine about where code begins, and every
   such disagreement is a hole.
2. **It parses the code with [acorn](https://github.com/acornjs/acorn)** rather
   than matching text, so `x["cons" + "tructor"]` is seen for what it is.

| Rule | Severity | What it catches |
| --- | --- | --- |
| `host-global` | danger | `process`, `require`, `module`, `global`, `globalThis`, `Buffer`, `eval`, `Function`, `setTimeout`, `Reflect`, `Proxy`, `fetch`, `WebAssembly`, … and Eta's own `include` / `layout`, which read files |
| `escape-property` | danger | `.constructor`, `.__proto__`, `.prototype`, the `__define*__` pair |
| `computed-member` | danger | any property reached by a computed key — the evasion route for every rule above |
| `this-expression` | danger | `this`, which is the Eta instance and hence a full escape |
| `dynamic-import` | danger | `import(...)` |
| `with-statement` | danger | `with`, which rebinds every name in the template |
| `unbounded-loop` | caution | `while` / `do` / `for(;;)` — a hang rather than a compromise |
| `debugger` | caution | `debugger` |

A `danger` refuses the render. A `caution` is reported and rendered.
`--unsafe` renders anyway, for a template you wrote and meant; the MCP tool has
no equivalent and never will, because letting an agent opt out is the whole hole.

The classic escape needs none of the dangerous names spelled out:

```
<%= this.constructor.constructor("return process")().env.AWS_SECRET_ACCESS_KEY %>
```

which is why `this`, `.constructor` and computed keys are all refused
independently.

### What it does not do

The check refuses the known escapes. **It cannot make an untrusted template
safe**, and nothing short of a real sandbox could. Treat a clean audit as "no
known escape", not as "safe to run code from a stranger".

There is no published sanitizer for Eta or EJS templates; the ecosystem's
position is that a template is trusted code. If you pull boards from people you
do not trust, read their `.lpm/templates/context/` the way you would read a
`postinstall` script.

## Writing one

```markdown
# <%= issue.id %> — <%= issue.title %>

Status: <%= issue.status_label %><% if (issue.period) { %> · <%= issue.period.title %><% } %>

<% if (epic) { %>
## Epic: <%= epic.title %> (<%= epic.id %>)

<%= heading(epic.body, 3) %>

<% } %>
## The story

<%= heading(issue.body, 3) %>

<% if (children.length) { %>
## Sub-tasks

<% for (const task of children) { %>
### <%= task.title %> (<%= task.id %> · <%= task.status_label %>)

<%= heading(task.body, 4) %>

<% } %>
<% } %>
```

Four habits keep a layout working on a board that grows:

- **Guard everything optional.** `.length` for lists, the bare name for a
  document. Not every story has an epic, a period, an assignee or a work log.
- **Put a blank line before each `<% if %>`.** The tag's own line disappears, so
  that blank line is what separates the section from what came before it.
- **Do not reach for anything outside the board.** If you find yourself wanting
  `require`, the thing you want belongs in the engine, not in a layout.
- **Check it against a real issue.** `lpm instructions <id>` is the whole test,
  and `lpm instructions --audit` is the other half.

## Extending this

The engine layer is `src/core/instructions/`, above `profile/` and below
`operations/`, and it is read-only — a brief reports the board, it never changes
it.

| To add | Touch |
| --- | --- |
| A helper | `HELPERS` in `template.ts`; `HELPER_NAMES` and the CLI help update themselves |
| A value a template can see | `NodeView` or `InstructionContext` in `context.ts`, and a row in the tables above |
| A safety rule | `HOST_GLOBALS` / `ESCAPE_PROPERTIES` / the `walk` switch in `analyze.ts`, plus `MESSAGES` and a case in `test/instructions.test.ts` |
| A shipped starter | a file in `templates/context/` named after an issue type; `installContextTemplates` picks it up for any board declaring that type |
| A new front end for briefs | call `instructionsFor(board, id, options)`; do not re-derive the context, and do not pass `allowUnsafe` unless a human typed a flag |
