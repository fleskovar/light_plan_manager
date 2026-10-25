# The board library

The board library stores markdown documents beside the issues of a board. Use
it for text that belongs with the plan and is not a piece of the plan: a
prompt with instructions for an agent, a summary of a development, a product
requirements document, a style guide.

An issue references a library document. The working brief of the issue
(`lpm instructions`, the MCP tool `get_instructions` and `lpm queue agent`)
then prints the document.

This file is the guide and the design record. Read it before you change
`src/shared/library-id.ts`, `src/core/storage/library.ts`,
`src/core/operations/library.ts`, `src/core/validation/checks/library.ts`,
`src/cli/commands/library.ts`, `src/mcp/tools/library.ts`,
`src/server/routes/library.ts` or `web/src/features/library/`, and update it
after.

## Where the documents are

Each document is one file below the folder `library` of the board folder:

| Board | Library folder |
| --- | --- |
| Local board | `<project>/.lpm/library/` |
| Central board | `<central_store>/.lpm_central/<name>/library/` |

Folders below the library folder are allowed, up to 8 levels.

### The id of a document

The id of a document is its path below the library folder, without `.md`,
with `/` between folders. The file `.lpm/library/prompts/code-review.md` has
the id `prompts/code-review`.

Each part of an id obeys these rules:

- It holds lowercase letters, digits, `-`, `_` and `.`.
- It starts with a letter or a digit.
- It does not end with `.`.

The rule excludes capital letters, because a file `PRD.md` and a file `prd.md`
are the same file on Windows and macOS, and two files on Linux.

Each command accepts an id with a leading `library:`, a trailing `.md`,
backslashes or capitals, and converts it to the normal form. For example,
`Library:PRD\Payments.md` names the id `prd/payments`.

A markdown file whose path breaks the rule stays on disk. `lpm library` does
not list it, and `lpm check` reports it with the name to rename it to.

### The format of a file

A file holds optional YAML frontmatter, then the markdown body:

```markdown
---
title: Payments PRD
description: What the payments epic must do
owner: Ana
---

## Goals

Take card payments in the checkout.
```

| Frontmatter key | Meaning | When the key is absent |
| --- | --- | --- |
| `title` | The title that lists and briefs show | The first `# ` heading of the body. Without one, the last part of the id with a capital letter: `release_notes` gives `Release notes` |
| `description` | One line that says what the document is for | Empty |
| Any other key | Kept as it is on each save | — |

A file without frontmatter is valid. A save writes the key `title` only when
the file held it before or when the person gave a new title. So a title that
comes from the first heading stays out of the frontmatter.

## How an issue references a document

An issue, or a registry template, references a document in one of two ways:

| Where | Text | Example |
| --- | --- | --- |
| The related files of the issue (`related_files` in the frontmatter) | `library:<id>` | `lpm set LP-4 --related library:prd/payments` |
| A markdown link in the body | `[label](library:<id>)` | `Follow [the style guide](library:guides/style).` |

A reference is a piece of text. The library does not need to hold the document
when the reference is written. `lpm check` reports a reference to a document
that does not exist as a warning.

A registry template can reference a document too. The placeholders of a
template work in a reference: `library:prompts/{{kind}}` gives
`library:prompts/bugfix` for the parameter value `bugfix`.

## What the brief prints

`lpm instructions <id>` collects the references of the issue, then the
references of its parent, then those of the next ancestor, up to the top of the
hierarchy. Each document appears once, in that order. So a story brief prints
the requirements document that its epic references.

The built-in layout and every starter template print a section "Library
documents". The section shows the title, the reference, the issue that
references the document, the description and the body of each document. A
reference to a missing document shows as "(not in the library)".

`lpm queue agent` gives the agent the same brief. So a prompt in the library
that a story or its epic references reaches the agent that works the story.

A context template reads the documents through the values `docs` and
`library`. [context-templates.md](context-templates.md#library-documents) lists
their fields.

A board that ejected its starter templates before the library existed keeps
its layouts. Those layouts print `related_files`, so the `library:` entries
show there as text, and the bodies do not show. To print the bodies, add the
section that [context-templates.md](context-templates.md#library-documents)
shows to each layout in `.lpm/templates/context/`.

## The command line

| Command | Result |
| --- | --- |
| `lpm library` | Lists each document: id, title and description |
| `lpm library list --json` | The same list as JSON, without the bodies |
| `lpm library show <id>` | Prints the body on stdout, and the title and the path on stderr, so the output can be redirected |
| `lpm library show <id> --json` | Every field, with the body and the revision |
| `lpm library new <id> [-t <title>] [-d <description>] [-m <text> \| -f <file>]` | Adds a document. `-f -` reads the body from stdin |
| `lpm library set <id> [-t] [-d] [-m \| -f]` | Changes the title, the description or the body |
| `lpm library mv <id> <new-id> [--no-refs]` | Renames the document, or moves every document of the folder `<id>`, and rewrites the references. Aliases: `move`, `rename` |
| `lpm library refs <id>` | Lists the issues and templates that reference the document |
| `lpm library rm <id>` | Deletes the file and each folder that the delete left empty. The references stay, and the command names them |

`lpm lib` and `lpm docs` are aliases of `lpm library`.

## The MCP tools

| Tool | Writes | Result |
| --- | --- | --- |
| `list_library` | No | The id, title, description and path of each document |
| `get_library_document` | No | One document with its body, its revision and the ids that reference it |
| `create_library_document` | Yes | Adds a document |
| `update_library_document` | Yes | Changes the title, the description or the body. With `revision`, the update fails when the file changed after the read |
| `move_library_document` | Yes | Gives a document, or every document of a folder, a new id, and rewrites the references. `updateReferences: false` keeps the old references |
| `delete_library_document` | Yes | Deletes a document, and names the ids that still reference it |

A server that `lpm mcp --read-only` starts registers the two tools that only
read.

## Renaming and moving

`lpm library mv`, the MCP tool `move_library_document` and **Rename** in the
web app call one operation, `moveLibraryDoc` in
`src/core/operations/library.ts`.

| The first id names | What moves | Example |
| --- | --- | --- |
| A document (`<id>.md` exists) | That document | `lpm library mv prd/payments requirements/payments` |
| A folder and no document | Every document below the folder, to the same place below the new folder | `lpm library mv prompts agent-prompts` moves `prompts/review` to `agent-prompts/review` |

When both `prd.md` and the folder `prd/` exist, the id `prd` names the
document, so only the document moves.

After the files move, the operation rewrites each reference of each issue and
template: the `library:<id>` entries of `related_files` and the targets of the
`[label](library:<id>)` links of the body. The label and the title of a link
stay. `--no-refs` (CLI) or `updateReferences: false` (MCP) keeps the old
references, and the answer names the issues that hold them.

The operation checks everything before it changes anything:

- No document may have a new id already.
- A folder cannot move into itself (`prompts` to `prompts/old`).
- Each new id must obey the id rule, which allows 8 parts at most.
- No issue or template whose references change may have changed on disk since
  the board was read. Otherwise the move fails with a `ConflictError`.

The files and the rewritten issues are written in one board write, so a board
that `git_sync` shares gets one commit, with the message
`lpm: move library document <id> to <new-id>`. The activity section of a
rewritten issue does not change, because `updateNode` keeps the activity
section that is on disk.

## The web app

**File ▸ Library…** opens the Library dialog. The list on the left shows each
document with its title, its id and its description, and the search field
filters the list. **New** adds a document.

The right side shows the open document. **Rename** opens a field for the new
id, and the rename rewrites the references, as the CLI does. **Edit** opens the
editor of the issue window: **Write** shows the markdown source and **Preview** shows the rendered
text. Edit also opens the title and the description for editing. **Save**
writes the file. The reference `library:<id>` has a **Copy** button, and the
list "Referenced by" names the issues that reference the document.

A `library:<id>` entry in the files of an issue, and a `[label](library:<id>)`
link in a body, open the Library dialog on that document.

The published viewer (`lpm export --site`) does not show the library.

### The HTTP routes

`src/server/routes/library.ts` serves the dialog:

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/library` | — | `LibraryEntryDto[]`, sorted by id |
| `GET /api/library/:id` | — | `LibraryDocDto` |
| `POST /api/library` | `{ id, title?, description?, body? }` | 201 and the new `LibraryDocDto` |
| `PUT /api/library/:id` | `LibraryDocPatch` | The changed `LibraryDocDto`. 409 when `revision` is stale |
| `POST /api/library/:id/move` | `{ to, updateReferences? }` | `LibraryMoveResultDto`: `moved`, `rewritten` and `stale` |
| `DELETE /api/library/:id` | — | `{ deleted, referencedBy }` |

The id holds `/`, so the client encodes it with `encodeURIComponent`. The
router splits the path before it decodes a segment, so `prd%2Fpayments` stays
one parameter.

## Two people editing one document

Each read of a document returns its revision: the first 16 hex digits of the
SHA-256 digest of the file. The web app and `update_library_document` send the
revision back with a change. When the file holds another revision, the update
fails with a `ConflictError` (HTTP 409) and writes nothing. The Library dialog
then keeps the draft and offers **Reload the document**.

`lpm library set` sends no revision, so the command writes over the file.

## Design decisions

**The library is not a sixth collection.** Issues, periods, resources, squads
and templates share `NodeKind`, a hierarchy, types and statuses. A library
document has none of these, so `load.ts` never reads the library folder, the
board snapshot does not hold it, and a broken library file cannot make a
board invalid.

**A reference is a related file with a prefix.** The prefix `library:` reuses
the field `related_files`. That field already passes through every front end:
`lpm new --related`, `lpm set --related`, the MCP tools `create_document` and
`update_document`, the Files section of the web app, and the placeholder
substitution of `instantiate_template`. A separate frontmatter key needed the
same wiring a second time. `src/shared/library-id.ts` holds the rule for the
prefix and the id, and the engine and the web app import that one module.

**Writes go through `boardWrite`.** Each write takes the board lock. On a board
that `git_sync` shares, the write is committed and pushed, or undone and
refused, as a write to an issue is. Git sync commits every file that the write
changed below the board folder, so the library folder needed no change there.

**The web app writes at once.** A library document is not part of the plan, so
the view holds no queued change for it, in the same way as a comment.

## Known limits

- A rename by hand in the file manager does not rewrite the references. Use
  `lpm library mv`, or run `lpm check` after the rename to list each reference
  that it broke.
- A rename rewrites references in issues and templates only. A context template
  in `.lpm/templates/context/` that names an id in its code keeps the old id.
- The published viewer does not show the library.
- `lpm check --fix` repairs no library finding, because only a person knows
  whether the file or the reference has the wrong name.
