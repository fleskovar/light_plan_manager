import type { BoardPaths, LoadedBoard, Profile, ResolvedScope, Resource } from '../core/index.js';
import {
  BoardError,
  currentProfile,
  findResource,
  fullScope,
  loadBoard,
  loadProfileFile,
  pullBoard,
  resolveProfilePath,
  resolveScope,
} from '../core/index.js';
import type { BoardView, Plan } from '../shared/index.js';
import { counterFactory } from '../shared/index.js';
import { applyChanges, toSnapshot } from '../sync/index.js';

/**
 * The board, as one agent session sees it.
 *
 * Two things here are deliberately different from the CLI. The board is
 * reloaded for every call, because several agents may be working the same
 * checkout at once and a handle held across calls would be reading the past.
 * And the identity is held in memory rather than written to `.lpm/local.json`:
 * that file says who is at *this keyboard*, and a swarm of agents sharing a
 * checkout must not fight over it.
 *
 * A profile is the same bargain in file form: `--profile` names one for this
 * session only, so a dozen agents can each be pointed at a different slice of
 * one board without any of them writing anything down.
 */
export interface ContextOptions {
  /** Who this session acts as: a resource id or name. Wins over the profile. */
  user?: string | null;
  /** A profile file for this session. Falls back to the checkout's. */
  profile?: string | null;
  /** Refuse every tool that writes. */
  readOnly?: boolean;
  /** Register the remote-sync tool, which writes to a tracker outside the checkout. */
  allowRemote?: boolean;
}

export class BoardContext {
  readonly readOnly: boolean;
  /** Whether the remote-sync tool is registered: it writes to somebody else's tracker. */
  readonly allowRemote: boolean;
  /** Who this session acts as: an explicit `--user`, else the profile's. */
  private readonly userRef: string | null;
  /**
   * The profile this session was started with. Read once at startup, like the
   * identity beside it: a long-lived session must not change what it offers
   * because a file moved under it.
   */
  private readonly profile: Profile | null;
  /** Why the profile could not be read. Reported by `board_overview`. */
  readonly profileErrors: string[];

  constructor(
    readonly paths: BoardPaths,
    options: ContextOptions = {},
  ) {
    this.readOnly = options.readOnly === true;
    this.allowRemote = options.allowRemote === true;

    // With no --profile the checkout's own applies, so an agent launched in a
    // developer's working copy is offered what that developer is.
    const loaded = options.profile
      ? loadProfileFile(resolveProfilePath(paths, options.profile))
      : currentProfile(paths);

    this.profile = loaded?.profile ?? null;
    this.profileErrors = loaded?.errors ?? [];
    this.userRef = options.user ?? this.profile?.user ?? null;
  }

  /** What this session should be offered, resolved against the board. */
  scope(board: LoadedBoard = this.board()): ResolvedScope {
    const scope = this.profile?.scope;
    return scope ? resolveScope(board, scope) : fullScope();
  }

  /**
   * The board as it stands now — on a board shared through git, as it stands on
   * the remote, pulled first. Throttled, because one tool call may load the
   * board several times and one fetch answers all of them. Best effort: an
   * agent offline still reads the board it has, and a write it then makes is
   * refused by the engine if somebody else got there first.
   */
  board(): LoadedBoard {
    try {
      pullBoard(this.paths, { maxAgeMs: 3_000 });
    } catch {
      // The write that runs into it reports it.
    }
    return loadBoard(this.paths);
  }

  /** The board as the shared planners want it. */
  view(board: LoadedBoard = this.board()): BoardView {
    const snapshot = toSnapshot(board);
    const nodes = Object.fromEntries(
      [
        ...snapshot.issues,
        ...snapshot.periods,
        ...snapshot.resources,
        ...snapshot.templates,
      ].map((node) => [node.id, node]),
    );
    return { config: snapshot.config, nodes };
  }

  /** The roster entry this session acts as, if it was given one. */
  user(board: LoadedBoard = this.board()): Resource | null {
    return this.userRef ? findResource(board, this.userRef) : null;
  }

  requireUser(board: LoadedBoard): Resource {
    const resource = this.user(board);
    if (!resource) {
      throw new BoardError(
        this.userRef
          ? `This session's user "${this.userRef}" is not on the roster`
          : 'This session has no user',
        ['Start the server with --user <id or name>, or pass an explicit assignee.'],
      );
    }
    return resource;
  }

  /** How a comment is signed when the caller does not say. */
  authorName(board: LoadedBoard): string | undefined {
    const resource = this.user(board);
    return resource ? `${resource.title} (${resource.id})` : undefined;
  }

  assertWritable(): void {
    if (this.readOnly) {
      throw new BoardError('This server is read-only', [
        'It was started with --read-only; restart it without that flag to make changes.',
      ]);
    }
  }

  /**
   * Run a planned edit. Returns the ids the board allocated, in the order the
   * plan created them, so a tool can report real ids rather than `new:1`.
   */
  run(plan: Plan): { created: string[] } {
    this.assertWritable();
    if (!plan.ok) throw new BoardError(plan.error, plan.details);
    if (!plan.changes.length) return { created: [] };

    const result = applyChanges(this.paths, plan.changes);
    if (result.failures.length) {
      throw new BoardError(
        result.failures.map((failure) => failure.error).join('; '),
        result.failures.flatMap((failure) => failure.details ?? []),
      );
    }
    return { created: plan.created.map((temp) => result.idMap[temp] ?? temp) };
  }

  /** A fresh temporary-id source for one plan. */
  ids(): () => string {
    return counterFactory();
  }
}
