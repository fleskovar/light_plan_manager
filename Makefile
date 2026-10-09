# light-plan - developer entry points.
#
# `make` on its own lists everything. The targets that matter day to day:
#
#   make doctor    is my machine ready?
#   make setup     get me from a fresh clone to a working `lpm`
#   make dev       rebuild the CLI and the web app as I edit them
#   make test      run everything
#   make dist      build a publishable tarball
#   make publish   bump the patch, tag and push; GitHub Actions publishes to npm
#
# Two packages live here: the engine and CLI at the root, and the web app under
# web/ with its own node_modules. Every target below knows about both, which is
# the main reason this file exists rather than a longer list of npm scripts.
#
# Targets that produce files depend on their sources, so re-running `make build`
# after no changes does nothing at all.
#
# Recipes are deliberately shell-agnostic, the same rules harness-config-manager
# follows. On Windows make hands recipes to sh when one is on the PATH and to
# cmd.exe when not, and a plain cmd window has no sh. So:
#
#   - every recipe line is one command both shells run the same way;
#   - anything with logic in it is a script under scripts/, run with node;
#   - files are touched and removed through node, never touch or rm;
#   - no comments inside a recipe (cmd runs `#` as a command), and no single
#     quotes, semicolons, ampersands, pipes or redirections in an echo.
#
# Output is plain ASCII: this has to read correctly in a Windows console,
# which is not UTF-8 by default.

# ---------------------------------------------------------------------------
# Configuration

RELEASE_DIR := release
DEMO_DIR    := .demo
DEMO_PREFIX := DEMO
UI_PORT     ?= 4571
# `make dev-web` serves the API here; web/vite.config.ts proxies /api to it.
API_PORT    ?= 4571
# `make site` exports the demo board here and serves it with no API behind it.
SITE_DIR    ?= docs
SITE_PORT   ?= 4572

VERSION := $(shell node -p "require('./package.json').version")
TARBALL := $(RELEASE_DIR)/light-plan-$(VERSION).tgz

# Node one-liners standing in for touch and rm -rf. Double quotes only: they are
# the one kind of quote sh and cmd.exe both strip.
TOUCH  := node -e "require('fs').writeFileSync(process.argv[1], '')"
REMOVE := node -e "for (const p of process.argv.slice(1)) require('fs').rmSync(p, { recursive: true, force: true })"

MAKEFLAGS += --no-print-directory
.DEFAULT_GOAL := help

# `find` behaves differently on every platform this has to run on, so sources
# are discovered with a recursive wildcard in pure Make instead.
rwildcard = $(foreach d,$(wildcard $(1:=/*)),$(call rwildcard,$d,$2) $(filter $(subst *,%,$2),$d))

CORE_SOURCES := $(call rwildcard,src,*.ts) tsconfig.json package.json
WEB_SOURCES  := $(call rwildcard,web/src,*) web/index.html web/package.json \
                web/vite.config.ts web/svelte.config.js web/tsconfig.json
# The viewer is a second bundle of the same sources with its own entry.
VIEWER_SOURCES := $(WEB_SOURCES) web/viewer/index.html web/vite.viewer.config.ts

# Stamps stand in for node_modules, which has no single file whose timestamp
# tracks the install.
ROOT_MODULES := node_modules/.install-stamp
WEB_MODULES  := web/node_modules/.install-stamp
CLI_ENTRY    := dist/cli/index.js
WEB_ENTRY    := web/dist/index.html
VIEWER_ENTRY := web/dist-viewer/index.html

# ---------------------------------------------------------------------------
##@ Getting started

help: ## List the available targets
	@node scripts/help.mjs $(MAKEFILE_LIST)

doctor: ## Check that prerequisites are installed and up to date
	@node scripts/doctor.mjs

setup: $(ROOT_MODULES) $(WEB_MODULES) build link ## Set up the dev environment from a fresh clone
	@echo Done. lpm is on your PATH, and make dev keeps it rebuilding as you edit.

# ---------------------------------------------------------------------------
##@ Development

dev: $(ROOT_MODULES) $(WEB_MODULES) link ## Rebuild the CLI and web app on every change
	@echo Watching src/ and web/src/. lpm picks up each rebuild, reload the browser for the web app. Ctrl-C to stop.
	@node scripts/parallel.mjs watch

# What `lpm export --site` produces, served the way a static host would: no API
# behind it, everything read from one board.json.
site: build demo ## Export the demo board as a static site and serve it
	cd $(DEMO_DIR) && node ../dist/cli/index.js export --site $(SITE_DIR)
	@echo Serving $(DEMO_DIR)/$(SITE_DIR) on http://localhost:$(SITE_PORT). Ctrl-C to stop.
	npx --yes serve --listen $(SITE_PORT) --no-clipboard $(DEMO_DIR)/$(SITE_DIR)

dev-web: $(WEB_MODULES) $(CLI_ENTRY) demo ## Vite dev server with hot reload, against the demo board
	@echo Vite on http://localhost:5173, proxying /api to port $(API_PORT). Ctrl-C to stop.
	@node scripts/parallel.mjs web $(API_PORT) $(DEMO_DIR)

# stdout is the MCP transport, so this only looks idle. Point an agent host at
# it, or drive it with an MCP client.
mcp: build-core demo ## Serve the demo board to an agent over MCP (stdio)
	cd $(DEMO_DIR) && node ../dist/cli/index.js mcp --user "Ada Lovelace"

# Run from the demo board: the server serves the checkout it starts in, and
# this repository has no .lpm of its own.
ui: build demo ## Serve the demo board in a browser
	cd $(DEMO_DIR) && node ../dist/cli/index.js ui --port $(UI_PORT)

demo: $(CLI_ENTRY) ## Create a throwaway board in .demo to test against
	@node scripts/demo.mjs $(DEMO_DIR) $(DEMO_PREFIX)

link: $(CLI_ENTRY) ## Put `lpm` on your PATH (npm link)
	@npm link

unlink: ## Take `lpm` off your PATH
	-@npm unlink -g light-plan
	@echo lpm unlinked.

# ---------------------------------------------------------------------------
##@ Building

build: $(CLI_ENTRY) $(WEB_ENTRY) $(VIEWER_ENTRY) ## Compile the engine, the CLI, the web app and the viewer

build-core: $(CLI_ENTRY) ## Compile only src/ to dist/

build-web: $(WEB_ENTRY) ## Bundle only the web app to web/dist/

build-viewer: $(VIEWER_ENTRY) ## Bundle only the read-only viewer to web/dist-viewer/

$(CLI_ENTRY): $(ROOT_MODULES) $(CORE_SOURCES)
	@npm run build

$(WEB_ENTRY): $(WEB_MODULES) $(WEB_SOURCES)
	@cd web && npm run build

$(VIEWER_ENTRY): $(WEB_MODULES) $(VIEWER_SOURCES)
	@cd web && npm run build:viewer

$(ROOT_MODULES): package.json package-lock.json
	@npm install
	@$(TOUCH) $@

# `npm --prefix web install` reads the root package.json and ends up installing
# this package into web/. Always cd instead.
$(WEB_MODULES): web/package.json web/package-lock.json
	@cd web && npm install
	@$(TOUCH) $@

# ---------------------------------------------------------------------------
##@ Quality

test: test-core test-web ## Run every test suite

test-core: $(ROOT_MODULES) ## Engine, CLI and API tests
	@npm test

test-web: $(WEB_MODULES) ## Web app unit tests
	@cd web && npm run test

test-watch: $(ROOT_MODULES) ## Re-run engine tests as you edit
	@npm run test:watch

typecheck: $(ROOT_MODULES) $(WEB_MODULES) ## Typecheck both packages
	@npm run typecheck
	@cd web && npm run typecheck

assets: $(CLI_ENTRY) ## Validate the shipped assets, the harness mappings and the hcm bundles
	@node scripts/check-assets.mjs

# Build before testing: test/export.test.ts skips its --site cases unless
# web/dist-viewer exists, and CI is where they have to run.
verify: typecheck build assets test ## Everything a pull request should pass
	@echo All checks passed.

# The stamps are written after each `npm ci`, or verify would find them missing
# and run a second, unpinned `npm install` over the lockfile install.
ci: ## Reproducible install, then verify. What CI should run
	@npm ci
	@$(TOUCH) $(ROOT_MODULES)
	@cd web && npm ci
	@$(TOUCH) $(WEB_MODULES)
	@$(MAKE) verify

outdated: ## Show dependencies with newer releases
	@echo Root
	-@npm outdated
	@echo Web
	-@cd web && npm outdated

# ---------------------------------------------------------------------------
##@ Packaging

dist: clean-release build ## Build a publishable tarball in release/ and check its contents
	@node scripts/pack.mjs $(RELEASE_DIR)

dist-contents: ## List what the tarball would contain, without building one
	@npm pack --dry-run

# A release is a pushed version tag: .github/workflows/publish.yml verifies,
# packs and publishes it. This bumps the patch (or releases a minor or major a
# developer set and nobody has tagged yet), commits, tags and pushes both.
publish: ## Bump the patch, commit, tag and push; GitHub Actions publishes to npm
	@node scripts/release.mjs publish

# The patch is make publish's; the minor and major are a developer's decision.
# These commit the new version without tagging it, and make publish releases it.
version-minor: ## Start the next minor version (commits, does not tag or publish)
	@node scripts/release.mjs bump minor

version-major: ## Start the next major version (commits, does not tag or publish)
	@node scripts/release.mjs bump major

# Publishing from a laptop rather than CI. Deliberately awkward: it cannot be
# undone, so it must never happen because someone mistyped a target name.
# CONFIRM is checked before anything else runs; then the full verify, then the
# tarball. The ./ matters: npm reads a bare `release/x.tgz` as a GitHub repository.
publish-local: ## Verify, build and publish this version from here (needs CONFIRM=yes)
ifneq ($(CONFIRM),yes)
	$(error This publishes light-plan $(VERSION) to the public npm registry, which cannot be undone. Re-run with: make publish-local CONFIRM=yes)
endif
	@$(MAKE) verify
	@$(MAKE) dist
	npm publish ./$(TARBALL)

# ---------------------------------------------------------------------------
##@ Housekeeping

clean: ## Remove build output
	@$(REMOVE) dist web/dist web/dist-viewer $(wildcard *.tsbuildinfo)
	@echo Removed build output.

clean-release: ## Remove packaged tarballs
	@$(REMOVE) $(RELEASE_DIR)

clean-demo: ## Remove the throwaway demo board
	@$(REMOVE) $(DEMO_DIR)

clean-all: clean clean-release clean-demo ## Also remove node_modules
	@$(REMOVE) node_modules web/node_modules
	@echo Removed dependencies. Run make setup to start again.

fresh: clean-all setup ## Wipe everything and set up again

.PHONY: help doctor setup dev dev-web ui site mcp demo link unlink \
        build build-core build-web build-viewer \
        test test-core test-web test-watch typecheck assets verify ci outdated \
        dist dist-contents publish publish-local version-minor version-major \
        clean clean-release clean-demo clean-all fresh
