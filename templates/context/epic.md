<% /* An epic is the level where "why" still lives. Its brief is for planning   */ %>
<% /* and for orientation, not for picking work up.                            */ %>
# <%= issue.id %> — <%= issue.title %>

This is an **epic** on the **<%= board.name %>** board — a body of work, not a
task. Use it to understand what the pieces underneath are for.

Status: <%= issue.status_label %><% if (issue.attributes.owner) { %> · owner <%= issue.attributes.owner %><% } %><% if (issue.attributes.priority) { %> · priority <%= issue.attributes.priority %><% } %><% if (issue.attributes.target_release) { %> · targets <%= issue.attributes.target_release %><% } %>

<% if (program) { %>
## Programme: <%= program.title %> (<%= program.id %>)

<%= heading(program.body, 3) %>

<% } %>
## The epic

<%= heading(issue.body, 3) %>

<% if (project_files.length) { %>
## Where it lands

The parts of the codebase this epic is about. At this level they are a sketch of
the blast radius, not an instruction — the stories underneath name the files that
actually change.

<% for (const ref of project_files) { %>
- `<%= ref %>`
<% } %>

<% } %>
<% if (children.length) { %>
## What is under it

<% for (const child of children) { %>
### <%= child.type_label %>: <%= child.title %> (<%= child.id %> · <%= child.status_label %>)

<%= heading(child.body, 4) %>

<% } %>
<% } %>
<% if (descendants.filter((child) => child.flag).length) { %>
## Stopped underneath it

Work inside this epic that somebody picked up and flagged. Each one is waiting on
a decision from whoever is running this plan — that is probably you.

<% for (const child of descendants.filter((child) => child.flag)) { %>
- **<%= child.id %>** <%= child.title %> — <%= child.flag_label %><% if (child.assignee) { %>, raised by <%= child.assignee.title %><% } %>
<% } %>

Read why with `lpm comment <id> --list`, and clear one with
`lpm flag clear <id> --comment "..."` once it can go on.

<% } %>
<% if (blocked_by.length) { %>
## Where this comes from

<% for (const blocker of blocked_by) { %>
- **<%= blocker.id %>** <%= blocker.title %> — <%= blocker.status_label %><% if (blocker.done) { %> (done)<% } else { %> (**not finished**)<% } %>
<% } %>

<% } %>
<% if (blocks.length) { %>
## Where this is going

<% for (const waiting of blocks) { %>
- **<%= waiting.id %>** <%= waiting.title %> — <%= waiting.status_label %>
<% } %>

<% } %>
<% if (docs.length) { %>
## Library documents

The board library holds these documents, and this issue or the work above it
references them. Read them before you start.

<% for (const doc of docs) { %>
<% if (doc.missing) { %>
### `<%= doc.ref %>` (not in the library)

<%= doc.referenced_by.id %> references this document, and the library does not
hold it. Ask whoever runs the plan where it went.

<% } else { %>
### <%= doc.title %> (`<%= doc.ref %>`, referenced by <%= doc.referenced_by.id %>)

<% if (doc.description) { %>
<%= doc.description %>

<% } %>
<%= heading(doc.body, 4) %>

<% } %>
<% } %>
<% } %>
<% if (comments.length) { %>
## Work log

<% for (const note of comments) { %>
### <%= note.at %> — <%= note.author %>

<%= heading(note.body, 4) %>

<% } %>
<% } %>
