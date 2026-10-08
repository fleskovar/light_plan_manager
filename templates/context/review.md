<% /* A review is a gate, not a task: what it covers is in `depends_on`.        */ %>
# <%= issue.id %> — <%= issue.title %>

You are picking up a **review gate** on the **<%= board.name %>** board. Nothing
downstream moves until this says yes or no. Your job is a judgement, not a
change.

Status: <%= issue.status_label %><% if (issue.attributes.decision) { %> · decision <%= issue.attributes.decision %><% } %><% if (issue.attributes.reviewer) { %> · reviewer <%= issue.attributes.reviewer %><% } %>

<% if (issue.flag) { %>
> **Flagged: <%= issue.flag_label %>.** The review stopped without a decision;
> the work log below says why. A gate that is stuck is holding everything under
> "What it is holding up" — deal with the flag before anything else here.

<% } %>
<% if (feature) { %>
## What it belongs to: <%= feature.title %> (<%= feature.id %>)

<%= heading(feature.body, 3) %>

<% } %>
## The gate

<%= heading(issue.body, 3) %>

<% if (related_files.length) { %>
### What to read to decide

<% for (const ref of related_files) { %>
- `<%= ref %>`
<% } %>

<% } %>

## What is being reviewed

<% if (blocked_by.length) { %>
<% for (const item of blocked_by) { %>
### <%= item.type_label %>: <%= item.title %> (<%= item.id %> · <%= item.status_label %>)

<%= heading(item.body, 4) %>
<% if (item.related_files.length) { %>
Files: <%= join(item.related_files, ", ") %>
<% } %>

<% } %>
<% } else { %>
Nothing is listed in `depends_on`, so this gate does not say what it covers.
Ask before approving it — an empty review is a rubber stamp.

<% } %>
<% if (blocks.length) { %>
## What it is holding up

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
## How to finish it

- Check against the approval criteria in the body, one at a time, and say which
  ones you actually verified.
- Record the decision on the issue: outcome, date, and what you looked at.
- `changes_requested` needs the changes named specifically enough to act on.
- Anything the review uncovers that is not a blocker goes on the board as its
  own issue rather than into the decision note.
- If you cannot decide — you need somebody else's judgement, or the thing under
  review is not finished enough to look at — flag the gate rather than sitting on
  it: `lpm flag <%= issue.id %> --reason help --comment "..."`. Everything under
  "What it is holding up" is waiting on you, and silence looks the same as work.
