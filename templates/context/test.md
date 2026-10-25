<% /* A test verifies somebody else's acceptance criteria, so the thing it      */ %>
<% /* covers matters more here than the ancestry.                               */ %>
# <%= issue.id %> — <%= issue.title %>

You are picking up a **test** on the **<%= board.name %>** board. It exists to
prove a behaviour, so the behaviour's own definition is what you write against —
not your reading of the code.

Status: <%= issue.status_label %><% if (issue.attributes.test_level) { %> · <%= issue.attributes.test_level %><% } %><% if (issue.attributes.automated) { %> · automated<% } %><% if (issue.period) { %> · <%= issue.period.title %><% } %>

<% if (issue.flag) { %>
> **Flagged: <%= issue.flag_label %>.** Writing this test stopped; the work log
> below says why. Often it is that the behaviour under test is not specified
> precisely enough to assert — which is a finding about the requirement, not
> about the test.

<% } %>
<% if (feature) { %>
## The feature under test: <%= feature.title %> (<%= feature.id %>)

<%= heading(feature.body, 3) %>

<% } %>
<% if (blocked_by.length) { %>
## What it verifies

<% for (const item of blocked_by) { %>
### <%= item.type_label %>: <%= item.title %> (<%= item.id %> · <%= item.status_label %>)

<%= heading(item.body, 4) %>
<% if (item.project_files.length) { %>
Files it names: <%= join(item.project_files, ", ") %>
<% } %>

<% } %>
<% } %>
## The test

<%= heading(issue.body, 3) %>

<% if (project_files.length) { %>
### Files this test is about

The code under test, and the file the test itself belongs in — which may not
exist yet.

<% for (const ref of project_files) { %>
- `<%= ref %>`
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
## How to finish it

- Assert the acceptance criteria above, in their words. A test that passes for a
  different reason than the criterion is worse than no test.
- Make it fail first. A test that has never been red proves nothing.
- Paste the real run into your handover note — the command and its output, not a
  claim about it.
- If the criteria are too vague to assert against, flag it rather than inventing
  an interpretation: `lpm flag <%= issue.id %> --reason help --comment "..."`.
- Record the test file and the code it covers with
  `lpm set <%= issue.id %> --related <path>`.
