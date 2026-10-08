import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as gitCommand from './git.js';
import {
  BoardError,
  currentUser,
  ensureLocalIgnored,
  findBoardPaths,
  hasRemotes,
  loadBoard,
  loadConfig,
  remoteNamed,
  remoteNames,
  remotesOffNames,
  subtreeOf,
  turnRemoteOn,
  turnRemotesOff,
} from '../../core/index.js';
import {
  addRemote,
  allConnectionFlags,
  applyInspectAnswers,
  connectionExample,
  inspectRemoteConnection,
  applyRebase,
  appendResolveAudit,
  assessMappingChange,
  attributeDefsOf,
  buildConnector,
  clearTombstone,
  computeRemoteStatus,
  connectionFlags,
  corrections,
  credentialStates,
  mappingClaims,
  buildLedger,
  planPrerequisites,
  isSatisfied,
  conflicts,
  ownerOf,
  requireUnclaimed,
  describeTarget,
  connectionKeyNames,
  decoupleLink,
  loadLinkStore,
  splitPushSelection,
  loadMappingSnapshot,
  loadResolutions,
  lookupProvider,
  hasCorrections,
  hasUnresolved,
  openRemote,
  ownIdOfManagedBlock,
  periodIndexOf,
  planAdoption,
  readSyncAudit,
  reconcileMapping,
  recordDocumentResolution,
  recordFieldResolution,
  registeredProviders,
  removeLink,
  removeRemote,
  rosterOf,
  runSync,
  saveLinkStore,
  saveMappingSnapshot,
  saveResolutions,
  secretKeyNames,
  setLink,
  summarizeRemotes,
  trackedFields,
  updateBase,
  updateRemoteConnection,
  updateRemoteMapping,
  writeCredential,
  type AdoptRefusal,
  type ConnectionFlag,
  type ConsentRefusal,
  type ConsentRequest,
  type CredentialState,
  type MappingCorrections,
  type OpProgress,
  type PullPlan,
  type PullResult,
  type PushExecutionResult,
  type RebaseReport,
  type AddRemoteResult,
  type ConnectionCandidate,
  type ConnectionQuestion,
  type InspectReport,
  type ReconcileBlock,
  type ReconcileReport,
  type ResolutionOwner,
  type RunSyncResult,
  type SyncAuditEntry,
} from '../../remote/index.js';
import {
  pendingAhead,
  remoteStatusExitCode,
  summarizePushFailures,
  type RemoteStatusReport,
} from '../../shared/index.js';
import { toSnapshot } from '../../sync/dto.js';
import { ask, choose, confirm } from '../prompt.js';
import { noBoardFound, requireBoard } from '../context.js';
import { bold, cyan, dim, err, green, out, pad, plural, red, yellow } from '../ui.js';
import type { BoardConfig, BoardPaths, LoadedBoard } from '../../core/index.js';
import type { OpenedRemote } from '../../remote/index.js';
import type { Ledger } from '../../remote/ledger.js';
import type { BoardView } from '../../shared/plans/reading.js';

/**
 * `lpm remote` — the remotes a board mirrors, and the sync that keeps them in
 * step. Each story adds its subcommand as it lands: `rebase` (LP-371) brings
 * base snapshots back in step after a mapping change; `status` (LP-342)
 * reports per-document drift with an exit code CI can use; `resolve` (LP-287)
 * settles the conflicts a three-way merge reports; `log` (LP-352) reads the
 * sync audit log back — the record of every applied sync.
 */
export const help = `Mirror a board onto a tracker: connect once, then push and pull what you choose.

To share the board itself through its git repository instead — every change
pulled before and pushed after — see \`lpm git\` (also spelled \`lpm remote git\`).
A board does one or the other, never both.

Usage
  lpm remote                           List the declared remotes, and what each holds
  lpm remote connect [<provider>] [--name <n>] [--<key> <value>...] [--scope <id>] [--force]
                                       Connect this board to a tracker: declare it, take the
                                       credential, and set the mapping against the live remote
  lpm remote push [<id>...|--all] [--children] [--recursive] [--dry-run] [--yes]
                                       File the documents named — issues, or a period (a sprint)
                                       — or --all for everything this remote mirrors, which is
                                       everything that changed. It asks about the work inside,
                                       and creates the vocabulary the mapping needs (labels)
  lpm remote pull [<key>|<id>...] [--parent <id>] [--changed] [--dry-run]
                                       Refresh every mirrored document and bring in anything new
                                       — or name remote keys to import just those
  lpm remote sync [<id>] [--dry-run] [--changed] [--limit N] [--yes]
                                       Pull, then push (the git pull --rebase && git push order)
  lpm remote status [<name>] [--verbose] [--json] [--local] [--changed]
                                       Report drift per document: ahead, behind, conflicted,
                                       unlinked, incoming, orphaned. Exit 0 in sync, 1 drifted,
                                       2 conflicted. --local skips the remote half and answers at
                                       once from the board and the link store; --changed asks the
                                       tracker only for what moved since the last sync
  lpm remote ledger [<name>] [--unlinked]
                                       Which remote holds each document, and what it is called
                                       there. A document belongs to one remote at a time

Less often, and what \`connect\` is made of
  lpm remote add <name> --provider <p> [--<key> <value>...] [--scope <id>] [--force]
  lpm remote login <name> [--key <k>]  Store a credential in .lpm/credentials.json (asks, or reads stdin)
  lpm remote setup [<name>] [--dry-run]
                                       Check the credential, ask the remote for its own type and
                                       status names, and correct the mapping to match
  lpm remote rm <name> [--purge]
  lpm remote off [<name>...]           Turn mirrors off, keeping everything about them
  lpm remote on <name>                 Turn a mirror back on, carrying on where it stopped
  lpm remote log [<name>] [--since <iso>] [--json]
                                       Read the sync audit log back — the record of every applied sync
  lpm remote resolve <id> [--local|--remote] [--field <f> --local|--remote]...
                                       Record a decision; the next sync applies it
  lpm remote link <name> <id> <key> [--repoint] [--dry-run]
                                       Adopt an existing remote issue into a document
  lpm remote unlink <name> <id> [--dry-run]
                                       Drop a link without decoupling
  lpm remote decouple <id> [--reason manual|out_of_scope]
                                       Drop the link and never re-file this document
  lpm remote relink <id>               Clear the tombstone so the next push files it
  lpm remote rebase <name> [--dry-run] Re-read both sides after a mapping change

Any subcommand may be written with the remote's name first, which reads the way
somebody thinks of it: \`lpm remote jira push LP-12\` is \`lpm remote push jira
LP-12\`.

Subcommands
  (none)    List each declared remote with its provider, target, direction and
            last sync. With none declared, explains how to connect one.
  connect   The one command between a board and a tracker, and the place to
            start. Asks for what it cannot work out — which tracker, where the
            project is, the credential — then declares the remote, stores the
            secret in .lpm/credentials.json, asks the remote for its own type
            and status names and corrects the mapping to match, and names what
            to push next. Nothing about it is required on the command line.
            Every question can be answered ahead of time with a flag (the
            credential excepted, which is never on a command line), so a run
            with all of them answered asks nothing. It is a wizard over
            \`add\` + \`login\` + \`setup\`, which stay for a script and a CI job
            that have nobody to ask.
  ledger    Where each document is filed: the remote that holds it and the key
            it has there, read off the link stores themselves. A document is
            mirrored by one remote at a time; one that has ended up in two
            stores (a hand edit, a merge) is reported here and exits 1.
            --unlinked also lists the documents nothing mirrors yet.
  add       Declare a remote, writing the remotes: block into .lpm/config.yml
            without disturbing the rest of the file. The provider's required
            connection keys are flags, validated by the provider's own schema
            before anything is written:
${providerFlagHelp()}
            Secret keys (a token, an api key) are never flags — they resolve
            at sync time from the environment or \`lpm remote login\`. A name
            that already exists is refused unless --force.
  setup     The remote half of \`connect\`, on its own: the command to re-run
            whenever the pairing changes — a new credential, a renamed status
            upstream, a board that grew a column. Reports which credentials are
            already resolvable
            and, for each that is not, where to create it and how to hand it
            over. Then — read-only on the remote — asks the target for its own
            issue type and status names and reconciles the mapping against them:
            a name the remote spells differently is corrected in config.yml, and
            a name it does not have at all is reported next to the list of the
            ones it does. Finally reports what the remote has not got that the
            mapping names, split by who makes it: the vocabulary (labels,
            Project fields) the next push creates for itself, and the periods
            it does not — a push of work never files the timeline, so those are
            listed as something to push when you want them. Exits 1 while
            anything is still unanswered, so CI can gate on a remote being
            set up.
            --dry-run reports without touching config.yml.
  rm        Remove a remote's declaration from config.yml. The per-remote state
            (link store, caches, audit log) is kept unless --purge, which also
            deletes .lpm/remotes/<name>/.
  off       Turn a remote off without losing it: its declaration moves from
            remotes: to remotes_off: in config.yml, and its link store,
            mapping, audit log and credentials are left exactly as they are.
            Nothing syncs with it until it is turned on. With no name, every
            remote. \`lpm git setup --turn-off-remotes\` does this for you when
            the board moves to git sharing.
  on        Turn a turned-off remote back on. The next sync carries on from
            the last one, so whatever changed meanwhile is ordinary drift.
            Refused while the board is shared through git — \`lpm git off
            --turn-on-remotes\` swaps back in one step.
  push      Plan the local -> remote changes and apply them, or render the plan
            with --dry-run.  Runs the push preflight first: an unmappable value
            is an error and refuses the push rather than dropping the field.
            Then it creates whatever the remote must own before the plan can
            land — labels it does not define, sprints the timeline names,
            Projects v2 fields a status needs — and reports each one. None of
            that is a decision: it is all implied by the mapping, which is why
            it is not a command of its own.
            Given document ids it files just those. The remote is the one that
            already holds each of them (the ledger answers, so nobody types a
            name twice), or — for a document nothing holds yet — the only one
            declared, the one --remote names, or the one you pick. A document
            with unmirrored work inside it asks how much to take: all of it,
            one level, or just the document. --children and --recursive answer
            that for a script; with no terminal only what was named is filed.
            Filing part of a plan is expected: a parent that is not there yet
            means the document files at the top level and the push that files
            the parent moves it, and a dependency whose other end is missing is
            written when that end arrives.
  pull      Plan the remote -> local changes and apply them, or render the plan
            with --dry-run.  A remote that cannot be reached writes nothing —
            an expired credential never becomes a wave of deletions.  Given
            remote keys (PAY-31, acme/payments#418) it fetches just those and
            creates the documents for any the board does not have — which is
            how work that started life on the tracker gets onto the board;
            --parent says where such a document lands. Given a document id on
            this board it narrows to that subtree instead.
            Existence is only reconciled against a listing that claimed to be
            complete: a targeted pull, and an ordinary incremental one, never
            close, delete or unlink a twin for being absent. --changed is
            that cheaper, incremental listing, for a remote big enough to want
            it; the default lists everything and is what detects a deletion.
  sync      Pull first, then push, so remote edits merge before local ones are
            written over them.  With several remotes and no name, every remote
            is run in order and a failure on one does not stop the next.
  status    For each document, report the drift between the board, the base
            snapshot and the remote side (LP-342): ahead (local edits not yet
            pushed), behind (remote edits not yet pulled), conflicted (both
            sides edited), unlinked (never pushed), incoming (in the tracker
            with no document here yet) and orphaned (linked, but the document
            is gone). Incoming is the only bucket not keyed by a local id,
            because there is no local document: it is work somebody added
            upstream, and \`lpm remote pull\` adopts it under the twin of its
            remote parent. --verbose adds each document's differing fields with
            their local, remote and base values; --json emits the same report
            through the DTO in src/shared. The exit code is 0 in sync, 1 when
            drifted, 2 when conflicted, so CI can fail a push that left the
            tracker behind. Read-only: nothing is written, on either side. With
            no credentials the local half is still reported and the remote half
            says why it is missing. The remote half is one paginated listing,
            not one request per twin; --changed narrows it to what moved since
            the last sync's cursor, which is cheaper but can say nothing about
            what is absent, so incoming and unreadable stand down for it.
  log       Read the sync audit log back (LP-352), most recent first: when
            each applied sync ran, who drove it, and what it landed or failed.
            --since keeps only runs at or after a timestamp; --json emits the
            entries as JSON for a script. Read-only: the log is a record, and
            this command only reads it. A dry run is never logged — it wrote
            nothing, and the log records what a sync did.
  resolve   Record how one conflict is settled. \`--local\` means the board wins
            (pushed on the next sync), \`--remote\` the remote (written locally).
            \`--field <name> --local|--remote\` settles one field at a time; the
            un-named fields follow the whole-document \`--local\`/\`--remote\`
            when one is given. Resolving never makes a request — it records the
            decision and the next sync applies it.
  link      Adopt an existing remote issue into an existing document (LP-367).
            Records a correspondence in the link store and seeds the base
            snapshot from the remote's current values; neither document is
            written. The next sync reconciles the difference. Refuses a document
            that is already linked (unless --repoint) and a remote issue already
            linked to another document. When the issue's managed block names a
            different local id, that pairing is offered as a suggestion.
  unlink    Drop a link with no tombstone, so the document is an ordinary
            unlinked document again and the next push may re-file it. The
            mirror of \`link\`: use \`decouple\` to also record "never re-file".
  decouple  Drop the link for one document and record a tombstone, so no later
            sync re-files it (LP-366). The remote twin is left alone. Offline:
            nothing is written to the remote, and nothing is deleted upstream.
  relink    Undo a decouple: clear the tombstone so the document is an ordinary
            unlinked document again and the next push files it. Offline.
  rebase    Re-read both sides under the new mapping and rewrite each base
            from the values that actually agree, never from what local says
  login     Store a credential for one remote in the git-ignored
            .lpm/credentials.json (LP-295), written owner-only. At a terminal
            it asks for each credential key the provider declares — Jira's
            email and its API token in the one command — with echo off, and a
            bare Enter keeps a value that already resolves. Piped, it reads one
            value from stdin, landing under the provider's own secret key: the
            only one it declares, or \`token\` when it declares several. --key
            names one explicitly, and is the only way to choose when piping.
            The value is never a flag either way, so it stays out of shell
            history, and it is never echoed back.

Options
      --key <k>     (login) Which connection key this credential is
      --remote <n>  (push, pull, sync) Which declared remote to act on
      --provider <p> (push, pull, sync) The declared remote using this provider
      --children    (push) Also file the direct children of the documents named
      --recursive   (push) Also file everything nested inside them
      --parent <id> (pull) Where an imported issue lands on the board
      --scope <id>  (connect, add) Mirror only the subtree rooted at this document id
      --name <n>    (connect) Call the remote this instead of after its provider
      --force       (connect, add) Replace a remote of the same name
      --purge       (rm) Also delete the per-remote state under .lpm/remotes/<name>/
      --dry-run     (push, pull, sync, link, unlink, rebase, setup) Say what would happen, write nothing
      --all         (push) Everything this remote mirrors, rather than named documents
      --changed     (pull, sync) Ask the remote only for what changed since the last
                                 pull. Cheaper on a large remote, and partial by
                                 construction: it cannot detect a deletion
      --limit N     (push, sync) At most N remote write operations, then stop; the rest
                                 are reported as deferred
      --yes         (push, sync) Confirm without asking — the first write, any plan
                                 that would create, close or delete more than the
                                 threshold, and every plan that deletes a remote issue
      --refresh     (push, pull, sync) Re-probe capabilities instead of reading the cache
      --since <iso> (log) Keep only runs at or after this timestamp
      --json        (status, log) Emit the report / entries as JSON, nothing else
      --repoint     (link) Allow moving an already-linked document to a new twin
      --reason      (decouple) manual (default) or out_of_scope

A push that would make the **first write** to a remote asks for confirmation,
naming the target and the counts; the consent is recorded once. A push whose
plan would **create, close or delete more than the threshold** (default 25,
settable per remote as \`write_threshold\`) stops and requires \`--yes\`. A
push that would **delete a remote issue** (\`on_delete: delete\`) asks for
confirmation every run — it is never satisfied by a remembered consent. A run
with no terminal (CI, an agent) never prompts — it proceeds with \`--yes\` or
stops.

A mapping change invalidates the base snapshots recorded under the old mapping,
which stops the next sync before it can report a board-wide wave of phantom
conflicts. \`rebase\` is the way out: it reads the remote side of every linked
document (never writes to it), compares it with the board under the new
mapping, and rewrites each base from the values that agree. A document whose
two sides disagree is left conflicted for the normal resolution path, not
force-based.

Examples
  lpm remote connect
  lpm remote push LP-12
  lpm remote push --all --dry-run
  lpm remote pull
  lpm remote pull PAY-31 --parent LP-3
  lpm remote ledger
  lpm remote sync
  lpm remote sync --limit 10
  lpm remote status
  lpm remote status upstream
  lpm remote resolve LP-12 --local
  lpm remote resolve LP-12 --field status --remote --field title --local
  lpm remote link upstream LP-12 acme/payments#418
  lpm remote link upstream LP-12 acme/payments#418 --repoint
  lpm remote unlink upstream LP-12
  lpm remote decouple LP-12
  lpm remote decouple LP-12 --reason out_of_scope
  lpm remote relink LP-12
  lpm remote rebase upstream
  lpm remote rebase upstream --dry-run
  lpm remote login upstream
  echo $GITHUB_TOKEN | lpm remote login upstream`;

/** Every subcommand `lpm remote` answers to, for the dispatcher and its error. */
const SUBCOMMANDS = [
  'connect',
  'ledger',
  'add',
  'rm',
  'off',
  'on',
  'rebase',
  'push',
  'pull',
  'sync',
  'status',
  'setup',
  'resolve',
  'link',
  'unlink',
  'decouple',
  'relink',
  'log',
  'login',
] as const;

export function run(args: string[]): number {
  let [subcommand, ...rest] = args;
  if (!subcommand) return list();

  // `lpm remote jira push LP-12` — the remote's name may come first, which is
  // how somebody who thinks of the tracker as the thing they are talking to
  // will write it. It is rewritten into the spelling every subcommand already
  // understands, `push jira LP-12`, rather than given a dispatch table of its
  // own: every subcommand that acts on one remote already takes its name as
  // the first positional, so there is nothing new to keep in step.
  // A word is only read as a remote's name when it is *not* a subcommand: a
  // remote somebody called `status` is still a remote, and `lpm remote status`
  // still reports drift.
  if (!SUBCOMMANDS.includes(subcommand as (typeof SUBCOMMANDS)[number]) && rest.length > 0) {
    const named = subcommand;
    // Read the config directly rather than through `requireBoard`: this runs
    // before the subcommand, and a broken board must fail in the command that
    // was asked for, with that command's own message. Anything that goes wrong
    // reading it leaves `declared` empty, so the worst case is the ordinary
    // "unknown subcommand" rather than an error about the rewrite.
    let declared: string[] = [];
    try {
      const paths = findBoardPaths();
      const config = paths !== null ? loadConfig(paths).config : null;
      // A turned-off remote is still a name somebody may lead with (`lpm
      // remote jira on`).
      if (config !== null) declared = [...remoteNames(config), ...remotesOffNames(config)];
    } catch {
      declared = [];
    }
    if (declared.includes(named) && SUBCOMMANDS.includes(rest[0] as (typeof SUBCOMMANDS)[number])) {
      [subcommand, ...rest] = rest;
      rest = [named, ...rest];
    }
  }

  // The board's own git remote is a different layer with its own command;
  // `lpm remote git …` is the same thing, spelled from the remote family.
  if (subcommand === 'git') return gitCommand.run(rest);
  if (subcommand === 'connect') return connect(rest);
  if (subcommand === 'ledger') return ledger(rest);
  if (subcommand === 'add') return add(rest);
  if (subcommand === 'rm') return rm(rest);
  if (subcommand === 'off') return off(rest);
  if (subcommand === 'on') return on(rest);
  if (subcommand === 'rebase') return rebase(rest);
  if (subcommand === 'push') return push(rest);
  if (subcommand === 'pull') return pull(rest);
  if (subcommand === 'sync') return sync(rest);
  if (subcommand === 'status') return status(rest);
  if (subcommand === 'setup') return setup(rest);
  if (subcommand === 'resolve') return resolve(rest);
  if (subcommand === 'link') return link(rest);
  if (subcommand === 'unlink') return unlink(rest);
  if (subcommand === 'decouple') return decouple(rest);
  if (subcommand === 'relink') return relink(rest);
  if (subcommand === 'log') return log(rest);
  if (subcommand === 'login') return login(rest);
  throw new BoardError(`Unknown subcommand "${subcommand}"`, [
    `Use ${SUBCOMMANDS.join(', ')}.`,
    'A remote of your own can go first instead: lpm remote <name> push <id>.',
  ]);
}

// -- shared -----------------------------------------------------------------

/** The board as the remote layer reads it: a `BoardView` DTO. */
function viewOf(board: LoadedBoard): BoardView {
  const snapshot = toSnapshot(board);
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources, ...snapshot.templates].map(
      (node) => [node.id, node],
    ),
  );
  return { config: snapshot.config, nodes };
}

/** An error message from any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The one remote a name-less command acts on, or a BoardError naming the choice. */
function singleRemote(board: LoadedBoard, names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 0) {
    throw new BoardError('This board declares no remotes', [
      'Add a remotes: block to .lpm/config.yml first.',
    ]);
  }
  throw new BoardError('This board declares more than one remote — name one', [
    `Declared remotes: ${names.join(', ')}`,
  ]);
}

// -- add / rm / list ---------------------------------------------------------

/** One provider's flags as a help fragment: `--site <site> [--board <board>]`. */
function describeFlags(flags: readonly ConnectionFlag[]): string {
  return flags
    .map((flag) => {
      const text = flag.type === 'boolean' ? `--${flag.name}` : `--${flag.name} <${flag.name}>`;
      return flag.required ? text : `[${text}]`;
    })
    .join(' ');
}

/**
 * The `add` help's per-provider connection lines, rendered from the registry.
 *
 * Written by hand this block listed three providers and went stale the moment
 * a fourth landed — which is how `jsonfile` came to be documented everywhere
 * except in the help of the command that declares it.
 */
function providerFlagHelp(): string {
  const names = registeredProviders();
  const width = Math.max(...names.map((name) => name.length));
  return names
    .map((name) => `              ${name.padEnd(width)}  ${describeFlags(connectionFlags(lookupProvider(name)))}`)
    .join('\n');
}

/**
 * The `parseArgs` options `add` accepts: its own three, plus every connection
 * key any registered provider declares.
 *
 * Derived, never listed. A hard-coded table here was the whole of LP-530: the
 * `jsonfile` provider shipped with a `file` connection key that this command
 * had never heard of, so `--file` was rejected by the parser and the provider
 * was unusable from the CLI — while every layer below it (the schema, the
 * error hint, `addRemote`) already knew the key by name. Adding a provider is
 * a folder and a registry line; this is one of the places that has to stay
 * true for that to hold.
 */
function addOptions(): Record<string, { type: 'string' | 'boolean' }> {
  const options: Record<string, { type: 'string' | 'boolean' }> = {
    provider: { type: 'string' },
    force: { type: 'boolean' },
    scope: { type: 'string' },
  };
  for (const flag of allConnectionFlags()) options[flag.name] = { type: flag.type };
  return options;
}

/** The board paths a config-editing command works on — no board load needed. */
function requirePaths(): BoardPaths {
  const paths = findBoardPaths();
  if (!paths) throw noBoardFound();
  return paths;
}

/**
 * Print what credential this remote needs, where to create it, and how to hand
 * it over — the block `add` ends with, and the one a missing credential prints.
 *
 * Every line of it is derived: the keys and their conventional env vars come
 * from `Provider.credentials.secrets`, the page and the one-line description
 * from the same descriptor, and whether a value is *already* available from
 * `credentialStates`, which reads the source without reading the value. So a
 * new provider gets this output by declaring its descriptor, and nothing here
 * names a platform.
 *
 * This exists because the step after `add` was the one the tool said nothing
 * about. A person who has just declared a Jira remote needs a token, from a
 * page they have to find, under a key they have to guess, in one of three
 * places they have to read the docs to learn — and the command that had just
 * written the declaration knew all four.
 */
function renderCredentialGuide(
  board: LoadedBoard,
  remoteName: string,
  providerName: string,
  connection: Record<string, unknown>,
): { satisfied: boolean } {
  const provider = lookupProvider(providerName);
  const secrets = provider.credentials?.secrets ?? {};
  if (Object.keys(secrets).length === 0) {
    out(`${bold('Credential')}  ${dim('none — this provider needs no account.')}`);
    return { satisfied: true };
  }

  const states = credentialStates(remoteName, connection, secrets, board.paths);
  const missing = states.filter((state) => state.source === undefined);
  const loginKey = loginKeyFor(providerName);

  out(bold('Credential'));
  if (provider.credentials?.url) {
    out(`  ${pad('create it', 12)} ${cyan(provider.credentials.url)}`);
  }
  if (provider.credentials?.hint) {
    for (const line of wrap(provider.credentials.hint, 64)) out(`  ${pad('', 12)} ${dim(line)}`);
  }
  out();
  for (const state of states) {
    if (state.source !== undefined) {
      out(`  ${green('found')}  ${pad(state.key, 10)} ${dim(`from ${state.source}`)}`);
      continue;
    }
    const env = state.env ? `or export ${state.env}=<value>` : '';
    out(`  ${yellow('needed')} ${pad(state.key, 10)} ${dim(env)}`.trimEnd());
    if (state.reference && state.reference !== state.env) {
      out(`  ${pad('', 17)} ${dim(`or export ${state.reference}=<value>  (config.yml points at it)`)}`);
    }
  }
  if (missing.length > 0) {
    const keys = listOf(missing.map((state) => state.key));
    const key = missing.some((state) => state.key !== loginKey) ? ` --key <key>` : '';
    out();
    out(`  ${cyan(`lpm remote login ${remoteName}`)} ${dim(`asks for ${keys} and stores ${missing.length > 1 ? 'them' : 'it'}, never echoed.`)}`);
    out(dim(`  In a script:  echo <value> | lpm remote login ${remoteName}${key}`));
  }
  out();
  out(dim('  A credential is never written into config.yml — it resolves at sync time.'));
  return { satisfied: missing.length === 0 };
}

/** `a`, `a and b`, `a, b and c` — for naming the keys a command will ask for. */
function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Wrap a sentence to a width, for the indented hint lines. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/**
 * The connection key `lpm remote login <name>` writes when no `--key` is given:
 * the provider's only secret, or `token` when it has several.
 *
 * It used to be the literal string `token` for every provider, which meant the
 * command silently did nothing useful for Linear — whose key is `api_key` — and
 * the workaround was documented rather than fixed. Reading the descriptor makes
 * `login` work for any provider that declares one secret, and keeps the Jira
 * pair (`email` + `token`) landing on the token by default.
 */
function loginKeyFor(providerName: string): string {
  const secrets = Object.keys(lookupProvider(providerName).credentials?.secrets ?? {});
  if (secrets.length === 1) return secrets[0]!;
  if (secrets.includes('token')) return 'token';
  return secrets[0] ?? 'token';
}

/**
 * `lpm remote add <name> --provider <p> [--<key> <value>...] [--scope <id>] [--force]`.
 *
 * Thin over `addRemote`: gathers the provider's non-secret connection keys
 * from flags, refuses a flag the provider does not know, and lets `addRemote`
 * validate and write. Secret keys are never flags — a token resolves at sync
 * time from the environment or `lpm remote login`, and never lands in config.
 */
function add(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: addOptions(),
  });

  const name = positionals[0];
  if (!name) {
    throw new BoardError('Usage: lpm remote add <name> --provider <provider> [--<key> <value>...]', [
      'Name the remote, then its provider and the connection keys that provider needs.',
      `Registered providers: ${registeredProviders().join(', ')}`,
      "See `lpm remote --help` for each provider's connection flags.",
    ]);
  }
  if (positionals.length > 1) {
    throw new BoardError(`Only one remote name is accepted (got "${positionals.join('", "')}")`, [
      'Usage: lpm remote add <name> --provider <provider> [--<key> <value>...]',
    ]);
  }

  // `addOptions()` is built at runtime, so `values` is the widened
  // `string | boolean` map rather than a literal-typed one — read the two
  // string options back through the same `raw` view the connection keys use.
  const raw = values as Record<string, unknown>;
  const stringOption = (key: string): string | undefined => {
    const value = raw[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };

  const providerName = stringOption('provider');
  if (!providerName) {
    throw new BoardError('--provider is required', [
      `Registered providers: ${registeredProviders().join(', ')}`,
      'e.g. lpm remote add upstream --provider github --repo acme/payments',
    ]);
  }

  const provider = lookupProvider(providerName);
  const own = connectionFlags(provider);
  const ownNames = new Set(own.map((flag) => flag.name));

  const given = (flag: { name: string; type: 'string' | 'boolean' }): boolean =>
    flag.type === 'boolean' ? raw[flag.name] === true : typeof raw[flag.name] === 'string' && raw[flag.name] !== '';

  const connection: Record<string, unknown> = {};
  for (const flag of own) {
    if (!given(flag)) continue;
    connection[flag.name] = flag.type === 'boolean' ? true : stringOption(flag.name);
  }

  // A flag another provider declares would be silently dropped by this
  // provider's schema — refuse it instead, so a typo is not a missing
  // connection, and name the flags that would have worked.
  for (const flag of allConnectionFlags()) {
    if (ownNames.has(flag.name)) continue;
    if (!given(flag)) continue;
    throw new BoardError(`--${flag.name} is not a connection option for provider "${providerName}"`, [
      `Connection flags for ${providerName}: ${describeFlags(own)}`,
    ]);
  }

  const paths = requirePaths();
  const result = addRemote(paths, {
    name,
    provider: providerName,
    connection,
    scope: stringOption('scope'),
    force: raw.force === true,
  });

  out();
  out(
    `${bold(`Added remote ${cyan(result.name)}`)} — ${result.provider}` +
      (result.replaced ? ` ${dim('(replaced)')}` : ''),
  );
  out(`  ${pad('target', 10)} ${result.target}`);
  const scope = stringOption('scope');
  if (scope) out(`  ${pad('scope', 10)} ${scope}`);
  renderMappingDraft(result, providerName);

  // What to do next, in order, with the credential step spelled out. A remote
  // that is declared and unreachable is not set up, and this is the only place
  // that knows the provider, the remote's name and what is already resolvable.
  out();
  const credential = renderCredentialGuide(
    requireBoard(),
    result.name,
    providerName,
    result.connection,
  );
  out();
  out(bold('Next'));
  // A command and what it is for, padded to one column so the comments line up
  // whatever the remote is called.
  const steps: Array<[command: string, why: string]> = [];
  if (!credential.satisfied) steps.push(['give light-plan the credential above', '']);
  if (lookupProvider(providerName).standardVocabulary !== undefined) {
    steps.push([`lpm remote setup ${result.name}`, 'match the mapping to the live remote']);
  }
  steps.push(['lpm remote push --dry-run', 'read the plan before anything is written']);
  steps.push(['lpm remote push', 'the first write asks once']);
  const width = Math.max(...steps.map(([command]) => command.length));
  for (let index = 0; index < steps.length; index += 1) {
    const [command, why] = steps[index]!;
    out(`  ${dim(`${index + 1}`)}  ${pad(command, why === '' ? 0 : width)}${why === '' ? '' : dim(`  # ${why}`)}`);
  }
  return 0;
}

/**
 * `lpm remote rm <name> [--purge]` — thin over `removeRemote`. The config
 * entry goes; the per-remote state (link store, caches, audit log) is kept
 * unless `--purge`, because dropping the declaration is an edit a person may
 * undo and the state is the expensive half to rebuild.
 */
function rm(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { purge: { type: 'boolean' } },
  });

  const name = positionals[0];
  if (!name) {
    throw new BoardError('Usage: lpm remote rm <name> [--purge]', [
      "Remove a remote's declaration from .lpm/config.yml.",
    ]);
  }
  if (positionals.length > 1) {
    throw new BoardError(`Only one remote name is accepted (got "${positionals.join('", "')}")`, [
      'Usage: lpm remote rm <name> [--purge]',
    ]);
  }

  const paths = requirePaths();
  const result = removeRemote(paths, { name, purge: values.purge === true });

  out();
  out(`${bold(`Removed remote ${cyan(result.name)}`)}`);
  if (result.purged) {
    out(dim(`Deleted the per-remote state under .lpm/remotes/${result.name}/.`));
  } else {
    out(
      dim(
        `Kept the per-remote state under .lpm/remotes/${result.name}/ — pass --purge to delete it too.`,
      ),
    );
  }
  return 0;
}

/**
 * `lpm remote off [<name>...]` — thin over `turnRemotesOff`. Nothing is
 * deleted; the declaration moves to `remotes_off:`.
 */
function off(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const paths = requirePaths();
  const names = turnRemotesOff(paths, positionals);
  if (!names.length) {
    out('No remote is on; nothing was changed.');
    return 0;
  }
  out(`${green('off')} ${names.join(', ')}`);
  out(
    dim(
      'Declaration moved to remotes_off: in config.yml; links, mapping and credentials are kept. ' +
        `\`lpm remote on ${names[0]}\` turns it back on.`,
    ),
  );
  return 0;
}

/** `lpm remote on <name>` — thin over `turnRemoteOn`. */
function on(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const name = positionals[0];
  if (!name || positionals.length > 1) {
    throw new BoardError('Usage: lpm remote on <name>', ['Turn one turned-off remote back on.']);
  }
  const paths = requirePaths();
  turnRemoteOn(paths, name);
  out(`${green('on')} ${name} ${dim('— the next sync carries on from where the last one stopped')}`);
  out(dim(`  lpm remote status ${name}   # what changed while it was off`));
  return 0;
}

/** The remotes that are turned off, as the listing's closing lines. */
function printRemotesOff(config: BoardConfig): void {
  const names = remotesOffNames(config);
  if (!names.length) return;
  out();
  out(`${bold('Turned off')} ${dim('— kept whole; `lpm remote on <name>` brings one back')}`);
  for (const name of names) {
    const remote = config.remotes_off[name]!;
    out(`  ${pad(name, 12)}  ${pad(remote.provider, 8)}  ${dim(describeTarget(remote.provider, remote.connection))}`);
  }
}

/**
 * `lpm remote` — list each declared remote with its provider, target,
 * direction and last sync. With none declared, explains how to add one.
 */
function list(): number {
  const paths = requirePaths();
  const loaded = loadConfig(paths);
  if (!loaded.config) {
    throw new BoardError('Cannot read the board config', loaded.errors);
  }

  const summaries = summarizeRemotes(paths, loaded.config);
  if (summaries.length === 0) {
    if (remotesOffNames(loaded.config).length) {
      out('No tracker remote is on.');
      printRemotesOff(loaded.config);
      return 0;
    }
    out('This board is not connected to a tracker.');
    out();
    out('Connect one — it asks for whatever you leave out:');
    out(`  ${cyan('lpm remote connect')}`);
    out('  lpm remote connect github --repo owner/repo');
    out('  lpm remote connect jira --site https://acme.atlassian.net --project PAY');
    out('  lpm remote connect linear --team ENG');
    return 0;
  }

  const nameWidth = Math.max(4, ...summaries.map((remote) => remote.name.length));
  const providerWidth = Math.max(8, ...summaries.map((remote) => remote.provider.length));
  const directionWidth = Math.max(9, ...summaries.map((remote) => remote.direction.length));
  const targetWidth = Math.max(6, ...summaries.map((remote) => remote.target.length));
  const lastSyncWidth = Math.max(
    9,
    ...summaries.map((remote) => (remote.lastSync ? remote.lastSync.slice(0, 10).length : 5)),
  );

  out();
  out(`${bold(plural(summaries.length, 'remote'))} on this board:`);
  out();
  out(
    `  ${pad('name', nameWidth)}  ${pad('provider', providerWidth)}  ${pad('direction', directionWidth)}  ${pad('target', targetWidth)}  ${pad('last sync', lastSyncWidth)}`,
  );
  const book = buildLedger(paths, loaded.config);
  for (const remote of summaries) {
    const lastSync = remote.lastSync ? remote.lastSync.slice(0, 10) : 'never';
    const held = book.byRemote.get(remote.name)?.length ?? 0;
    out(
      `  ${pad(remote.name, nameWidth)}  ${pad(remote.provider, providerWidth)}  ${pad(remote.direction, directionWidth)}  ${pad(remote.target, targetWidth)}  ${pad(lastSync, lastSyncWidth)}  ${dim(`${held} mirrored`)}`,
    );
  }
  printRemotesOff(loaded.config);
  out();
  out(dim('  lpm remote ledger   # which remote holds each document'));
  return 0;
}

// -- push / pull / sync ------------------------------------------------------

/** The direction a sync command runs, from its subcommand. */
type SyncDirection = 'push' | 'pull' | 'both';

/** The option names the three sync commands share. */
const SYNC_OPTIONS = {
  'dry-run': { type: 'boolean' },
  all: { type: 'boolean' },
  changed: { type: 'boolean' },
  limit: { type: 'string' },
  refresh: { type: 'boolean' },
  yes: { type: 'boolean' },
  remote: { type: 'string' },
  provider: { type: 'string' },
  children: { type: 'boolean' },
  recursive: { type: 'boolean' },
  parent: { type: 'string' },
} as const;

function push(args: string[]): number {
  return syncCommand(args, 'push');
}

function pull(args: string[]): number {
  return syncCommand(args, 'pull');
}

function sync(args: string[]): number {
  return syncCommand(args, 'both');
}

/** Parse `--limit N` into a positive integer, or throw. */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new BoardError(`--limit must be a positive integer (got "${raw}")`, [
      'Usage: lpm remote push|sync --limit N',
    ]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// What a sync run acts on
// ---------------------------------------------------------------------------

/**
 * One run of the sync machinery: a remote, and — for a targeted command — the
 * documents or remote issues it is about. Neither field set means the whole
 * remote, which is what `lpm remote sync` has always done.
 */
interface SyncRun {
  name: string;
  /** Local document ids to push (a selection, not a scope). */
  only?: string[];
  /** The subtree a pull should narrow to, when a document id named one. */
  scope?: string;
  /**
   * Period documents this run files on the remote — the board's timeline,
   * pushed like any other part of the plan. `'all'` is `--all`.
   */
  periods?: 'all' | string[];
  /** Remote issue ids or keys to pull. */
  pullIds?: string[];
}

/**
 * How far down a named document a push should go: the document alone, its
 * direct children too, or everything nested inside it. `ask` is the default and
 * means exactly that — a question, when there is somebody to answer it, and the
 * document alone when there is not.
 */
type SelectionDepth = 'ask' | 'named' | 'children' | 'subtree';

/**
 * The remote a command works on when nothing points at one: the only one
 * declared, the one `--remote` / `--provider` names, or the one a person picks.
 *
 * This is only ever reached for a document nothing mirrors yet. The ledger
 * answers first and is never overruled — a document that already has a twin
 * belongs to the remote holding it, so `lpm remote push LP-12` files LP-12
 * where LP-12 already lives, whatever else is declared. And a board with a
 * single remote never asks at all: a question with one possible answer is
 * noise.
 */
function pickRemote(
  board: LoadedBoard,
  names: string[],
  flags: { remote?: string; provider?: string } | undefined,
): string {
  if (names.length === 0) {
    throw new BoardError('This board is not connected to a remote', [
      'Connect one first:  lpm remote connect <provider>',
      `Providers: ${registeredProviders().join(', ')}`,
    ]);
  }

  const named = flags?.remote;
  if (named !== undefined) {
    if (!names.includes(named)) {
      throw new BoardError(`No remote named "${named}"`, [`Declared remotes: ${names.join(', ')}`]);
    }
    return named;
  }

  const provider = flags?.provider;
  if (provider !== undefined) {
    const matching = names.filter((name) => remoteNamed(board.config, name)?.provider === provider);
    if (matching.length === 1) return matching[0]!;
    if (matching.length === 0) {
      throw new BoardError(`No remote on this board uses provider "${provider}"`, [
        names.length > 0
          ? `Declared remotes: ${names
              .map((name) => `${name} (${remoteNamed(board.config, name)?.provider})`)
              .join(', ')}`
          : 'This board declares no remotes',
      ]);
    }
    throw new BoardError(`More than one remote uses provider "${provider}"`, [
      `Name one with --remote: ${matching.join(', ')}`,
    ]);
  }

  if (names.length === 1) return names[0]!;

  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    return choose(
      'Which remote?',
      names.map((name) => ({
        value: name,
        label: name,
        detail: describeRemoteBriefly(board, name),
      })),
      '--remote <name>',
    );
  }

  throw new BoardError('This board declares more than one remote — name one', [
    `Declared remotes: ${names.join(', ')}`,
    'e.g. lpm remote push LP-12 --remote upstream',
  ]);
}

/** `github — acme/payments`, for the one-line detail beside a remote's name. */
function describeRemoteBriefly(board: LoadedBoard, name: string): string {
  const declared = remoteNamed(board.config, name);
  if (!declared) return '';
  return `${declared.provider} — ${describeTarget(declared.provider, declared.connection)}`;
}

/**
 * Turn the words after `push` / `pull` / `sync` into the runs to perform.
 *
 * Three kinds of word can appear there and each is recognised by what it *is*,
 * never by its position: a declared remote's name, a document on this board, or
 * — for a pull — a key only the remote can resolve. That is what lets
 * `lpm remote push LP-12`, `lpm remote push upstream` and `lpm remote pull
 * PAY-31` all be the same command without a mode flag.
 *
 * Documents are grouped by the remote that owns them, so pushing three
 * documents that live on two trackers is two runs rather than an error. A
 * document nobody owns yet takes the remote the flags name, the only one
 * declared, or the one a person picks.
 */
function planRuns(
  board: LoadedBoard,
  direction: SyncDirection,
  positionals: string[],
  flags: { remote?: string; provider?: string; depth: SelectionDepth; all?: boolean },
): SyncRun[] {
  const names = remoteNames(board.config);
  if (names.length === 0) {
    throw new BoardError('This board is not connected to a remote', [
      'Connect one first:  lpm remote connect <provider>',
      `Providers: ${registeredProviders().join(', ')}`,
    ]);
  }

  const periodIds = new Set(board.periods.map((period) => period.id));
  const remoteWords = positionals.filter((word) => names.includes(word));
  const documentIds = positionals.filter((word) => !names.includes(word) && board.byId.has(word));
  // A period is a document too, and a pushable one: filing the timeline is
  // part of filing the plan, just not a precondition of it.
  const periodWords = positionals.filter((word) => !names.includes(word) && periodIds.has(word));
  const unknown = positionals.filter(
    (word) => !names.includes(word) && !board.byId.has(word) && !periodIds.has(word),
  );

  if (remoteWords.length > 1) {
    throw new BoardError(`Only one remote name is accepted (got "${remoteWords.join('", "')}")`, [
      'Usage: lpm remote push|pull|sync [<name>] [<id>...]',
    ]);
  }
  // `--remote` is validated here rather than where it is used, so a name this
  // board does not have is reported as such before anything else can produce a
  // more interesting error about a document.
  if (flags.remote !== undefined && !names.includes(flags.remote)) {
    throw new BoardError(`No remote named "${flags.remote}"`, [
      `Declared remotes: ${names.join(', ')}`,
      'Connect another:  lpm remote connect <provider>',
    ]);
  }
  const named = remoteWords[0] ?? flags.remote;

  // -- pull: a word that is neither a remote nor a document is a remote key ---
  if (direction === 'pull' && unknown.length > 0) {
    const target = named ?? pickRemote(board, names, flags);
    if (documentIds.length > 0) {
      throw new BoardError('Pull takes remote issue keys, not local document ids', [
        `${documentIds.join(', ')} ${documentIds.length === 1 ? 'is a document' : 'are documents'} on this board.`,
        'To refresh what a local document mirrors, pull the whole remote: lpm remote pull',
      ]);
    }
    return [{ name: target, pullIds: unknown }];
  }

  if (unknown.length > 0) {
    throw new BoardError(`"${unknown[0]}" is neither a remote nor a document on this board`, [
      `Declared remotes: ${names.join(', ')}`,
      'A push names documents by their board id, e.g. lpm remote push LP-12.',
    ]);
  }

  if (documentIds.length === 0 && periodWords.length === 0) {
    // `--all` files the timeline too: it means everything this remote mirrors.
    return (named !== undefined ? [named] : names).map((name) => ({
      name,
      ...(flags.all === true ? { periods: 'all' as const } : {}),
    }));
  }

  // A document id on a pull or a sync names a subtree to narrow to — the same
  // thing `--filter` used to say, without a flag to remember.
  if (direction !== 'push') {
    if (documentIds.length > 1) {
      throw new BoardError(`${direction === 'both' ? 'sync' : direction} takes one document id`, [
        `It narrows the run to that subtree; got "${documentIds.join('", "')}".`,
      ]);
    }
    const target = named ?? pickRemote(board, names, flags);
    return [{ name: target, scope: documentIds[0]! }];
  }

  // -- push: group the named documents by the remote that owns each ----------
  const ledger = buildLedger(board.paths, board.config);
  // Only ask (or read the flags) when something is genuinely unfiled — a
  // board with two remotes never prompts for documents that already live
  // somewhere.
  let fallback: string | undefined = named;
  const byRemote = new Map<string, string[]>();
  for (const id of documentIds) {
    const owner = ownerOf(ledger, id);
    let target = owner?.remote;
    if (target !== undefined && named !== undefined && target !== named) {
      throw new BoardError(`${id} is already mirrored on remote "${target}"`, [
        'A document is mirrored by one remote at a time, so its fields have one upstream.',
        `Release it first:  lpm remote decouple ${id}`,
      ]);
    }
    if (target === undefined) {
      fallback ??= pickRemote(board, names, flags);
      target = fallback;
    }
    const group = byRemote.get(target);
    if (group) group.push(id);
    else byRemote.set(target, [id]);
  }

  const runs: SyncRun[] = [...byRemote].map(([name, ids]) => ({
    name,
    only: expandSelection(board, name, ids, flags.depth),
  }));

  // Filing a period is filing part of the plan, so it comes with the repair
  // the rest of the push already does: every already-filed issue scheduled in
  // that period joins the run, and the assignment it could not carry when it
  // was filed is written now that the sprint exists.
  if (periodWords.length > 0) {
    const target = runs[0]?.name ?? named ?? pickRemote(board, names, flags);
    const run = runs.find((entry) => entry.name === target) ?? { name: target, only: [] };
    if (!runs.includes(run)) runs.push(run);
    const split = splitPushSelection(board, target, [...(run.only ?? []), ...periodWords]);
    run.only = split.only;
    run.periods = periodWords;
  }

  return runs;
}

/**
 * Widen a push selection from the documents somebody named to the documents the
 * run must actually touch.
 *
 * Two widenings, and they are different in kind.
 *
 * **What is inside** is a question, because it is a decision: pushing a feature
 * usually means pushing its stories, but a plan filed deliberately a piece at a
 * time is exactly what this command is for. The question is only ever asked
 * about work the remote has not got — a container whose contents are all
 * mirrored already has nothing to ask about — and it is asked once per named
 * document, offering the two answers that differ: the children, or everything
 * nested. `--children` and `--recursive` answer it in advance, and with no
 * terminal the answer is "just what was named", which is the reading that
 * cannot surprise anybody.
 *
 * **What is already filed** is never optional. A story filed before this
 * feature existed upstream is sitting at the remote's root, and the whole point
 * of pushing its parent is that it stops sitting there; an issue already filed
 * that waits on something in this push has an edge nobody would ever write
 * again, because an edge is planned from the *dependent*. Both cost one planned
 * operation that is a no-op when nothing changed, and leaving either out means
 * the shape silently never heals.
 */
function expandSelection(
  board: LoadedBoard,
  remoteName: string,
  ids: string[],
  depth: SelectionDepth,
): string[] {
  const store = loadLinkStore(board.paths, remoteName);
  const selection = new Set(ids);

  for (const id of ids) {
    const issue = board.byId.get(id);
    if (!issue) continue;
    const inside = subtreeOf(board.issues, issue).filter((node) => node.id !== issue.id);
    if (inside.length === 0) continue;

    // Already filed: never a question.
    for (const node of inside) {
      if (store.links.has(node.id)) selection.add(node.id);
    }

    const children = inside.filter((node) => node.parentId === issue.id);
    const unfiled = inside.filter((node) => !store.links.has(node.id));
    if (unfiled.length === 0) continue;

    const answer = depth === 'ask' ? askDepth(id, children, unfiled) : depth;
    if (answer === 'children') {
      for (const node of children) selection.add(node.id);
    } else if (answer === 'subtree') {
      for (const node of inside) selection.add(node.id);
    }
  }

  // Every already-filed issue that points at something in this selection joins
  // it, so the edge it is waiting to have written can be planned.
  for (const issue of board.issues) {
    if (selection.has(issue.id) || !store.links.has(issue.id)) continue;
    const edges = [...(issue.depends_on ?? []), ...(issue.relates_to ?? [])];
    if (edges.some((edge) => selection.has(edge))) selection.add(issue.id);
  }

  return [...selection].sort();
}

/**
 * Ask how far down to go, naming what is not mirrored yet — which is the only
 * part of the answer that costs anything.
 *
 * When everything inside is one level deep there is no third answer to offer,
 * so it is a yes/no rather than a menu.
 */
function askDepth(
  id: string,
  children: readonly { id: string }[],
  unfiled: readonly { id: string }[],
): SelectionDepth {
  if (!(process.stdin.isTTY === true && process.stdout.isTTY === true)) return 'named';

  const deeper = unfiled.length > children.length;
  const summary = `${id} has ${plural(unfiled.length, 'document')} inside it that ${
    unfiled.length === 1 ? 'is' : 'are'
  } not on this remote yet.`;

  if (!deeper) {
    out();
    out(dim(`  ${summary}`));
    return confirm(`  Push ${unfiled.length === 1 ? 'it' : 'them'} too?`, true) ? 'children' : 'named';
  }

  out();
  out(dim(`  ${summary}`));
  return choose(
    `  How much of ${id} should go?`,
    [
      { value: 'subtree', label: 'all of it', detail: `${id} and everything nested inside it` },
      {
        value: 'children',
        label: 'one level',
        detail: `${id} and its ${children.length} direct ${children.length === 1 ? 'child' : 'children'}`,
      },
      { value: 'named', label: 'just this one', detail: `${id} alone` },
    ],
    '--recursive, --children, or neither',
  ) as SelectionDepth;
}

/**
 * Say what filing these documents will and will not manage to do, before the
 * plan is built.
 *
 * A partial push is a normal way to work — a story goes up before the epic it
 * belongs to, a dependency points at something nobody has filed — and the
 * answer to all of it is "push the rest later". That is only true if nobody is
 * surprised, so the two things a partial push cannot carry are named here: a
 * parent with no twin yet, and a dependency on a document outside the run.
 */
function reportPartialPush(board: LoadedBoard, remoteName: string, only: readonly string[]): void {
  const store = loadLinkStore(board.paths, remoteName);
  const selected = new Set(only);
  const filed = (id: string): boolean => store.links.has(id) || selected.has(id);

  const rootless: string[] = [];
  const waiting: string[] = [];
  for (const id of only) {
    const issue = board.byId.get(id);
    if (!issue) continue;
    const parentId = issue.parentId;
    if (parentId && !filed(parentId) && !store.links.has(id)) rootless.push(`${id} (parent ${parentId})`);
    for (const blocker of issue.depends_on ?? []) {
      if (!filed(blocker)) waiting.push(`${id} → ${blocker}`);
    }
  }

  if (rootless.length === 0 && waiting.length === 0) return;
  out();
  if (rootless.length > 0) {
    out(dim(`  files at the top of ${remoteName}, its parent is not there yet: ${rootless.join(', ')}`));
  }
  if (waiting.length > 0) {
    out(dim(`  dependency left off, the other end is not there yet: ${waiting.join(', ')}`));
  }
  out(dim('  Push the rest whenever you like — that push repairs the shape.'));
}

/**
 * `lpm remote push|pull|sync` — the one sync command, thin over `runSync`.
 *
 * Each direction plans through `runSync` and either renders the plan
 * (`--dry-run`) or applies it with progress.  With several remotes and no
 * name, every remote is run in order and a failure on one does not stop the
 * next — the report says per remote what landed and what failed, and the exit
 * code is non-zero when any remote failed.
 */
function syncCommand(args: string[], direction: SyncDirection): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: SYNC_OPTIONS,
  });

  const board = requireBoard();
  // How far down a named document to go. `--recursive` implies `--children`;
  // neither means "just what was named", unless there is somebody to ask.
  const depth: SelectionDepth =
    values.recursive === true ? 'subtree' : values.children === true ? 'children' : 'ask';
  // `--all` is the no-id default said out loud: everything this remote mirrors,
  // which in practice is everything that has changed since the last run — an
  // unchanged document has nothing to write. It exists because naming ids is
  // now the ordinary way to push, so "not a selection" deserves a spelling
  // rather than being the absence of one.
  if (values.all === true && positionals.some((word) => board.byId.has(word))) {
    throw new BoardError('--all and a document id contradict each other', [
      'Push the whole remote:   lpm remote push --all',
      'Or name what to file:    lpm remote push LP-12',
    ]);
  }
  const runs = planRuns(board, direction, positionals, {
    ...(typeof values.remote === 'string' ? { remote: values.remote } : {}),
    ...(typeof values.provider === 'string' ? { provider: values.provider } : {}),
    ...(values.all === true ? { all: true } : {}),
    depth,
  });
  const underId = typeof values.parent === 'string' ? values.parent : undefined;
  if (underId !== undefined && !board.byId.has(underId)) {
    throw new BoardError(`--parent names no document "${underId}"`, [
      'Give the document a pulled issue should land under, e.g. `--parent LP-3`.',
    ]);
  }
  const limit = parseLimit(values.limit);
  const dryRun = values['dry-run'] === true;
  const yes = values.yes === true;
  // A run may prompt only when both stdin and stdout are terminals — a pipe,
  // a CI run or an agent has nobody to answer, and must pass --yes or stop.
  const interactive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  // Open every remote up front, per remote, so a config error is reported for
  // that remote and the rest still run — the continue-past-a-failure rule.
  const opened: Array<SyncRun & { remote?: OpenedRemote }> = runs.map((run) => {
    try {
      return { ...run, remote: openRemote(board.config, run.name) };
    } catch (error) {
      renderSyncError(run.name, error);
      return { ...run };
    }
  });
  // If none opened there is nothing async to drive the exit code — the config
  // problem is a hard error, reported above.
  if (opened.every((entry) => entry.remote === undefined)) return 1;

  void (async () => {
    let failed = opened.some((entry) => entry.remote === undefined);
    for (const { name, remote, only, pullIds, scope, periods } of opened) {
      if (remote === undefined) continue;
      // Reload between remotes: a pull on one rewrites the board on disk, and
      // the next remote must plan against what actually landed.
      const fresh = loadBoard(board.paths);
      if (only !== undefined) reportPartialPush(fresh, name, only);
      try {
        const result = await runSync(fresh, remote, fresh.paths, {
          direction,
          dryRun,
          ...(scope !== undefined ? { scope } : {}),
          ...(only !== undefined ? { only } : {}),
          ...(pullIds !== undefined ? { pullIds } : {}),
          ...(periods !== undefined ? { periods } : {}),
          ...(typeof values.parent === 'string' && values.parent !== ''
            ? { under: values.parent }
            : {}),
          ...(limit !== undefined ? { limit } : {}),
          changed: values.changed === true,
          refresh: values.refresh === true,
          onProgress: renderProgress,
          ...(yes ? { yes: true } : {}),
          ...(interactive && !yes ? { confirm: confirmFirstWrite } : {}),
        });
        renderSyncResult(name, result);
        if (pullIds !== undefined && (result.pullResult?.failures.length ?? 0) > 0) {
          out(
            dim(
              '  A tracker keeps a flat list and a board keeps a tree, so an imported issue ' +
                'may need somewhere to go:',
            ),
          );
          out(dim(`  lpm remote pull ${pullIds.join(' ')} --parent <id>`));
        }
        if (syncResultFailed(result)) failed = true;
      } catch (error) {
        renderSyncError(name, error);
        failed = true;
      }
    }
    if (failed) process.exitCode = 1;
  })().catch((error: unknown) => {
    if (error instanceof BoardError) {
      err(`${red('error')} ${error.message}`);
      for (const detail of error.details) err(`       ${detail}`);
    } else {
      err(`${red('error')} ${messageOf(error)}`);
    }
    process.exitCode = 1;
  });

  return 0;
}

/** One push op's progress line, streamed as the executor walks the plan. */
function renderProgress(progress: OpProgress): void {
  out(`  ${dim(`[${progress.index}/${progress.total}]`)} ${progress.op.kind} ${progress.localId}`);
}

/**
 * The confirmation for a gate that prompts (LP-350, LP-351): the first write
 * and a plan that deletes a remote issue. The caller passes this only when it
 * already knows the run is interactive — a non-interactive run stops with a
 * message instead of ever reaching a question nobody can answer.
 */
function confirmFirstWrite(request: ConsentRequest): boolean {
  const counts = request.counts;
  const question =
    request.reason === 'delete'
      ? `Delete ${counts.deletes} ${counts.deletes === 1 ? 'remote issue' : 'remote issues'} on ${request.target} — this is permanent on platforms that hard-delete. Proceed?`
      : `First write to ${request.target} — ${counts.creates} to create, ${counts.closes} to close. Proceed?`;
  // A yes/no question, answered the way a terminal expects: `y`, `n` or Enter.
  // A delete defaults to no — the one gate where a stray Enter is expensive.
  return confirm(question, request.reason !== 'delete');
}

/** True when a sync run left something for the operator — the exit-code signal. */
function syncResultFailed(result: RunSyncResult): boolean {
  if (result.consentRefused !== undefined) return true;
  if (result.preflightBlocked) return true;
  if (result.unreachable !== undefined) return true;
  if (result.pushResult !== undefined) {
    if (result.pushResult.failed.length > 0 || result.pushResult.conflicted.length > 0) {
      return true;
    }
  }
  if (result.pullResult !== undefined && result.pullResult.failures.length > 0) return true;
  // A conflict the pull left for a human (on_delete: manual, a field both sides
  // edited) means the two sides did not converge — same signal as a failure.
  if (result.pullPlan !== undefined) {
    if ((result.pullPlan.conflicts?.length ?? 0) > 0) return true;
    if ((result.pullPlan.fieldConflicts?.length ?? 0) > 0) return true;
  }
  return false;
}

/** Render a sync command that threw while running one remote. */
function renderSyncError(name: string, error: unknown): void {
  out();
  out(`${bold(`Remote ${cyan(name)}`)} — ${red('failed')}`);
  if (error instanceof BoardError) {
    out(`  ${error.message}`);
    for (const detail of error.details) out(`  ${dim(detail)}`);
  } else {
    out(`  ${messageOf(error)}`);
  }
}

/** Render one sync command's result: a dry-run diff, or the applied summary. */
function renderSyncResult(name: string, result: RunSyncResult): void {
  const verb = result.direction === 'both' ? 'sync' : result.direction;

  out();
  out(`${bold(`Remote ${cyan(name)}`)} — ${verb}${result.dryRun ? ` ${dim('(dry run)')}` : ''}`);

  for (const problem of result.preflight) {
    out(`  ${problem.level === 'error' ? red('error') : yellow('warn')}  ${problem.message}`);
  }
  if (result.preflightBlocked) {
    out();
    out(red('Push refused — fix the error-level problems above first.'));
  }

  if (result.unreachable !== undefined) {
    out();
    out(red(`Pull skipped — ${result.unreachable}`));
  }

  // What the push looked at. Printed for every push, because "nothing to do"
  // and "everything was already up to date" are the same outcome and a report
  // that shows only what it wrote cannot tell them apart.
  if (result.pushConsidered !== undefined) {
    const seen = result.pushConsidered;
    const unchanged = Math.max(0, seen.mirrored - seen.changed);
    const parts = [`${seen.mirrored} mirrored`];
    if (seen.changed > 0) parts.push(`${seen.changed} changed`);
    if (unchanged > 0) parts.push(`${unchanged} unchanged`);
    if (seen.created > 0) parts.push(`${seen.created} not yet filed`);
    out();
    out(dim(`  ${parts.join(' · ')}`));
  }

  // What the push had to create on the remote before it could file anything.
  // Printed above the plan, because it happened first.
  if (result.prerequisites !== undefined) {
    const made = result.prerequisites;
    out();
    for (const label of made.labels) out(`  ${green('created')}  label ${label}`);
    for (const sprint of made.sprints) out(`  ${green('created')}  sprint ${sprint}`);
    if (made.projectFields > 0) {
      out(`  ${green('created')}  ${plural(made.projectFields, 'Project field')}`);
    }
    if (made.projectOptions > 0) {
      out(`  ${green('created')}  ${plural(made.projectOptions, 'Project option')}`);
    }
    // Everything the remote refused, all of it, in one list. The push went
    // ahead without them; whatever needed one failed as its own operation.
    for (const failure of made.failures) {
      out(`  ${yellow('refused')}  ${failure.what}`);
      out(`           ${dim(failure.message)}`);
      for (const detail of failure.details) out(`           ${dim(detail)}`);
    }
  }
  if (result.prerequisiteFailure !== undefined) {
    // Reported, not fatal: the push went ahead. Whatever needed it will have
    // failed as its own operation below.
    out();
    out(`  ${yellow('not created')}  ${result.prerequisiteFailure.message}`);
    for (const detail of result.prerequisiteFailure.details) out(`               ${dim(detail)}`);
  }
  if (result.pendingPrerequisites !== undefined) {
    const pending = result.pendingPrerequisites;
    out();
    for (const label of pending.labels) out(`  ${cyan('to create')}  label ${label}`);
    for (const sprint of pending.sprints) out(`  ${cyan('to create')}  sprint ${sprint.name}`);
    if (pending.project !== undefined && !pending.project.plan.empty) {
      out(`  ${cyan('to create')}  ${plural(pending.project.plan.createFields.length, 'Project field')}`);
    }
  }

  if (result.dryRun) {
    if (result.renders && result.renders.length > 0) {
      const labels = result.direction === 'both' ? ['pull', 'push'] : [result.direction];
      result.renders.forEach((render, index) => {
        out();
        out(bold(`${labels[index] ?? verb}:`));
        out(render.text);
      });
      if (result.direction === 'both') {
        out();
        out(dim('The push plan is computed against the board as it stands now — the pull above would change it first.'));
      }
    } else if (!result.preflightBlocked && result.unreachable === undefined) {
      out();
      out(dim('Nothing to do.'));
    }
    out();
    out(yellow('Dry run — nothing was written.'));
    return;
  }

  if (result.pullResult !== undefined) renderPullResult(result.pullResult);
  if (result.pullPlan !== undefined) renderPullConflicts(result.pullPlan);
  if (result.consentRefused !== undefined) renderConsentRefusal(result.consentRefused);
  if (result.pushResult !== undefined) renderPushResult(result.pushResult);
}

/** The push the consent gate refused (LP-350, LP-351): why, and the way past it. */
function renderConsentRefusal(refusal: ConsentRefusal): void {
  out();
  const creates = refusal.counts.creates;
  const closes = refusal.counts.closes;
  const deletes = refusal.counts.deletes;
  if (refusal.reason === 'threshold') {
    out(
      red('Push refused') +
        ` — the plan would create ${creates}, close ${closes} and delete ${deletes}: ${plural(creates + closes + deletes, 'issue')} in all, more than the threshold of ${refusal.threshold}`,
    );
    out(dim('Re-run with --yes to confirm, or raise the threshold in the remote config.'));
  } else if (refusal.reason === 'delete') {
    out(
      red('Push refused') +
        ` — the plan would delete ${deletes} ${plural(deletes, 'remote issue')} on ${refusal.target}`,
    );
    out(dim('A deletion is never remembered: re-run with --yes to confirm this one run.'));
  } else {
    out(
      red('Push refused') +
        ` — this is the first write to ${refusal.target} (${creates} to create, ${closes} to close)`,
    );
    out(dim('Run from a terminal to confirm, or re-run with --yes.'));
  }
}

/** The pull's unresolved conflicts — a question left for `lpm remote resolve`. */
function renderPullConflicts(plan: PullPlan): void {
  const conflicts = plan.conflicts ?? [];
  const fieldConflicts = plan.fieldConflicts ?? [];
  if (conflicts.length === 0 && fieldConflicts.length === 0) return;

  out();
  out(bold('conflicted'));
  for (const conflict of conflicts) {
    out(`  ${conflict.localId}  ${dim(`(${conflict.remoteId})`)}  ${conflict.reason}`);
  }
  for (const conflict of fieldConflicts) {
    out(
      `  ${conflict.localId}  ${pad(conflict.field, 16)} local: ${pad(fmt(conflict.local), 24)} remote: ${fmt(conflict.remote)}`,
    );
  }
  out();
  out(dim('Settle each one with `lpm remote resolve <id> --local|--remote`, then sync again.'));
}

/** The applied pull summary: what linked, unlinked, decoupled and failed. */
function renderPullResult(result: PullResult): void {
  out();
  out(`  ${pad('pulled', 14)}${result.applied.length}`);
  out(`  ${pad('linked', 14)}${result.linked.length}`);
  out(`  ${pad('unlinked', 14)}${result.unlinked.length}`);
  out(`  ${pad('decoupled', 14)}${result.decoupled.length}`);
  if (result.appendedComments > 0) {
    out(`  ${pad('comments', 14)}${result.appendedComments}`);
  }
  for (const line of summarizePushFailures(result.failures)) {
    out(`  ${red('failed')}  ${line}`);
  }
}

/** The applied push summary: what filed, moved, skipped, conflicted and failed. */
function renderPushResult(result: PushExecutionResult): void {
  out();
  out(`  ${pad('created', 14)}${result.summary.created}`);
  out(`  ${pad('updated', 14)}${result.summary.updated}`);
  out(`  ${pad('skipped', 14)}${result.summary.skipped}`);
  out(`  ${pad('conflicted', 14)}${result.summary.conflicted}`);
  out(`  ${pad('failed', 14)}${result.summary.failed}`);
  if (result.stopped !== undefined) {
    out();
    out(`  ${yellow('stopped')}  ${result.stopped.reason} — ${result.stopped.detail}`);
    if (result.stopped.deferred !== undefined && result.stopped.deferred > 0) {
      out(
        `  ${yellow('deferred')}  ${result.stopped.deferred} write ${result.stopped.deferred === 1 ? 'operation' : 'operations'} not run — re-run to continue`,
      );
    }
  }
  for (const op of result.conflicted) {
    out(`  ${yellow('conflicted')}  ${op.kind} ${op.localId}  ${op.error}`);
  }
  for (const op of result.failed) {
    out(`  ${red('failed')}  ${op.kind} ${op.localId}  ${op.error}`);
  }
}

// -- log -------------------------------------------------------------------

/**
 * `lpm remote log [<name>] [--since <iso>] [--json]` — read the sync audit
 * log back (LP-352), most recent first.
 *
 * The log is the record of every applied sync, not a mechanism: this command
 * only reads it. `--since` keeps only runs at or after a timestamp;
 * `--json` emits the entries themselves, one per line's worth of JSON, for a
 * script. The file is append-only and line-delimited, so concurrent runs and
 * git merges leave it readable — a malformed line is skipped, not fatal.
 */
function log(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      since: { type: 'string' },
      json: { type: 'boolean' },
    },
  });

  const board = requireBoard();
  const names = remoteNames(board.config);
  if (names.length === 0) {
    throw new BoardError('This board declares no remotes', [
      'Add a remotes: block to .lpm/config.yml first.',
    ]);
  }
  if (positionals.length > 1) {
    throw new BoardError(`Only one remote name is accepted (got "${positionals.join('", "')}")`, [
      'Usage: lpm remote log [<name>] [--since <iso>] [--json]',
    ]);
  }

  const name = positionals[0] ?? singleRemote(board, names);
  if (!names.includes(name)) {
    throw new BoardError(`No remote named "${name}"`, [
      names.length > 0 ? `Declared remotes: ${names.join(', ')}` : 'This board declares no remotes',
    ]);
  }

  let entries = readSyncAudit(board.paths, name);
  if (values.since !== undefined) {
    const since = values.since;
    if (Number.isNaN(Date.parse(since))) {
      throw new BoardError(`--since is not a timestamp (got "${since}")`, [
        'Give an ISO timestamp, e.g. --since 2026-08-16T00:00:00Z.',
      ]);
    }
    const floor = new Date(since).toISOString();
    entries = entries.filter((entry) => entry.at >= floor);
  }
  // Most recent first: the question the log answers is usually "what just
  // happened", and the newest answer is the one a reader wants.
  entries = entries.slice().reverse();

  if (values.json === true) {
    out(JSON.stringify(entries, null, 2));
    return 0;
  }

  renderLog(name, entries);
  return 0;
}

/** Render the last runs of one remote's sync log. */
function renderLog(name: string, entries: SyncAuditEntry[]): void {
  out();
  if (entries.length === 0) {
    out(`${bold(`Remote ${cyan(name)}`)} — ${dim('no syncs recorded yet')}`);
    out();
    out(dim('Each applied push, pull or sync appends a line — run one, then ask again.'));
    return;
  }

  out(`${bold(`Remote ${cyan(name)}`)} — ${plural(entries.length, 'sync')} in the log`);
  out();
  for (const entry of entries) {
    const at = entry.at.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
    const counts = entry.counts;
    const parts = [
      `created ${counts.created}`,
      `updated ${counts.updated}`,
      `skipped ${counts.skipped}`,
      `conflicted ${counts.conflicted}`,
      `failed ${counts.failed}`,
    ];
    if (counts.pulled > 0) parts.push(`pulled ${counts.pulled}`);
    if (counts.linked > 0) parts.push(`linked ${counts.linked}`);
    if (counts.unlinked > 0) parts.push(`unlinked ${counts.unlinked}`);
    if (counts.decoupled > 0) parts.push(`decoupled ${counts.decoupled}`);

    out(
      `  ${dim(at)}  ${pad(entry.direction, 4)}  ${pad(entry.author, 14)}  ${parts.join('  ')}`,
    );
    for (const op of entry.operations) {
      if (op.status === 'failed' || op.status === 'conflicted') {
        out(`    ${red(op.status)}  ${pad(op.kind, 14)} ${op.localId}  ${dim(op.error ?? op.reason ?? '')}`);
      }
    }
    if (entry.error !== undefined) {
      out(`    ${red('error')}  ${entry.error}`);
    }
  }
}

// -- ledger ------------------------------------------------------------------

/**
 * `lpm remote ledger [<name>]` — where each document is filed.
 *
 * The answer to "is this on Jira or on GitHub, and what is it called there?",
 * which before this was a question you answered by opening two JSON files. It
 * is a read of the link stores every remote already keeps (`src/remote/ledger.ts`),
 * so there is nothing here that can be out of date with them.
 *
 * It also reports the state the one-remote-per-document rule exists to prevent:
 * a document that appears in two stores at once, which a hand edit or a merge
 * that took both sides can produce. That is an error, not a warning — the next
 * sync of either remote would write a different truth onto the same document.
 */
function ledger(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { unlinked: { type: 'boolean' } },
  });
  const board = requireBoard();
  const names = remoteNames(board.config);
  if (names.length === 0) {
    throw new BoardError('This board is not connected to a remote', [
      'Connect one first:  lpm remote connect <provider>',
    ]);
  }
  const wanted = positionals[0];
  if (wanted !== undefined && !names.includes(wanted)) {
    throw new BoardError(`No remote named "${wanted}"`, [`Declared remotes: ${names.join(', ')}`]);
  }

  const book = buildLedger(board.paths, board.config);
  const rows = [...book.byLocalId.values()]
    .filter((entry) => wanted === undefined || entry.remote === wanted)
    .sort((a, b) => a.localId.localeCompare(b.localId));

  out();
  out(bold(`Ledger${wanted !== undefined ? ` — ${cyan(wanted)}` : ''}`));
  out();
  if (rows.length === 0) {
    out(dim('  No document is mirrored yet.'));
    // An id off this board, so the suggestion is a command that would work.
    const example = board.issues[0]?.id;
    out(dim(`  Push one:  lpm remote push${example !== undefined ? ` ${example}` : ' <id>'}`));
  } else {
    const idWidth = Math.max(...rows.map((row) => row.localId.length), 2);
    const remoteWidth = Math.max(...rows.map((row) => row.remote.length), 6);
    for (const row of rows) {
      const title = board.byId.get(row.localId)?.title;
      out(
        `  ${pad(row.localId, idWidth)}  ${cyan(pad(row.remote, remoteWidth))}  ` +
          `${pad(row.remoteKey || row.remoteId, 24)}${title ? dim(`  ${title}`) : ''}`,
      );
    }
  }

  // The documents nobody has filed anywhere — what is left to push, which is
  // the other half of the question this command answers.
  const unfiled = board.issues.filter((issue) => !book.byLocalId.has(issue.id));
  out();
  out(
    dim(
      `  ${rows.length} mirrored, ${unfiled.length} not yet` +
        (values.unlinked === true || unfiled.length === 0 ? '' : '  (--unlinked lists them)'),
    ),
  );
  if (values.unlinked === true && unfiled.length > 0) {
    out();
    for (const issue of unfiled) out(`  ${pad(issue.id, 8)} ${dim(issue.title)}`);
  }

  const clashes = conflicts(board.paths, board.config);
  if (clashes.length > 0) {
    out();
    out(red(`${plural(clashes.length, 'document')} mirrored on more than one remote:`));
    for (const group of clashes) {
      out(
        `  ${group[0]!.localId}  ${group
          .map((entry) => `${entry.remote} (${entry.remoteKey || entry.remoteId})`)
          .join('  ')}`,
      );
    }
    out(dim('  Drop the link you do not want:  lpm remote decouple <id>'));
    return 1;
  }
  return 0;
}

// -- connect -----------------------------------------------------------------

/**
 * `lpm remote connect [<provider>] [--name <n>] [--<key> <value>...]` — the one
 * command between a board and a tracker.
 *
 * Connecting used to be three commands in a fixed order (`add`, then `login`,
 * then `setup`), each of which printed the next, and every one of them could be
 * run in the wrong order or forgotten. None of them is hard; what was hard was
 * knowing that there were three, which is a thing a tool can simply do for
 * somebody. So this asks for what it cannot work out — the provider, where the
 * project is, the credential — and then does the rest: declares the remote,
 * stores the secret, asks the remote what its own words are, corrects the
 * mapping, and offers to create what the mapping names and the remote lacks.
 *
 * It is a wizard over the primitives, never a second implementation of them:
 * `addRemote`, `writeCredential` and `inspectRemote` are the same calls
 * `add`, `login` and `setup` make. Those three stay, and stay documented, for
 * the case with nobody to ask — a CI job, a Dockerfile, an agent.
 *
 * Every question can be answered ahead of time with a flag, and a run with all
 * of them answered asks nothing at all, which is what makes this scriptable
 * too. What cannot be a flag is the credential: it is never on a command line.
 */
function connect(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...addOptions(), name: { type: 'string' } },
  });
  const raw = values as Record<string, unknown>;
  const stringOption = (key: string): string | undefined => {
    const value = raw[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

  // -- 1. the provider ------------------------------------------------------
  const asked = positionals[0] ?? stringOption('provider');
  if (positionals.length > 1) {
    throw new BoardError(`Only one provider is accepted (got "${positionals.join('", "')}")`, [
      'Usage: lpm remote connect <provider> [--name <n>] [--<key> <value>...]',
    ]);
  }
  const providerName = asked ?? askProvider(interactive);
  if (!registeredProviders().includes(providerName)) {
    throw new BoardError(`No provider named "${providerName}"`, [
      `Registered providers: ${registeredProviders().join(', ')}`,
    ]);
  }
  const provider = lookupProvider(providerName);

  // -- 2. the name ----------------------------------------------------------
  // A remote is named after its provider unless somebody says otherwise, which
  // is what makes `lpm remote push --remote jira` readable without anybody
  // having had to invent a word.
  const board = requireBoard();
  const existing = remoteNames(board.config);
  const name = stringOption('name') ?? providerName;
  if (existing.includes(name) && raw.force !== true) {
    throw new BoardError(`This board already has a remote named "${name}"`, [
      `Reconnect it:      lpm remote connect ${providerName} --name ${name} --force`,
      `Check it instead:  lpm remote setup ${name}`,
    ]);
  }

  // -- 3. where the project is ---------------------------------------------
  const flags = connectionFlags(provider);
  const connection: Record<string, unknown> = {};
  for (const flag of flags) {
    if (flag.type === 'boolean') {
      if (raw[flag.name] === true) connection[flag.name] = true;
      continue;
    }
    const given = stringOption(flag.name);
    if (given !== undefined) {
      connection[flag.name] = given;
      continue;
    }
    if (!flag.required) continue;
    if (!interactive) {
      throw new BoardError(`--${flag.name} is required for provider "${providerName}"`, [
        `Connection flags for ${providerName}: ${describeFlags(flags)}`,
        'With a terminal, `lpm remote connect` asks for each of these instead.',
      ]);
    }
    out();
    const answer = ask(`  ${flag.name}${connectionHint(providerName, flag.name)}: `);
    if (answer === null) {
      throw new BoardError(`No ${flag.name} given`, [
        `Provider "${providerName}" cannot be reached without it.`,
      ]);
    }
    connection[flag.name] = answer;
  }

  // -- 4. declare it --------------------------------------------------------
  const result = addRemote(board.paths, {
    name,
    provider: providerName,
    connection,
    scope: stringOption('scope'),
    force: raw.force === true,
  });

  out();
  out(`${bold(`Connected ${cyan(result.name)}`)} — ${result.provider}${result.replaced ? ` ${dim('(replaced)')}` : ''}`);
  out(`  ${pad('target', 10)} ${result.target}`);
  const scope = stringOption('scope');
  if (scope) out(`  ${pad('scope', 10)} ${scope}`);
  renderMappingDraft(result, providerName);

  // -- 5. the credential ----------------------------------------------------
  const secrets = Object.keys(provider.credentials?.secrets ?? {});
  const fresh = requireBoard();
  if (secrets.length > 0) {
    const states = credentialStates(
      result.name,
      result.connection,
      provider.credentials?.secrets ?? {},
      fresh.paths,
    );
    const missing = states.filter((state) => state.source === undefined).map((state) => state.key);
    if (missing.length > 0 && interactive) {
      const written = loginInteractively(fresh, result.name, providerName, missing);
      if (written.length > 0) ensureLocalIgnored(fresh.paths);
    } else if (missing.length > 0) {
      out();
      renderCredentialGuide(fresh, result.name, providerName, result.connection);
      out();
      out(yellow('Stopped: the credential above is needed to ask the remote anything.'));
      return 1;
    }
  }

  // -- 6. ask the remote what it is, and make the mapping say it ------------
  const ready = requireBoard();
  const resolved = credentialStates(
    result.name,
    result.connection,
    provider.credentials?.secrets ?? {},
    ready.paths,
  ).every((state) => state.source !== undefined);
  if (!resolved) {
    out();
    renderCredentialGuide(ready, result.name, providerName, result.connection);
    out();
    out(yellow('Stopped: nothing was stored, so the remote cannot be asked anything yet.'));
    out(dim(`When you have it:  lpm remote setup ${result.name}`));
    return 1;
  }

  // An id off this board, so the example is a command somebody can actually run.
  const example = ready.issues[0]?.id;
  void inspectRemote(ready, result.name, { dryRun: false, interactive })
    .then((exit) => {
      renderNextSteps(result.name, exit, example);
      if (exit !== 0) process.exitCode = exit;
    })
    .catch(reportAsyncError);

  return 0;
}

/** Offer the registered providers, with what each one needs as the detail. */
function askProvider(interactive: boolean): string {
  const names = registeredProviders();
  if (!interactive) {
    throw new BoardError('Name the provider to connect to', [
      `Registered providers: ${names.join(', ')}`,
      'e.g. lpm remote connect github --repo acme/payments',
    ]);
  }
  return choose(
    'Which tracker?',
    names.map((providerName) => ({
      value: providerName,
      label: providerName,
      detail: describeFlags(connectionFlags(lookupProvider(providerName))) || 'no connection details needed',
    })),
    'the provider as the first argument',
  );
}

/**
 * A worked example beside a connection question, so "site" is not a riddle.
 *
 * The examples live in `src/remote/connection-catalogue.ts`, keyed by
 * connection key rather than by platform, because the web connect form shows
 * the same ones — a key nobody has written an example for simply gets none.
 */
function connectionHint(providerName: string, key: string): string {
  const example = connectionExample(key);
  return example !== undefined ? ` (${example})` : ` for ${providerName}`;
}

/** What `add` and `connect` both say about the mapping they just drafted. */
function renderMappingDraft(result: AddRemoteResult, providerName: string): void {
  out();
  if (result.markers.length === 0) {
    const convention = lookupProvider(providerName).standardVocabulary?.describe;
    out(
      dim(
        `The mapping was drafted from this board's own types and statuses` +
          (convention ? `, against ${convention}` : '') +
          ` — nothing left to fill in before the first sync.`,
      ),
    );
    if (convention) {
      out(
        dim(
          `Those names are the platform's convention, not this ${providerName}'s: ` +
            `the live remote is asked next, and a push checks them before it writes.`,
        ),
      );
    }
    return;
  }
  out(
    dim(
      `The mapping was drafted from this board's own types and statuses. ` +
        `${plural(result.markers.length, 'decision')} ` +
        `${result.markers.length === 1 ? 'has' : 'have'} no obvious remote counterpart and ` +
        `${result.markers.length === 1 ? 'is' : 'are'} left as a TODO in .lpm/config.yml:`,
    ),
  );
  for (const marker of result.markers) {
    out(dim(`  remotes.${result.name}.mapping.${marker.path}: ${marker.question}`));
  }
}

// -- login ------------------------------------------------------------------

/**
 * `lpm remote login <name>` — store a credential for one remote in the
 * git-ignored `.lpm/credentials.json`, never in the committed config (LP-295).
 *
 * Two ways in, chosen by whether there is a terminal to ask rather than by a
 * flag. At a terminal it **asks**, once per credential key the provider
 * declares — Jira's email *and* its API token in one command — reading each
 * with echo off and keeping whatever is already resolvable on a bare Enter.
 * Piped, it reads one value from stdin, which is what a script and a CI job
 * hand it.
 *
 * The interactive half exists because the piped half was the *only* half, and
 * "each key is a command: `echo <value> | lpm remote login jira` for the token
 * and `lpm remote login jira --key email` for the email" is a shell trick to
 * learn before a person can hand over two values they already have in front of
 * them. Neither form takes the value as a flag: that is what keeps it out of
 * shell history, and it is the one property of this command worth defending.
 */
function login(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { key: { type: 'string' } },
  });
  const board = requireBoard();
  const names = remoteNames(board.config);

  const name = positionals[0] ?? singleRemote(board, names);
  const remote = remoteNamed(board.config, name);
  if (!remote) {
    throw new BoardError(`No remote named "${name}"`, [
      names.length > 0 ? `Declared remotes: ${names.join(', ')}` : 'This board declares no remotes',
    ]);
  }

  // Which connection keys this command may write. Derived from the provider's
  // own descriptor rather than hard-coded to `token`, which is what made this
  // command useless for a provider whose secret is called something else.
  const providerName = remote.provider;
  const provider = lookupProvider(providerName);
  const secrets = provider.credentials?.secrets ?? {};
  const declared = Object.keys(secrets);
  if (declared.length === 0) {
    throw new BoardError(`Remote "${name}" (${providerName}) needs no credential`, [
      'This provider holds no secrets, so there is nothing to store.',
    ]);
  }

  const asked = typeof values.key === 'string' && values.key !== '' ? values.key : undefined;
  if (asked !== undefined && !declared.includes(asked)) {
    throw new BoardError(`"${asked}" is not a credential of provider "${providerName}"`, [
      `Its credential keys are: ${declared.join(', ')}`,
      `e.g. lpm remote login ${name} --key ${declared[0]}`,
    ]);
  }

  const written = process.stdin.isTTY
    ? loginInteractively(board, name, providerName, asked ? [asked] : declared)
    : [loginFromStdin(board, name, asked ?? loginKeyFor(providerName))];

  if (written.length === 0) {
    out(dim('Nothing changed — every credential was left as it stood.'));
    return 0;
  }
  ensureLocalIgnored(board.paths);
  out(
    `Saved ${written.map((key) => cyan(key)).join(' and ')} for remote "${name}" in ` +
      '.lpm/credentials.json (never echoed, never committed).',
  );
  return 0;
}

/**
 * Ask for each credential key in turn and write the ones that were answered.
 *
 * A key that already resolves — from the environment, from an earlier login —
 * is shown with its source and skipped on a bare Enter, so re-running the
 * command to replace one expired token does not demand the other value back.
 */
function loginInteractively(
  board: LoadedBoard,
  name: string,
  providerName: string,
  keys: string[],
): string[] {
  const provider = lookupProvider(providerName);
  const secrets = provider.credentials?.secrets ?? {};
  const visible = new Set(provider.credentials?.visible ?? []);
  const states = credentialStates(name, connectionOf(board, name), secrets, board.paths);

  out();
  out(bold(`Credential for remote ${cyan(name)} (${providerName})`));
  if (provider.credentials?.url) out(`  ${dim(`create one at ${provider.credentials.url}`)}`);
  out(dim('  Typed values are stored in .lpm/credentials.json, which is git-ignored.'));
  out();

  const written: string[] = [];
  for (const key of keys) {
    const held = states.find((state) => state.key === key)?.source;
    if (held !== undefined) out(`  ${dim(`${key} is already set from ${held} — Enter keeps it.`)}`);
    const value = ask(`  ${key}: `, { secret: !visible.has(key) });
    if (value === null) {
      if (held === undefined) out(`  ${yellow('skipped')} ${dim(`${key} is still not set.`)}`);
      continue;
    }
    writeCredential(board.paths, name, key, value);
    written.push(key);
  }
  out();
  return written;
}

/**
 * Read one value from piped stdin and write it under one key — the form a
 * script uses, and the form every doc showed before there was another.
 */
function loginFromStdin(board: LoadedBoard, name: string, key: string): string {
  let piped: string;
  try {
    piped = readFileSync(0, 'utf8');
  } catch (error) {
    throw new BoardError(`Cannot read the ${key} from stdin`, [(error as Error).message]);
  }
  const value = piped.trim();
  if (value === '') {
    throw new BoardError(`No ${key} given`, [
      `Run it at a terminal and it asks:  lpm remote login ${name}`,
      `Or pipe it in, so it never lands in shell history:  echo <value> | lpm remote login ${name}` +
        (key === loginKeyFor(providerOf(board, name)) ? '' : ` --key ${key}`),
    ]);
  }
  writeCredential(board.paths, name, key, value);
  return key;
}

/** The declared connection block of one remote, for a credential state read. */
function connectionOf(board: LoadedBoard, name: string): Record<string, unknown> {
  const connection = remoteNamed(board.config, name)?.connection;
  return (connection ?? {}) as Record<string, unknown>;
}

/** The provider one remote is declared with. */
function providerOf(board: LoadedBoard, name: string): string {
  return remoteNamed(board.config, name)!.provider;
}

// -- setup -------------------------------------------------------------------

/**
 * `lpm remote setup <name> [--dry-run]` — ask the remote what its words are and
 * make the mapping say them.
 *
 * This is the step between "declared" and "syncing", and before it existed the
 * person had to *be* that step: `add` drafted a mapping from a convention (or
 * left a `TODO:` per decision), and finding out whether the convention matched
 * the project meant reading the project in a browser and hand-editing YAML. The
 * facts are all on the wire — an issue-type scheme and a status list are two
 * requests — so the tool asks.
 *
 * What it does, in order, and what each step is for:
 *
 *   1. **the credential** — reported before anything else, because every step
 *      below needs one and "no credential yet" is the commonest reason setup is
 *      being run at all. A missing one prints the same guide `add` prints and
 *      stops; it is not an error the person has to decode.
 *   2. **reachability** — `reachable()` separates "your token cannot see this
 *      project" from "your mapping is wrong", which are otherwise the same 404.
 *   3. **the vocabulary** — `connector.vocabulary()`, reconciled against the
 *      mapping. A word spelled differently is corrected in place; a word the
 *      remote does not have at all is reported together with the list of the
 *      ones it does, which is the answer the old `TODO:` marker asked for
 *      without ever supplying.
 *   4. **what the remote has not got** — split by who creates it. The
 *      vocabulary (labels, Project fields) the next push makes for itself;
 *      the periods it does not, because filing the timeline is something you
 *      ask for. `setup` never writes to the remote itself either way.
 *
 * Read-only on the remote, always. The only thing it writes is `config.yml`,
 * and `--dry-run` writes nothing at all.
 */
function setup(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' } },
  });
  const dryRun = values['dry-run'] === true;
  const board = requireBoard();
  const name = positionals[0] ?? singleRemote(board, remoteNames(board.config));
  const declared = remoteNamed(board.config, name);
  if (!declared) {
    throw new BoardError(`No remote named "${name}"`, [
      `Declared remotes: ${remoteNames(board.config).join(', ') || 'none'}`,
    ]);
  }

  out();
  out(`${bold(`Remote ${cyan(name)}`)} — ${declared.provider}${dryRun ? ` ${dim('(dry run)')}` : ''}`);
  out();

  const credential = renderCredentialGuide(board, name, declared.provider, declared.connection);
  if (!credential.satisfied) {
    out();
    out(yellow('Setup stopped: the credential above is needed to ask the remote anything.'));
    out(dim('Everything else — the mapping, the labels — is checked once it resolves.'));
    return 1;
  }

  void inspectRemote(board, name, { dryRun, interactive: false })
    .then((exit) => {
      renderNextSteps(name, exit, undefined);
      if (exit !== 0) process.exitCode = exit;
    })
    .catch(reportAsyncError);

  return 0;
}

/**
 * Ask the remote about itself and make the mapping say what it says.
 *
 * The *decisions* live in `inspectRemoteConnection` (`src/remote/inspect.ts`),
 * shared with the web UI so a browser tab and this command cannot answer
 * differently. This function renders the report and, at a terminal, asks what
 * the report left for a person: a connection key the remote offered several
 * values for, and a word the remote does not have.
 *
 * In order, and each step is a question the next one depends on:
 *
 *   1. **reachability** — separates "your token cannot see this project" from
 *      "your mapping is wrong", which are otherwise the same 404.
 *   2. **discovery** — a connection key only part of the mapping needs, asked
 *      of the remote rather than of the person.
 *   3. **the vocabulary** — reconciled against the mapping. A word spelled
 *      differently is corrected in place; a word the remote does not have is
 *      asked about when there is somebody to ask, and otherwise reported beside
 *      the list of names the remote does have.
 *   4. **what is missing** — the vocabulary the next push creates for itself
 *      (labels, Project fields), and the periods it will not.
 *
 * Returns the exit code: 0 when nothing is left unanswered, 1 otherwise, so
 * CI can gate on a remote being set up.
 */
async function inspectRemote(
  board: LoadedBoard,
  name: string,
  options: { dryRun: boolean; interactive: boolean },
): Promise<number> {
  const declared = remoteNamed(board.config, name)!;
  const report = await inspectRemoteConnection(board, name, { apply: !options.dryRun });

  out();
  if (report.reachability !== undefined) {
    out(
      report.reachability.reachable
        ? `${green('reachable')}  ${dim(report.reachability.evidence)}`
        : `${red('unreachable')}  ${dim(report.reachability.evidence)}`,
    );
    if (report.stopped) {
      out();
      out(yellow('Stopped: the remote could not be reached with this credential.'));
      return 1;
    }
    out();
  }

  let exit = askDiscovered(board, name, report, options);

  if (report.vocabulary !== undefined) {
    const { report: reconciled, corrections: renames } = report.vocabulary;
    renderReconcile(reconciled);

    // A word the remote does not have is the one thing the inspection cannot
    // work out, and it is also the one a person answers in a second — so ask,
    // rather than printing a list and a file path.
    let answered: MappingCorrections = {};
    if (options.interactive && !options.dryRun && hasUnresolved(reconciled)) {
      answered = askUnresolved(reconciled);
    }

    const countOf = (changes: MappingCorrections): number =>
      Object.keys(changes.types ?? {}).length + Object.keys(changes.statuses ?? {}).length;
    if (countOf(renames) > 0 || countOf(answered) > 0) {
      if (options.dryRun) {
        out(dim('Dry run — config.yml was not changed.'));
      } else {
        const lines = [
          ...report.written.filter((line) => line.startsWith('types.') || line.startsWith('statuses.')),
          ...(countOf(answered) > 0 ? applyInspectAnswers(board.paths, board.config, name, answered) : []),
        ];
        out(`${bold('Corrected')} in .lpm/config.yml:`);
        for (const line of lines) out(`  ${green(line)}`);
      }
      out();
    }

    // Still unanswered after the questions (or with none asked) — the signal
    // CI gates on.
    const answeredKeys = (block: 'types' | 'statuses'): Set<string> =>
      new Set(Object.keys(answered[block] ?? {}));
    const stillUnresolved =
      unresolvedOf(reconciled.types).some((key) => !answeredKeys('types').has(key)) ||
      unresolvedOf(reconciled.statuses).some((key) => !answeredKeys('statuses').has(key));
    if (stillUnresolved) exit = 1;
  } else {
    out(
      dim(
        `${declared.provider} has no vocabulary to ask about — its types and statuses are names this board chooses.`,
      ),
    );
    out();
  }

  // What the remote has not got yet, split by who creates it. The *vocabulary*
  // a mapping needs — labels, Project fields — is made by the next push; the
  // *timeline* is filed only when asked for (`lpm remote push <period-id>`).
  const missing = report.prerequisites!;
  const vocabulary: string[] = [];
  if (missing.labels.length > 0) vocabulary.push(plural(missing.labels.length, 'label'));
  if (missing.projectFields > 0) vocabulary.push(plural(missing.projectFields, 'Project field'));
  if (vocabulary.length > 0) {
    out(`${cyan('to create')}  ${vocabulary.join(', ')} ${dim('— the next push creates them')}`);
    for (const label of missing.labels.slice(0, MAX_LISTED_PREREQUISITES)) {
      out(`           ${dim(label)}`);
    }
    out();
  }
  if (missing.sprints.length > 0) {
    out(
      `${cyan('not filed')}  ${plural(missing.sprints.length, 'period')} ` +
        dim('— a push of work never files the timeline'),
    );
    for (const sprint of missing.sprints.slice(0, MAX_LISTED_PREREQUISITES)) {
      out(`           ${dim(sprint)}`);
    }
    out(dim(`           file one with: lpm remote push <period-id>`));
    out();
  }
  if (vocabulary.length === 0 && missing.sprints.length === 0 && missing.canListLabels) {
    out(`${green('ready')}      everything the mapping names exists on the remote.`);
    out();
  }

  return exit;
}

/** How many names the setup report lists before it stops — it is a summary. */
const MAX_LISTED_PREREQUISITES = 8;

/**
 * Show what discovery found and ask about what it could not decide.
 *
 * One candidate was already written by the inspection — being told "I found
 * your board and wrote it down" is the whole point, and a value the remote
 * itself reported is not a guess. Several is a question when there is somebody
 * to ask. None leaves the provider's own `why` on screen, and the push
 * preflight refuses until it is answered, so nothing is silently half-set up.
 */
function askDiscovered(
  board: LoadedBoard,
  name: string,
  report: InspectReport,
  options: { dryRun: boolean; interactive: boolean },
): number {
  if (report.found.length + report.choices.length + report.needed.length === 0) return 0;

  let exit = 0;
  const answers: Record<string, string> = {};
  for (const found of report.found) {
    out(`${green('found')}     ${found.key} ${found.value} ${dim(`— ${found.label}`)}`);
  }
  for (const question of report.choices) {
    if (options.interactive && !options.dryRun) {
      answers[question.key] = choose(
        `  Which ${question.key}?`,
        question.candidates.map((candidate) => ({
          value: candidate.value,
          label: candidate.label,
          detail: `${question.key} ${candidate.value}`,
        })),
        `--${question.key} <value>`,
      );
      continue;
    }
    renderNeeded(question);
    exit = 1;
  }
  for (const question of report.needed) {
    renderNeeded(question);
    exit = 1;
  }

  if (options.dryRun) {
    if (report.found.length > 0) out(dim('Dry run — config.yml was not changed.'));
  } else {
    const lines = [
      ...report.written.filter((line) => line.startsWith('connection.')),
      ...(Object.keys(answers).length > 0
        ? applyInspectAnswers(board.paths, board.config, name, { connection: answers })
        : []),
    ];
    for (const line of lines) out(`  ${green(line)}`);
  }
  out();
  return exit;
}

/** A connection key nobody could answer, with what breaks without it. */
function renderNeeded(question: ConnectionQuestion): void {
  out(`${yellow('needed')}    ${question.key}`);
  for (const line of wrap(question.why, 64)) out(`          ${dim(line)}`);
  for (const candidate of question.candidates) {
    out(`          ${dim(`${candidate.value} — ${candidate.label}`)}`);
  }
}

/**
 * Ask what each word the remote does not have should be instead, offering the
 * words it does have.
 *
 * Only unresolved entries are asked about, the remote's own names are the
 * options, and "leave it" is always one of them — a mapping somebody meant to
 * hand-write is not a mistake to be talked out of.
 */
function askUnresolved(report: ReconcileReport): MappingCorrections {
  const answers: MappingCorrections = {};
  for (const [block, entries] of [
    ['types', report.types],
    ['statuses', report.statuses],
  ] as const) {
    if (!entries) continue;
    for (const entry of entries.entries) {
      if (entry.verdict !== 'unresolved') continue;
      // A long vocabulary is trimmed rather than paged: the point is to answer
      // the common case in one keystroke, and config.yml is still there.
      const offered = entries.candidates.slice(0, MAX_OFFERED_NAMES);
      if (offered.length === 0) continue;
      out();
      out(
        dim(
          `  ${block === 'types' ? 'Type' : 'Status'} "${entry.boardKey}" claims "${entry.claimed}", which ${
            entries.candidates.length === offered.length ? 'the remote does not have' : 'is not among the remote names'
          }.`,
        ),
      );
      const answer = choose(
        `  What is "${entry.boardKey}" called on the remote?`,
        [
          ...offered.map((candidate) => ({
            value: candidate,
            label: candidate,
            detail: `map ${entry.boardKey} to ${candidate}`,
          })),
          { value: KEEP_CLAIM, label: 'leave it', detail: `keep "${entry.claimed}" and fix it by hand` },
        ],
        '--dry-run to answer nothing',
      );
      if (answer === KEEP_CLAIM) continue;
      answers[block] = { ...answers[block], [entry.boardKey]: answer };
    }
  }
  return answers;
}

/**
 * What to do after a `connect` or a `setup`, which is not the same thing on a
 * remote that is ready and one that stopped. Telling somebody to push when the
 * remote could not be reached is advice that cannot work.
 */
function renderNextSteps(name: string, exit: number, example: string | undefined): void {
  out();
  out(bold('Next'));
  if (exit !== 0) {
    out(`  ${pad('answer what is reported above', 32)}${dim('  # in .lpm/config.yml, or by fixing the credential')}`);
    out(`  ${pad(`lpm remote setup ${name}`, 32)}${dim('  # then run this again — it is read-only and repeatable')}`);
    return;
  }
  out(`  ${pad('lpm remote push --dry-run', 32)}${dim('  # read the plan before anything is written')}`);
  if (example !== undefined) {
    out(`  ${pad(`lpm remote push ${example}`, 32)}${dim('  # or file one document at a time')}`);
  } else {
    out(`  ${pad('lpm remote push', 32)}${dim('  # the first write asks once')}`);
  }
}

/** The board keys one reconciled block could not match to a remote name. */
function unresolvedOf(block: ReconcileBlock | undefined): string[] {
  return (block?.entries ?? [])
    .filter((entry) => entry.verdict === 'unresolved')
    .map((entry) => entry.boardKey);
}

/** How many of a remote's own names a question offers before it stops listing. */
const MAX_OFFERED_NAMES = 12;

/** The "leave it alone" answer, which cannot collide with a remote's own name. */
const KEEP_CLAIM = '--keep--';

/** Report a rejected promise the way `index.ts` reports a thrown BoardError. */
function reportAsyncError(error: unknown): void {
  if (error instanceof BoardError) {
    err(`${red('error')} ${error.message}`);
    for (const detail of error.details) err(`       ${detail}`);
  } else {
    err(`${red('error')} ${messageOf(error)}`);
  }
  process.exitCode = 1;
}

/** Print one reconciliation block per vocabulary the remote reported. */
function renderReconcile(report: ReconcileReport): void {
  for (const [label, block] of [
    ['types', report.types],
    ['statuses', report.statuses],
  ] as const) {
    if (!block) continue;
    out(`${bold(label)} ${dim(`— ${plural(block.candidates.length, 'name')} on the remote`)}`);
    for (const entry of block.entries) {
      if (entry.verdict === 'ok') {
        out(`  ${green('ok')}         ${pad(entry.boardKey, 14)} ${entry.claimed}`);
      } else if (entry.verdict === 'renamed') {
        out(
          `  ${cyan('rename')}     ${pad(entry.boardKey, 14)} ${entry.claimed} ${dim('→')} ${entry.resolved}`,
        );
      } else {
        out(`  ${yellow('not there')}  ${pad(entry.boardKey, 14)} ${entry.claimed}`);
      }
    }
    if (block.entries.some((entry) => entry.verdict === 'unresolved')) {
      out(dim(`  the remote has: ${block.candidates.join(', ')}`));
      out(dim('  fix the ones marked "not there" in .lpm/config.yml, then run setup again'));
    }
    out();
  }
}

// -- status -----------------------------------------------------------------

function status(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      verbose: { type: 'boolean' },
      json: { type: 'boolean' },
      local: { type: 'boolean' },
      changed: { type: 'boolean' },
    },
  });
  const board = requireBoard();
  if (!hasRemotes(board.config)) {
    throw new BoardError('This board declares no remotes', [
      'Add a remotes: block to .lpm/config.yml first.',
    ]);
  }

  const name = positionals[0] ?? singleRemote(board, remoteNames(board.config));
  // The report is computed once, by `computeRemoteStatus`, so the CLI, the web
  // route and the MCP tool cannot disagree about drift.  The link store is
  // reloaded here only for the field-level detail `renderStatus` prints.
  const store = loadLinkStore(board.paths, name);

  /**
   * The fetch is the one async half; the `.then` continuation sets
   * `process.exitCode` *after* `index.ts` has assigned the synchronous
   * `run()` result, never before.
   */
  // `--local` skips the remote half: no connector, no request at all. The
  // remote half is now one listing rather than one request per twin, so it is
  // seconds rather than the two minutes it used to be — but `--local` is still
  // the one that needs no credential and cannot fail, which is what a CI step
  // asking "is anything unpushed?" wants. `--changed` is the third gear: only
  // what moved since the last sync's cursor, at the price of saying nothing
  // about what is absent.
  //
  // The progress lines go to **stderr**, because stdout is the report — a
  // `--json` run piped into `jq` must not have "reading page 2" in it.
  void computeRemoteStatus(board, name, {
    verbose: values.verbose === true,
    local: values.local === true,
    changed: values.changed === true,
    onProgress: ({ page, records }) =>
      err(dim(`  reading the tracker — page ${page}, ${plural(records, 'issue')} so far`)),
  })
    .then((report) => {
      if (values.json) {
        renderStatusJson(report);
      } else {
        renderStatus(name, report, store);
      }
      process.exitCode = remoteStatusExitCode(report);
    })
    .catch((error: unknown) => {
      if (error instanceof BoardError) {
        err(`${red('error')} ${error.message}`);
        for (const detail of error.details) err(`       ${detail}`);
      } else {
        err(`${red('error')} ${messageOf(error)}`);
      }
      process.exitCode = 1;
    });

  return 0;
}

// -- resolve ----------------------------------------------------------------

/** The parsed `resolve` arguments: one id, a whole-document owner, per-field owners. */
interface ResolveArgs {
  id: string;
  default?: ResolutionOwner;
  fields: Record<string, ResolutionOwner>;
}

/**
 * Parse `resolve <id> [--local|--remote] [--field <f> --local|--remote]...`.
 *
 * `util.parseArgs` loses the pairing between a `--field` and the owner that
 * follows it, so this walks the argument list itself.  A bare `--local` /
 * `--remote` is the whole-document decision; a `--field <name>` must be
 * immediately followed by `--local` or `--remote`.
 */
function parseResolveArgs(args: string[]): ResolveArgs {
  let id: string | undefined;
  let defaultOwner: ResolutionOwner | undefined;
  const fields: Record<string, ResolutionOwner> = {};

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--local' || arg === '--remote') {
      if (defaultOwner !== undefined) {
        throw new BoardError('Only one whole-document decision is allowed', [
          'Give --local or --remote once, or use --field for per-field decisions.',
        ]);
      }
      defaultOwner = arg === '--local' ? 'local' : 'remote';
      i += 1;
    } else if (arg === '--field') {
      const field = args[i + 1];
      if (!field || field.startsWith('-')) {
        throw new BoardError('--field needs a field name', [
          'Usage: lpm remote resolve <id> --field <name> --local|--remote',
        ]);
      }
      const owner = args[i + 2];
      if (owner !== '--local' && owner !== '--remote') {
        throw new BoardError(`--field ${field} must be followed by --local or --remote`, [
          `Got ${owner ?? 'nothing'} — the two must stay paired.`,
        ]);
      }
      fields[field] = owner === '--local' ? 'local' : 'remote';
      i += 3;
    } else if (arg.startsWith('-')) {
      throw new BoardError(`Unknown option "${arg}"`, [
        'Usage: lpm remote resolve <id> [--local|--remote] [--field <name> --local|--remote]...',
      ]);
    } else {
      if (id !== undefined) {
        throw new BoardError(`Only one document id is accepted (got "${id}" and "${arg}")`, [
          'Usage: lpm remote resolve <id> ...',
        ]);
      }
      id = arg;
      i += 1;
    }
  }

  if (id === undefined) {
    throw new BoardError('Missing document id', [
      'Usage: lpm remote resolve <id> [--local|--remote] ...',
    ]);
  }
  if (defaultOwner === undefined && Object.keys(fields).length === 0) {
    throw new BoardError('Nothing to resolve', [
      'Give --local or --remote, or at least one --field <name> --local|--remote pair.',
    ]);
  }

  return { id, default: defaultOwner, fields };
}

/**
 * The one remote whose link store satisfies `holds` for `localId`.  A
 * name-less command on a multi-remote board is ambiguous, and an id held by
 * no remote (or by several) is an error naming the choice — never a silent
 * pick.
 */
function remoteHolding(
  board: LoadedBoard,
  localId: string,
  holds: (store: ReturnType<typeof loadLinkStore>) => boolean,
  missing: string,
): string {
  const names = remoteNames(board.config);
  if (names.length === 0) {
    throw new BoardError('This board declares no remotes', [
      'Add a remotes: block to .lpm/config.yml first.',
    ]);
  }
  const holders = names.filter((name) => holds(loadLinkStore(board.paths, name)));
  if (holders.length === 0) {
    throw new BoardError(missing, [`Declared remotes: ${names.join(', ')}`]);
  }
  if (holders.length > 1) {
    throw new BoardError(`${localId} is held under more than one remote`, [
      `Holding remotes: ${holders.join(', ')}`,
      'Act on it once per remote.',
    ]);
  }
  return holders[0]!;
}

/** The remote name a `resolve <id>` acts on: the one whose link store holds the id. */
function remoteOfDocument(board: LoadedBoard, localId: string): string {
  return remoteHolding(
    board,
    localId,
    (store) => store.links.has(localId),
    `${localId} is not linked to any remote`,
  );
}

/** The remote name a `decouple <id>` acts on: one holding a link or a tombstone. */
function remoteOfLinkOrTombstone(board: LoadedBoard, localId: string): string {
  return remoteHolding(
    board,
    localId,
    (store) => store.links.has(localId) || store.tombstones.has(localId),
    `${localId} is neither linked nor decoupled on any remote`,
  );
}

/** The remote name a `relink <id>` acts on: one holding a tombstone. */
function remoteOfTombstone(board: LoadedBoard, localId: string): string {
  return remoteHolding(
    board,
    localId,
    (store) => store.tombstones.has(localId),
    `${localId} is not decoupled on any remote`,
  );
}

function resolve(args: string[]): number {
  const parsed = parseResolveArgs(args);
  const board = requireBoard();
  const name = remoteOfDocument(board, parsed.id);

  const remote = openRemote(board.config, name);
  const store = loadLinkStore(board.paths, name);
  const resolutions = loadResolutions(board.paths, name);

  if (!board.byId.has(parsed.id)) {
    throw new BoardError(`No document "${parsed.id}" on this board`, [
      'Resolve names a local document id, e.g. lpm remote resolve LP-12 --local.',
    ]);
  }
  if (!store.links.has(parsed.id)) {
    throw new BoardError(`"${parsed.id}" is not linked to a remote issue on "${name}"`, [
      'There is no twin, so there is nothing to settle — push first to create one.',
    ]);
  }

  // Validate per-field names offline against the mapping's tracked fields.
  const known = trackedFields(remote.mapping);
  for (const field of Object.keys(parsed.fields)) {
    if (!known.has(field)) {
      throw new BoardError(`"${field}" is not a field this remote tracks`, [
        `Tracked fields: ${[...known].sort().join(', ')}`,
        'A field the mapping does not carry cannot conflict, so it cannot be resolved.',
      ]);
    }
  }

  if (parsed.default !== undefined) {
    recordDocumentResolution(resolutions, parsed.id, parsed.default);
  }
  for (const [field, owner] of Object.entries(parsed.fields)) {
    recordFieldResolution(resolutions, parsed.id, field, owner);
  }
  saveResolutions(board.paths, name, resolutions);

  const author = currentUser(board)?.ref ?? 'unknown';
  appendResolveAudit(board.paths, name, {
    at: new Date().toISOString(),
    author,
    localId: parsed.id,
    default: parsed.default,
    fields: Object.keys(parsed.fields).length > 0 ? parsed.fields : undefined,
  });

  renderResolve(name, parsed.id, parsed);
  return 0;
}

// -- link / unlink ----------------------------------------------------------

/** The `BoardError` a refused adoption becomes — the async path's only exit. */
function refusalError(name: string, refusal: AdoptRefusal): BoardError {
  switch (refusal.kind) {
    case 'no_such_document':
      return new BoardError(`No document "${refusal.localId}" on this board`, [
        'Link names a local document id, e.g. lpm remote link upstream LP-12 acme/payments#418.',
      ]);
    case 'already_linked':
      return new BoardError(`"${refusal.localId}" is already linked on "${name}"`, [
        `Existing link: ${refusal.existing.remoteKey || refusal.existing.remoteId}`,
        'Pass --repoint to move it to a different twin, or --dry-run to see what would change.',
      ]);
    case 'remote_claimed':
      return new BoardError(
        `Remote issue ${refusal.remoteId} is already the twin of "${refusal.holder}"`,
        [
          'Two documents may not share one twin. Unlink or decouple the existing holder first.',
        ],
      );
  }
}

function link(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      repoint: { type: 'boolean' },
    },
  });

  const [name, localId, remoteKey] = positionals;
  if (!name || !localId || !remoteKey) {
    throw new BoardError('Usage: lpm remote link <remote> <id> <remoteKey> [--repoint] [--dry-run]', [
      'Adopt an existing remote issue into a document without filing either side.',
    ]);
  }
  if (positionals.length > 3) {
    throw new BoardError(
      `Only a remote, a document id and a remote key are accepted (got "${positionals.join('", "')}")`,
      ['Usage: lpm remote link <remote> <id> <remoteKey> [--repoint] [--dry-run]'],
    );
  }

  const board = requireBoard();
  const remote = openRemote(board.config, name);

  if (!board.byId.has(localId)) {
    throw new BoardError(`No document "${localId}" on this board`, [
      'Link names a local document id, e.g. lpm remote link upstream LP-12 acme/payments#418.',
    ]);
  }

  // One document, one remote. An explicit adoption is refused rather than
  // reported: this request names one document and asks for exactly the thing
  // the rule forbids.
  requireUnclaimed(buildLedger(board.paths, board.config), localId, name);

  const connector = buildConnector(remote, board.paths);
  if (typeof connector.resolve !== 'function') {
    throw new BoardError(
      `The ${name} connector cannot resolve a remote key`,
      ['Supply the provider\'s own issue id instead, or adopt through a connector that implements resolve.'],
    );
  }

  const store = loadLinkStore(board.paths, name);
  const view = viewOf(board);
  const attributes = attributeDefsOf(board);
  const roster = rosterOf(board);
  const periods = periodIndexOf(board);
  const fields = trackedFields(remote.mapping);

  void (async () => {
    const resolved = await connector.resolve!(remoteKey);
    if (resolved === null) {
      throw new BoardError(`No remote issue for key "${remoteKey}" on "${name}"`, [
        'Check the key — for GitHub it is <owner>/<repo>#<number> — and that the credential can see the issue.',
      ]);
    }

    const record = resolved.record ?? {};
    const patch = remote.provider.translator.fieldsFromRecord(
      record,
      remote.mapping,
      attributes,
      roster,
      periods,
    ).patch;
    const remoteBody = typeof record['body'] === 'string' ? record['body'] : '';

    const plan = planAdoption(
      view,
      store,
      localId,
      {
        remoteId: resolved.remoteId,
        remoteKey: resolved.remoteKey,
        remoteUrl: resolved.remoteUrl,
        remoteRev: resolved.remoteRev,
        remoteBody,
        patch,
      },
      new Date().toISOString(),
      { repoint: values.repoint === true, mappedFields: fields },
    );

    if (!plan.ok) throw refusalError(name, plan.refusal);

    const suggested = ownIdOfManagedBlock(record);

    if (values['dry-run'] === true) {
      renderLinkDryRun(name, plan.plan, suggested);
      return;
    }

    setLink(store, localId, plan.plan.entry);
    updateBase(store, localId, plan.plan.base, plan.plan.entry.remoteRev, plan.plan.entry.syncedAt);
    saveLinkStore(board.paths, name, store);

    renderLink(name, plan.plan, suggested);
  })().catch((error: unknown) => {
    if (error instanceof BoardError) {
      err(`${red('error')} ${error.message}`);
      for (const detail of error.details) err(`       ${detail}`);
    } else {
      err(`${red('error')} ${messageOf(error)}`);
    }
    process.exitCode = 1;
  });

  return 0;
}

function unlink(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' } },
  });

  const [name, localId] = positionals;
  if (!name || !localId) {
    throw new BoardError('Usage: lpm remote unlink <remote> <id> [--dry-run]', [
      'Drop a link with no tombstone, so the document is unlinked again.',
    ]);
  }
  if (positionals.length > 2) {
    throw new BoardError(
      `Only a remote and a document id are accepted (got "${positionals.join('", "')}")`,
      ['Usage: lpm remote unlink <remote> <id> [--dry-run]'],
    );
  }

  const board = requireBoard();
  openRemote(board.config, name); // throws when the remote is not declared
  const store = loadLinkStore(board.paths, name);

  const link = store.links.get(localId);
  if (!link) {
    throw new BoardError(`"${localId}" is not linked to a remote issue on "${name}"`, [
      'There is no twin to drop. Use `lpm remote decouple` to mark it never-file, or `lpm remote link` to adopt one.',
    ]);
  }

  if (values['dry-run'] === true) {
    renderUnlinkDryRun(name, localId, link);
    return 0;
  }

  removeLink(store, localId);
  saveLinkStore(board.paths, name, store);
  renderUnlink(name, localId, link);
  return 0;
}

// -- decouple / relink ------------------------------------------------------

function decouple(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { reason: { type: 'string', default: 'manual' } },
  });

  const id = positionals[0];
  if (!id) {
    throw new BoardError('Missing document id', [
      'Usage: lpm remote decouple <id> [--reason manual|out_of_scope]',
    ]);
  }
  if (positionals.length > 1) {
    throw new BoardError(`Only one document id is accepted (got "${positionals.join('", "')}")`, [
      'Usage: lpm remote decouple <id> [--reason manual|out_of_scope]',
    ]);
  }

  const reason = String(values.reason ?? 'manual');
  if (reason !== 'manual' && reason !== 'out_of_scope') {
    throw new BoardError(`--reason must be manual or out_of_scope (got "${reason}")`, [
      'Usage: lpm remote decouple <id> [--reason manual|out_of_scope]',
    ]);
  }

  const board = requireBoard();
  if (!board.byId.has(id)) {
    throw new BoardError(`No document "${id}" on this board`, [
      'Decouple names a local document id, e.g. lpm remote decouple LP-12.',
    ]);
  }

  const name = remoteOfLinkOrTombstone(board, id);
  const store = loadLinkStore(board.paths, name);
  const tombstone = decoupleLink(store, id, reason, new Date().toISOString());
  saveLinkStore(board.paths, name, store);

  renderDecouple(name, id, tombstone);
  return 0;
}

function relink(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true });

  const id = positionals[0];
  if (!id) {
    throw new BoardError('Missing document id', ['Usage: lpm remote relink <id>']);
  }
  if (positionals.length > 1) {
    throw new BoardError(`Only one document id is accepted (got "${positionals.join('", "')}")`, [
      'Usage: lpm remote relink <id>',
    ]);
  }

  const board = requireBoard();
  if (!board.byId.has(id)) {
    throw new BoardError(`No document "${id}" on this board`, [
      'Relink names a local document id, e.g. lpm remote relink LP-12.',
    ]);
  }

  const name = remoteOfTombstone(board, id);
  const store = loadLinkStore(board.paths, name);
  clearTombstone(store, id);
  saveLinkStore(board.paths, name, store);

  renderRelink(name, id);
  return 0;
}

// -- rebase -----------------------------------------------------------------

function rebase(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' } },
  });

  const name = positionals[0];
  if (!name) {
    throw new BoardError('Missing remote name', ['Usage: lpm remote rebase <name>']);
  }

  const board = requireBoard();
  if (!hasRemotes(board.config)) {
    throw new BoardError('This board declares no remotes', [
      'Add a remotes: block to .lpm/config.yml first.',
    ]);
  }

  const remote = openRemote(board.config, name);
  const store = loadLinkStore(board.paths, name);
  const mapping = remote.mapping;

  const previous = loadMappingSnapshot(board.paths, name);
  const assessment = assessMappingChange(previous?.mapping, mapping, store);

  if (previous === undefined) {
    out(dim('Nothing to re-base: this remote has not been synced, so no base snapshots were recorded.'));
    return 0;
  }
  if (assessment.classification === 'unchanged') {
    out(dim('Nothing to re-base: the mapping in force matches the one the snapshots were recorded under.'));
    return 0;
  }
  if (assessment.classification === 'additive') {
    if (!values['dry-run']) saveMappingSnapshot(board.paths, name, mapping);
    out(
      `The mapping change only adds fields — nothing is invalidated.` +
        (values['dry-run'] ? ` ${dim('(dry run — fingerprint not written)')}` : ''),
    );
    return 0;
  }

  // A breaking change: re-read both sides and rewrite the bases.
  const connector = buildConnector(remote, board.paths);

  void (async () => {
    const report = await applyRebase(board, remote, connector, store, {
      dryRun: values['dry-run'] === true,
    });
    render(name, report);
  })().catch((error: unknown) => {
    if (error instanceof BoardError) {
      err(`${red('error')} ${error.message}`);
      for (const detail of error.details) err(`       ${detail}`);
    } else {
      err(`${red('error')} ${messageOf(error)}`);
    }
    process.exitCode = 1;
  });

  return 0;
}

// -- report -----------------------------------------------------------------

/** Readable single-line form of a value, for the conflict table. */
function fmt(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') {
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.length > 40 ? `"${flat.slice(0, 37)}…"` : `"${flat}"`;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.map(fmt).join(', ')}]`;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function render(name: string, report: RebaseReport): void {
  const linked = report.outcomes.length + report.unreadable.length + report.orphaned.length + report.failed.length;
  out();
  out(`${bold(`Rebasing remote ${cyan(name)}`)} — ${linked} linked ${linked === 1 ? 'document' : 'documents'}`);
  out();

  out(`  ${pad('rebased', 12)}${report.rebased.length}`);
  out(`  ${pad('conflicted', 12)}${report.conflicted.length}`);
  out(`  ${pad('unreadable', 12)}${report.unreadable.length}`);
  out(`  ${pad('orphaned', 12)}${report.orphaned.length}`);
  out(`  ${pad('failed', 12)}${report.failed.length}`);

  for (const entry of report.unreadable) {
    out(`    ${dim(`${entry.localId}  twin ${entry.remoteId} not found — left for the lifecycle (not re-based)`)}`);
  }
  for (const entry of report.orphaned) {
    out(`    ${dim(`${entry.localId}  no local document — left for \`lpm check --fix\` (not re-based)`)}`);
  }
  for (const entry of report.failed) {
    out(`    ${red(`${entry.localId}  could not read twin ${entry.remoteId}: ${entry.error}`)}`);
  }

  for (const outcome of report.outcomes) {
    if (outcome.state !== 'conflicted') continue;
    out();
    out(bold('conflicted'));
    out(`  ${outcome.localId}  (${outcome.remoteId})`);
    for (const conflict of outcome.conflicts) {
      out(
        `    ${pad(conflict.field, 16)} local: ${pad(fmt(conflict.local), 22)} remote: ${pad(fmt(conflict.remote), 22)} ${dim('left conflicted')}`,
      );
    }
  }

  out();
  if (report.dryRun) {
    out(yellow('Dry run — nothing was written.'));
  } else if (report.fingerprintUpdated) {
    out(green('Mapping fingerprint updated — the next sync runs clean.'));
  } else {
    out(yellow('Partially re-based — the fingerprint was not updated. Re-run to finish.'));
  }
}

/** Render one `lpm remote status` run (LP-342). */
function renderStatus(
  name: string,
  report: RemoteStatusReport,
  store: ReturnType<typeof loadLinkStore>,
): void {
  const { remote } = report;
  const lastSync =
    remote.lastSync === null ? 'never' : remote.lastSync.replace('T', ' ').slice(0, 16);

  out();
  out(
    `${bold(`Remote ${cyan(name)}`)}  ${dim(`${remote.provider}: ${remote.target}`)}` +
      `  ${dim(`· last synced ${lastSync}`)}`,
  );
  // What the remote owns, before the counts it has to be read against. A bare
  // "433 ahead" means one thing for a mirror of one epic and another for a
  // mirror of the whole board, and nothing on screen used to say which.
  const owns =
    remote.scope === null
      ? dim('whole board')
      : `${cyan(remote.scope)} ${dim('and everything under it')}`;
  out(
    `  ${dim(pad('scope', 9))}${owns}  ` +
      dim(`· ${remote.mirrored} of ${plural(remote.inScope, 'document')} mirrored`),
  );

  if (report.remoteMissing !== undefined) {
    out();
    out(`${yellow('remote side not read')}  ${report.remoteMissing}`);
  }

  out();
  const all = report.fields !== undefined; // --verbose: print every id
  // **What a sync will actually do, first.** `ahead` is the honest total but it
  // is not the useful number: on the board this was written for, 428 of 433
  // documents were ahead on an assignee the tracker cannot hold, which made the
  // headline read as a catastrophe when five documents needed pushing. The
  // blocked ones are named below, apart, with the reason.
  const pending = pendingAhead(report);
  driftBucket('to push', pending, 'the board changed, the tracker did not', all);
  driftBucket('to pull', report.behind, 'the tracker changed, the board did not', all);
  driftBucket(
    'to pull · new',
    report.incoming.map((entry) => entry.remoteKey),
    'in the tracker with no document here — a pull creates them',
    all,
  );
  driftBucket('conflicts', report.conflicted, 'both sides changed the same field', all);

  // The secondary half: true, worth knowing, and not what to act on first.
  const blockedIds = report.blocked.map((entry) => entry.localId);
  driftBucket('blocked', blockedIds, 'ahead on fields this remote cannot accept', all);
  driftBucket('not synced', report.unlinked, 'never pushed — no twin yet', all);
  driftBucket('orphaned', report.orphaned, 'linked, but the document is gone', all);
  driftBucket('decoupled', report.decoupled.map((entry) => entry.localId), 'deliberately not synced', all);
  driftBucket('unreadable', report.unreadable.map((entry) => entry.localId), 'twin not found upstream', all);
  driftBucket('failed', report.failed.map((entry) => entry.localId), 'could not read twin', all);

  // Incoming work is named rather than counted: a key and a title are what
  // somebody reads to decide whether they want it, and the count alone ("14
  // incoming") is not something anybody can act on.
  for (const entry of report.incoming.slice(0, all ? report.incoming.length : DRIFT_IDS_SHOWN)) {
    const under =
      entry.parentLocalId !== undefined
        ? dim(`— would land under ${entry.parentLocalId}`)
        : dim('— would land at the root');
    out(`    ${cyan(entry.remoteKey)}  ${pad(entry.title, 44)} ${under}`);
  }
  for (const entry of report.decoupled) {
    out(
      `    ${yellow(entry.localId)}  ${dim(`decoupled (${entry.reason})`)}${entry.remoteKey ? `  ${dim(`— was ${entry.remoteKey}`)}` : ''}`,
    );
  }
  for (const entry of report.unreadable) {
    out(`    ${dim(`${entry.localId}  twin ${entry.remoteId} not found — left for the lifecycle`)}`);
  }
  for (const entry of report.failed) {
    out(`    ${red(`${entry.localId}  could not read twin ${entry.remoteId}: ${entry.error}`)}`);
  }

  // Why the blocked ones are blocked, grouped by reason rather than one line per
  // document: 428 documents with the same sentence beside each is not a report.
  if (report.blocked.length > 0) {
    // Grouped by *cause*, with the remedy under each: the same sentence 428
    // times is not a report, and "the board or the mapping has to change" told a
    // reader they had a problem and nothing about which problem or whose.
    const causes = new Map<string, { count: number; reason: string; remedy?: string }>();
    for (const entry of report.blocked) {
      for (const field of entry.fields) {
        const key = `${field.field} ${field.reason}`;
        const cause = causes.get(key);
        if (cause) cause.count += 1;
        else {
          causes.set(key, {
            count: 1,
            reason: `${field.field} — ${field.reason}`,
            ...(field.remedy !== undefined ? { remedy: field.remedy } : {}),
          });
        }
      }
    }
    // **Causes lead, documents follow.** One person with no account value held
    // back 220 documents on the board this was built for, and "392 blocked" was
    // the headline — which reads as a mirror in serious trouble when the truth is
    // four things to fix, one of them a single missing email.
    out();
    out(
      `${yellow(plural(causes.size, 'thing'))} ${yellow('to fix before this remote can store everything')}  ` +
        dim(`— between them they hold back ${plural(report.blocked.length, 'edit')}`),
    );
    // Biggest cause first: it is the one worth fixing.
    for (const cause of [...causes.values()].sort((a, b) => b.count - a.count)) {
      out();
      out(`  ${cause.reason}  ${dim(`— ${plural(cause.count, 'document')}`)}`);
      if (cause.remedy !== undefined) out(`    ${dim(cause.remedy)}`);
    }
  }

  if (report.fields !== undefined && Object.keys(report.fields).length > 0) {
    out();
    out(bold('field-level detail'));
    for (const localId of Object.keys(report.fields).sort()) {
      const link = store.links.get(localId);
      out();
      out(`${bold(localId)}  ${dim(`(${link?.remoteKey ?? ''})`)}`);
      for (const entry of report.fields[localId]!) {
        out(
          `    ${pad(entry.field, 16)} ${pad(entry.outcome, 10)} local: ${pad(fmt(entry.local), 22)} remote: ${pad(fmt(entry.remote), 22)} base: ${fmt(entry.base)}`,
        );
      }
    }
  }

  out();
  // What the remote half was computed from. Without it, "in sync" is a claim a
  // reader cannot weigh: a listing narrowed by a stale cursor or a wrong project
  // agrees with the board about almost everything, for the wrong reason.
  if (report.remoteRead !== undefined) {
    const kind = report.incremental === true ? 'changed since the last sync' : 'in the project';
    out(dim(`  read ${plural(report.remoteRead, 'remote issue')} ${kind}`));
    if (report.incremental === true) {
      out(
        dim('  an incremental listing proves nothing by absence — incoming and unreadable stand down'),
      );
    }
    out();
  }
  if (report.conflicted.length > 0) {
    out(
      yellow(
        `Settle ${plural(report.conflicted.length, 'conflict')} with \`lpm remote resolve <id> --local|--remote\`.`,
      ),
    );
  } else if (report.remoteMissing !== undefined) {
    out(yellow('The remote half could not be read — the local half above is all that is known.'));
  } else if (
    pending.length > 0 ||
    report.behind.length > 0 ||
    report.incoming.length > 0 ||
    report.unlinked.length > 0 ||
    report.orphaned.length > 0 ||
    report.unreadable.length > 0 ||
    report.failed.length > 0
  ) {
    if (report.incoming.length > 0) {
      out(
        yellow(
          `Adopt ${plural(report.incoming.length, 'incoming issue')} with ` +
            `\`lpm remote pull ${name} ${report.incoming[0]!.remoteKey}\`, or all of them with ` +
            `\`lpm remote pull ${name}\`.`,
        ),
      );
    }
    out(yellow(`Run \`lpm remote sync ${name}\` to reconcile.`));
  } else {
    out(green('In sync — the board and the remote agree.'));
  }
}

/**
 * One drift bucket line: label, count, ids and a note.
 *
 * The ids are capped. A 537-issue mirror puts 440 of them in one bucket, and
 * printing all of them produced a single unwrapped line thousands of columns
 * wide — the count and the note, which are the parts a reader acts on, were
 * pushed off the screen by the evidence. `--verbose` prints the lot for a
 * script or a closer look.
 */
const DRIFT_IDS_SHOWN = 12;

function driftBucket(label: string, ids: readonly string[], note: string, all = false): void {
  if (ids.length === 0) return;
  const shown = all ? [...ids] : ids.slice(0, DRIFT_IDS_SHOWN);
  const rest = ids.length - shown.length;
  const list = rest > 0 ? `${shown.join(' ')} ${dim(`+${rest} more`)}` : shown.join(' ');
  out(`  ${pad(label, 15)}${pad(String(ids.length), 4)}  ${list}  ${dim(note)}`);
}

/** Render one `lpm remote status --json` run: the report, nothing else. */
function renderStatusJson(report: RemoteStatusReport): void {
  out(JSON.stringify(report, null, 2));
}

/** Render one `lpm remote resolve` run. */
function renderResolve(name: string, id: string, parsed: ResolveArgs): void {
  out();
  out(`${bold(`Resolved ${id}`)} on ${cyan(name)} — recorded, takes effect on the next sync`);
  out();
  if (parsed.default !== undefined) {
    out(`  ${pad('default', 16)} ${parsed.default} ${dim('(every field, unless named below)')}`);
  }
  for (const [field, owner] of Object.entries(parsed.fields).sort(([a], [b]) => a.localeCompare(b))) {
    out(`  ${pad(field, 16)} ${owner}`);
  }
  out();
  out(dim('Nothing was written to the remote or the board — the decision is recorded in the'));
  out(dim('resolution store and audit log, and the next sync applies it.'));
}

/** Render one `lpm remote decouple` run. */
function renderDecouple(
  name: string,
  id: string,
  tombstone: { remoteKey: string; reason: string },
): void {
  out();
  out(`${bold(`Decoupled ${id}`)} on ${cyan(name)} — it will not be filed again`);
  out();
  out(`  ${pad('reason', 16)} ${tombstone.reason}`);
  out(`  ${pad('last remote key', 16)} ${tombstone.remoteKey === '' ? '—' : tombstone.remoteKey}`);
  out();
  out(dim('The remote twin was left alone. Re-link it with `lpm remote relink ' + id + '` when you want it back.'));
}

/** Render one `lpm remote relink` run. */
function renderRelink(name: string, id: string): void {
  out();
  out(`${bold(`Re-linked ${id}`)} on ${cyan(name)} — the tombstone is cleared`);
  out();
  out(dim('The document is an ordinary unlinked document again; the next push will file it.'));
}

/** The managed-block suggestion, as a note a reader will notice. */
function suggestionNote(suggested: string | undefined): void {
  if (suggested === undefined) return;
  out();
  out(
    `${yellow('note')} this issue's managed block names ${bold(suggested)} — if that is the document it`,
  );
  out(dim('      belongs to, adopt it under that id instead of re-filing a duplicate.'));
}

/** Render one `lpm remote link` run. */
function renderLink(
  name: string,
  plan: { localId: string; entry: { remoteKey: string; remoteId: string; remoteUrl: string }; clearedTombstone: boolean; repointed: boolean },
  suggested: string | undefined,
): void {
  out();
  out(
    `${bold(`Linked ${plan.localId}`)} on ${cyan(name)} — ${plan.entry.remoteKey || plan.entry.remoteId}` +
      (plan.repointed ? ` ${dim('(repointed)')}` : ''),
  );
  if (plan.entry.remoteUrl !== '') out(`  ${pad('remote url', 16)} ${plan.entry.remoteUrl}`);
  out();
  out(dim('Neither document was written — the correspondence is recorded and the base snapshot'));
  out(dim('was seeded from the remote\'s current values. The next sync reconciles the difference.'));
  if (plan.clearedTombstone) {
    out();
    out(dim('The document was decoupled; adoption cleared its tombstone.'));
  }
  suggestionNote(suggested);
}

/** Render one `lpm remote link --dry-run` run. */
function renderLinkDryRun(
  name: string,
  plan: { localId: string; entry: { remoteKey: string; remoteId: string; remoteUrl: string }; clearedTombstone: boolean; repointed: boolean },
  suggested: string | undefined,
): void {
  out();
  out(
    `${bold(`Would link ${plan.localId}`)} on ${cyan(name)} — ${plan.entry.remoteKey || plan.entry.remoteId}` +
      (plan.repointed ? ` ${dim('(repointed)')}` : ''),
  );
  if (plan.entry.remoteUrl !== '') out(`  ${pad('remote url', 16)} ${plan.entry.remoteUrl}`);
  out();
  if (plan.clearedTombstone) {
    out(dim('Would clear the document\'s tombstone.'));
  }
  suggestionNote(suggested);
  out();
  out(yellow('Dry run — nothing was written.'));
}

/** Render one `lpm remote unlink` run. */
function renderUnlink(name: string, id: string, link: { remoteKey: string; remoteId: string }): void {
  out();
  out(`${bold(`Unlinked ${id}`)} on ${cyan(name)} — ${link.remoteKey || link.remoteId}`);
  out();
  out(dim('The link is dropped with no tombstone, so the document is unlinked again and the'));
  out(dim('next push may re-file it. The remote twin was left alone.'));
}

/** Render one `lpm remote unlink --dry-run` run. */
function renderUnlinkDryRun(name: string, id: string, link: { remoteKey: string; remoteId: string }): void {
  out();
  out(`${bold(`Would unlink ${id}`)} on ${cyan(name)} — ${link.remoteKey || link.remoteId}`);
  out();
  out(yellow('Dry run — nothing was written.'));
}
