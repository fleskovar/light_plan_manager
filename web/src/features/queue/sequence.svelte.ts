import type { BoardSnapshot, QueueSequenceDto } from '$shared';
import { api } from '$lib/api/client.js';

/**
 * The engine's queue sequence, as the panel numbers its cards by it.
 *
 * The server works it out (`GET /api/queue`, which is `simulateQueue`), so the
 * order a reviewer reads in the browser is the order `lpm task next` and
 * `lpm queue agent` will hand work out in. It answers for the board on disk,
 * which is why the key is taken from the snapshot and not the working copy: an
 * edit nobody has pushed yet cannot have changed the engine's answer.
 *
 * The board is re-read every few seconds whether or not anything changed, so
 * the sequence is asked for again only when something it depends on did.
 */
export class QueueSequence {
  /** Issue id -> 1-based step, or null until the engine has answered. */
  steps = $state.raw<ReadonlyMap<string, number> | null>(null);
  /** Why the last request failed, when it did. The panel falls back to its own order. */
  error = $state<string | null>(null);

  #key: string | null = null;
  #request = 0;
  readonly #fetch: (resourceId: string | null) => Promise<QueueSequenceDto>;

  constructor(fetch: (resourceId: string | null) => Promise<QueueSequenceDto> = api.queue) {
    this.#fetch = fetch;
  }

  /** Ask the engine again if the board, the mode or the reader changed since last time. */
  refresh(snapshot: BoardSnapshot, resourceId: string | null): Promise<void> {
    const key = `${resourceId ?? ''}|${sequenceKey(snapshot)}`;
    if (key === this.#key) return Promise.resolve();
    this.#key = key;
    // Only the newest request may land: a slow answer about the previous
    // reader must not overwrite the one about the reader now chosen.
    const request = ++this.#request;
    return this.#fetch(resourceId).then(
      (dto) => {
        if (request !== this.#request) return;
        this.steps = new Map(dto.steps.map((step) => [step.id, step.order]));
        this.error = null;
      },
      (error: unknown) => {
        if (request !== this.#request) return;
        this.steps = null;
        this.error = error instanceof Error ? error.message : String(error);
        // Let the next change try again rather than remembering the failure.
        this.#key = null;
      },
    );
  }
}

/**
 * Everything on the board the sequence depends on, and nothing else: the
 * statuses, edges, parents, owners, schedule and priority of the issues, the
 * periods and squads that route and rank them, and the mode. A body edit or a
 * renamed title leaves it alone, so typing in the panel never re-simulates.
 */
export function sequenceKey(snapshot: BoardSnapshot): string {
  const { config } = snapshot;
  return JSON.stringify([
    config.planning,
    snapshot.issues.map((issue) => [
      issue.id,
      issue.type,
      issue.parentId,
      issue.status,
      issue.assignee,
      issue.period,
      issue.flag,
      issue.dependsOn,
      issue.attributes[config.priorityAttribute] ?? null,
    ]),
    snapshot.periods.map((period) => [
      period.id,
      period.parentId,
      period.starts,
      period.ends,
      period.active ?? null,
      period.squad ?? null,
    ]),
    snapshot.resources.map((resource) => [resource.id, resource.generic, resource.covers]),
    snapshot.squads.map((squad) => [squad.id, squad.members]),
  ]);
}
