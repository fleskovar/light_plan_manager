/**
 * The layout behind every board.
 *
 * It names no type, no status and no attribute, because it has to work on a
 * board whose hierarchy is `Program › Epic › Feature › Story › Sub-task` and on
 * one whose hierarchy is a single `task`. That is the whole point of it: a
 * board that has never heard of context templates still gets a brief, and it is
 * the brief the requirement asked for — the title and body of the issue's
 * parents, in order, then the issue itself, then the two directions along the
 * graph: what it was sequenced after (and what that work touched) and what is
 * sequenced after it.
 *
 * A board wanting more says so in `.lpm/templates/context/`, where it can name
 * its own types. `lpm instructions --init` writes starters to begin from; this
 * text and `templates/context/default.md` are deliberately the same layout, so
 * ejecting the starters changes nothing until somebody edits them.
 *
 * Note `.length` on the list guards: an empty array is truthy in JavaScript, so
 * `<% if (ancestors) { %>` would always be taken.
 */
export const BUILTIN_CONTEXT_TEMPLATE = `# Working brief: <%= issue.id %> — <%= issue.title %>

<%= issue.type_label %> · <%= issue.status_label %><% if (issue.period) { %> · scheduled in <%= issue.period.title %> (<%= issue.period.starts %> → <%= issue.period.ends %>)<% } %><% if (issue.assignee) { %> · assigned to <%= issue.assignee.title %><% } %>

<% if (issue.flag) { %>
> **This issue is flagged: <%= issue.flag_label %>.** Work on it has stopped and
> somebody is waiting on an answer. Read the work log at the bottom before doing
> anything — the flag is cleared by whoever is running the plan, not by picking
> the work back up.

<% } %>
<% if (ancestors.length) { %>
## Where this sits

Read down. Each level is the reason the next one exists.

<% for (const parent of ancestors) { %>
### <%= parent.type_label %>: <%= parent.title %> (<%= parent.id %>)

<%= heading(parent.body, 4) %>

<% } %>
<% } %>
## The work

### <%= issue.type_label %>: <%= issue.title %> (<%= issue.id %>)

<%= heading(issue.body, 4) %>

<% if (issue.attribute_list.length) { %>
### Fields

<% for (const field of issue.attribute_list) { %>
- **<%= field.label %>**: <%= def(field.value, "—") %>
<% } %>

<% } %>
<% if (related_files.length) { %>
### Files this is about

Open these first. A reference may name a line range, and it may name a file that
does not exist yet — that is usually the point of naming it.

<% for (const ref of related_files) { %>
- \`<%= ref %>\`
<% } %>

<% } %>
<% if (children.length) { %>
### Broken down into

<% for (const child of children) { %>
#### <%= child.title %> (<%= child.id %> · <%= child.status_label %>)

<%= heading(child.body, 5) %>

<% } %>
<% } %>
<% if (blocked_by.length) { %>
## Where this comes from

The work this issue was sequenced after. A finished one is what you are building
on — read it rather than re-deriving it. An unfinished one is a reason to ask,
not a reason to guess.

<% for (const blocker of blocked_by) { %>
- **<%= blocker.id %>** <%= blocker.title %> — <%= blocker.status_label %><% if (blocker.done) { %> (done: build on this)<% } else { %> (**not finished**)<% } %>
<% } %>

<% } %>
<% if (upstream_files.length) { %>
### What that work touched

The files the issues above name. Where they overlap with the files this issue
names, that is the code you are about to change again.

<% for (const trail of upstream_files) { %>
- **<%= trail.issue.id %>**: <%= join(trail.files, ", ") %>
<% } %>

<% } %>
<% if (blocks.length) { %>
## Where this is going

The work sequenced after this one. It is what the thing you build has to be
usable *for* — a shortcut that closes this issue and blocks one of these has not
finished the job.

<% for (const waiting of blocks) { %>
### <%= waiting.title %> (<%= waiting.id %> · <%= waiting.status_label %>)

<%= heading(waiting.body, 4) %>
<% if (waiting.related_files.length) { %>
Expects to touch: <%= join(waiting.related_files, ", ") %>
<% } %>

<% } %>
<% } %>
<% if (comments.length) { %>
## Work log

Read this before you start: somebody may have tried this already, or a reviewer
may have left a requirement that never reached the body.

<% for (const note of comments) { %>
### <%= note.at %> — <%= note.author %>

<%= heading(note.body, 4) %>

<% } %>
<% } %>
`;
