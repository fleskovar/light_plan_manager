# light-plan as hcm bundles

[hcm](https://www.npmjs.com/package/harness-config-manager) installs agent
configuration (subagents, skills, MCP servers, instruction sections) from
*bundles* into any harness, and can roll each item back. `lpm hcm` hands
light-plan's agents and skills to hcm, so a project gets them with
`hcm install light-plan` rather than `lpm agent`.

Both commands install the same files. Use `lpm agent` for a quick install into
one project. Use hcm when you already manage your agent configuration with it,
or when you want `hcm update` and `hcm status` across many projects.

## Commands

| Command | What it does |
| --- | --- |
| `lpm hcm init` | Renders every bundle, then runs `hcm registry add` on them. Run it again after each upgrade of light-plan; the registry entry keeps its id. |
| `lpm hcm init --dev` | The same, registered with `--dev`: hcm reads the rendered folder in place and keeps no copy, so `hcm update` lands an edit without a version bump. For working on `assets/` in a checkout. |
| `lpm hcm build --dir <path>` | Renders the bundles into `<path>` and registers nothing. Nothing in a render depends on the machine, so the result can be committed and published (`hcm registry add owner/repo/path#v1.2.0`). |
| `lpm hcm remove` | Runs `hcm registry remove` for each bundle. |

`--dir` moves where `init` writes. The default is the per-user data folder:

| Platform | Folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\light-plan\hcm` |
| macOS | `~/Library/Application Support/light-plan/hcm` |
| Linux | `$XDG_DATA_HOME/light-plan/hcm`, else `~/.local/share/light-plan/hcm` |

## Running it through npx

The package is `light-plan` and its command is `lpm`. On npm, `lpm` is the name
of an unrelated package, so:

```bash
npx light-plan hcm init        # from anywhere: npx fetches light-plan
npx --no lpm hcm init          # in a project that has light-plan as a dependency
```

`--no` stops npx from downloading the other `lpm` when this one is not
installed. Both forms are safe for `hcm update` later, because `init` never
registers the package folder (see the design below).

The bundle's MCP server file starts the server as `lpm mcp`, so the agents need
`lpm` on their PATH whichever way `init` was run. `init` warns when it is not
there: `npm install -g light-plan` fixes it.

## What is in the bundle

`assets/hcm/light-plan.yml` declares it:

| Bundle path | From |
| --- | --- |
| `subagents/<name>.md` | `assets/agents/<name>.md` — `description`, `tools` |
| `skills/<name>/SKILL.md` | `assets/skills/<name>.md` — `description` |
| `context/10-light-plan.md` | the pointer block `lpm agent` writes for Copilot, listing the assets every flavor installs |
| `mcp/light-plan.json` | `assets/hcm/light-plan/mcp/light-plan.json`, copied byte for byte — the `light-plan` server, started as `lpm mcp` |
| `hcm.yaml` | the mapping's `description`, `tags`, `flavors`; the package's `version`, `author`, `homepage` |

Each asset's `roles` become its hcm `flavors`, so the roles of `lpm agent
--type` are the flavors of `hcm install --flavor`:

```bash
hcm install light-plan -t claude-code                    # both roles
hcm install light-plan -t claude-code --flavor developer # lpm agent --type developer
hcm install light-plan -t copilot --flavor pm            # lpm agent --type pm
```

## Design

**The bundle is rendered, never kept.** `assets/` is the only copy of the
agents and skills. A committed `hcm-bundle/` would be a second copy that a
person has to keep in step. Instead, a bundle mapping is the same list of copy
rules as a harness mapping (`ruleSchema`, placed by `placementsFor`), plus the
manifest fields a person chooses. Fields that are not a choice come from the
package: the version, so the bundle cannot claim a different release.

**What belongs to one bundle ships as a file.** A file that belongs to a bundle
and to no harness sits in `assets/hcm/<name>/`, and the render copies it into
the bundle byte for byte. The MCP server file is the one there now. It is a
file, not generated, so it can be read in the package, and it names `lpm`
rather than a path on one machine, as an hcm bundle should. Its name is the
server name, `light-plan`, which is also the prefix of every MCP tool in the
agents' `tools` lists (`mcp__light-plan__*`); `test/hcm.test.ts` holds the two
together. The folder may not ship `hcm.yaml` or the context file, because the
render writes those.

**The bundle lives in a folder light-plan owns.** `hcm update` reads the
registered folder again. A package run through npx lives in npm's cache, which
npm clears when it likes. A rendered folder in the per-user data directory
survives, whichever way `lpm` was started. A re-render replaces the bundle
folder, so a file deleted from `assets/` leaves the bundle too. A folder that
holds files but no `hcm.yaml` is refused, not emptied.

**hcm is a command, not a library.** `lpm hcm` runs `hcm` as a subprocess, and
never writes hcm's registry itself. It also never runs from an install hook:
registering changes a home folder, so it waits for somebody to ask.

**One folder, every bundle.** `init` renders every `assets/hcm/*.yml` into one
folder, and one `hcm registry add` registers each bundle in it. To ship a
second bundle, add a mapping file.

## Adding to a bundle

- **A new agent or skill** in `assets/agents/` or `assets/skills/` is in the
  bundle already, because the rules select those directories.
- **A new kind of asset** needs a rule in `assets/hcm/light-plan.yml`, the same
  as in each harness mapping. A rule that matches nothing is an error.
- **A file only the bundle carries** — an MCP server, a settings fragment, a
  command — goes in `assets/hcm/<name>/`, at the path it has in the bundle.
- **A new bundle** is a file `assets/hcm/<name>.yml`. Its `name` must match the
  file name.

Check the result with:

```bash
lpm hcm build --dir /tmp/lpm-hcm
hcm validate /tmp/lpm-hcm/light-plan
hcm refs check --path /tmp/lpm-hcm/light-plan
```

`test/hcm.test.ts` runs both hcm checks when `hcm` is installed.

## Testing with hcm

`HCM_HOME` moves hcm's registry, so a test never touches the real one:

```bash
export HCM_HOME="$(mktemp -d)"
lpm hcm init --dir "$(mktemp -d)"
hcm registry list --json                     # light-plan, at the package version
cd "$(mktemp -d)" && hcm install light-plan -t claude-code --no-prompt
```

Do not use `-s user` in a test: `HCM_HOME` does not move the harness folders,
so a user-scope install writes into the real `~/.claude/`.
