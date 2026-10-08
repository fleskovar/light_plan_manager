<% /* A feature is usually a container, so its brief is a plan of what is under */ %>
<% /* it rather than a task to start.                                          */ %>
# <%= issue.id %> — <%= issue.title %>

This is a **feature** on the **<%= board.name %>** board. If it has children below
it, it is a container: the work is theirs, and this brief is here so you can see
the whole shape before picking one up.

Status: <%= issue.status_label %><% if (issue.attributes.priority) { %> · priority <%= issue.attributes.priority %><% } %><% if (issue.period) { %> · <%= issue.period.title %><% } %>

<% if (program) { %>
## Programme: <%= program.title %> (<%= program.id %>)

<%= heading(program.body, 3) %>

<% } %>
<% if (epic) { %>
## Epic: <%= epic.title %> (<%= epic.id %>)

<%= heading(epic.body, 3) %>

<% } %>
## The feature

<%= heading(issue.body, 3) %>

<% if (related_files.length) { %>
## Where it lands

The parts of the codebase this feature is about. The stories under it name the
files that actually change; this is the shape of the area they are in.

<% for (const ref of related_files) { %>
- `<%= ref %>`
<% } %>

<% } %>
<% if (descendants.filter((child) => child.flag).length) { %>
## Stopped underneath it

Work inside this feature that somebody picked up and flagged. Each is waiting on
a decision rather than on more effort.

<% for (const child of descendants.filter((child) => child.flag)) { %>
- **<%= child.id %>** <%= child.title %> — <%= child.flag_label %><% if (child.assignee) { %>, raised by <%= child.assignee.title %><% } %>
<% } %>

`lpm comment <id> --list` says why; `lpm flag clear <id> --comment "..."` lets it
go on.

<% } %>
## What is under it

<% if (children.length) { %>
<% for (const child of children) { %>
### <%= child.type_label %>: <%= child.title %> (<%= child.id %> · <%= child.status_label %>)

<%= heading(child.body, 4) %>

<% } %>
<% } else { %>
Nothing yet. This feature has no children, so nothing under it can be picked up —
break it into stories before anyone can start.

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
<% if (comments.length) { %>
## Work log

<% for (const note of comments) { %>
### <%= note.at %> — <%= note.author %>

<%= heading(note.body, 4) %>

<% } %>
<% } %>
