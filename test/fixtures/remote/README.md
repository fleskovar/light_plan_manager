# Remote provider fixtures (LP-267)

These files are the evidence behind `docs/remote-capabilities.md`. They were
produced by LP-267 (research: what GitHub, Jira Cloud and Linear can express
against a light-plan board).

## Provenance — read this before trusting any of it

LP-267's method called for *empirical* capture: a scratch account on each
platform, `curl` against the real endpoints, and the actual response bodies
saved here as replay fixtures. **That half could not be completed in this
environment** — no API tokens or scratch accounts were available.

**Jira is no longer in that position.** `test/remote-live-jira.test.ts` runs
end to end against a real Cloud project, so the remaining Jira items below are
now a question of somebody capturing them, not of access. What that suite
already establishes — creation, the status transition, both hierarchy carriers,
link direction, sprint scheduling, deletion and the absence-detection path — is
recorded as `observed` in `docs/remote-capabilities.md` rather than duplicated
here as fixtures: it is asserted against the live platform on every run, which
a saved body cannot be.

What is here instead is the second-best evidence: the **provider's own machine
specification**, fetched at research time and reduced to the fragments that
each claim in the capability matrix rests on:

| File | Source (fetched live) |
| --- | --- |
| `github-openapi-fragments.json` | GitHub REST OpenAPI description (`github/rest-api-description`, `api.github.com.json`) |
| `github-graphql-fragments.graphql` | GitHub GraphQL schema (`octokit/graphql-schema`, `schema.graphql`) |
| `jira-swagger-fragments.json` | Atlassian Jira Cloud REST v3 OpenAPI (`swagger-v3.v3.json`) |
| `linear-graphql-fragments.graphql` | Linear GraphQL SDK schema (`linear/linear`, `schema.graphql`) |

Each fragment file carries a `_source` / `_note` field saying so. Nothing here
is a captured HTTP response body; where `docs/remote-capabilities.md` quotes a
status code or an error message, it is quoting the provider's *documentation*,
not an observation.

## What still needs empirical verification

The lifecycle half of the research is the part where a wrong assumption costs
somebody their board, and it is the part that remains **unverified**:

- GitHub: what exactly `GET /repos/{o}/{r}/issues/{n}` returns after a
  GraphQL `deleteIssue` (404 vs 410) and after a `transferIssue` (301 vs 404),
  and whether a narrowed token sees 404 or 403 for a private repo it cannot
  read.
- Jira: the exact `errorMessages` body of the 404 on `GET /rest/api/3/issue/{id}`
  after deletion vs after a permission loss, and whether `GET` by the old key
  after a bulk move still resolves (the spec says it does).
- Linear: whether a trashed issue is resolvable through the `issue` query at
  all, or only through `issueSearch`/admin surfaces, and what a token without
  a team sees for an issue in that team.

The candidate for "the one that matters most" is unchanged from the ticket:
the **404-versus-403 cell**. All three providers appear to return "not found"
(404, or GraphQL `null`) for both "deleted" and "exists but you may not see
it". If that holds empirically, no per-issue check can tell the two apart and
LP-364's bulk reachability heuristic is the *only* defence, not a backstop.

## How to complete this

When scratch accounts exist, replace these fragments with real captures:
one directory per provider (`github/`, `jira/`, `linear/`), one file per
operation (`delete.json`, `get-after-delete.json`, `archive.json`, …), each
recording the full response status + body + headers that matter
(`Location`, `X-RateLimit-*`). Keep the provenance note in each file so a
future reader can tell a captured response from a quoted one.
