<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import { coverageRelationInfo } from '$shared';
  import { useRemoteState } from '$features/drawer/remote/remote.svelte.js';

  /**
   * One document's remote standing, and the two buttons that act on it.
   *
   * Presentational: it asks the remote state machine what this document's twin
   * is and tells it to push or pull. Both calls go through the same runner the
   * Sync tab uses, so the dirty-view refusal, the one-run-at-a-time latch and
   * the refresh afterwards hold here exactly as they do there — a per-document
   * push is a narrower sync, never a second way of syncing.
   */
  interface Props {
    id: string;
    /** True when this document has children, so "with children" is offered. */
    hasChildren: boolean;
  }

  let { id, hasChildren }: Props = $props();

  const remote = useRemoteState();

  const twin = $derived(remote.documentRemote(id));
  const busy = $derived(remote.syncing);

  /**
   * What is missing *around* this document — the stories under a filed
   * feature, the epic above it, the sprint it was filed without.
   *
   * Read from the coverage report, which is offline, so this answers even
   * while the drift report above is still being read from the tracker.
   */
  const gaps = $derived(remote.gapsFor(id));

  /** Push the subtree rather than the one document. Only ever true for a container. */
  let withChildren = $state(false);
  const children = $derived(hasChildren && withChildren);

  /**
   * What the two sides currently disagree about, in one phrase.
   *
   * "In step" is a claim about the tracker, so it is only made once somebody
   * has checked it: until then the report is the local half and all it can
   * honestly say is that nothing has been edited here since the last sync.
   */
  const drift = $derived(
    twin === null
      ? ''
      : twin.conflicted
        ? 'changed on both sides'
        : twin.ahead && twin.behind
          ? 'local and remote changes pending'
          : twin.ahead
            ? 'local changes not pushed'
            : twin.behind
              ? 'remote changes not pulled'
              : remote.badgeChecked
                ? 'up to date'
                : 'no local changes (tracker not checked)',
  );
</script>

{#if twin !== null}
  <h4>Remote · {twin.remoteName}</h4>

  {#if twin.link === null}
    <p class="hint">Not mirrored yet. Push to create it on the tracker.</p>
  {:else}
    {#if twin.link.remoteUrl}
      <a class="remote-link" href={twin.link.remoteUrl} target="_blank" rel="noreferrer">
        {twin.link.remoteKey || twin.link.remoteId} ↗
      </a>
    {:else}
      <span class="remote-link">{twin.link.remoteKey || twin.link.remoteId}</span>
    {/if}
    <p class="hint" class:drifted={twin.ahead || twin.behind || twin.conflicted}>{drift}</p>
  {/if}

  {#if hasChildren}
    <label class="with-children">
      <input type="checkbox" bind:checked={withChildren} disabled={busy} />
      include children
    </label>
  {/if}

  <div class="actions">
    <Button
      size="sm"
      variant="primary"
      disabled={busy || remote.syncBlocked}
      title={children ? 'Push this document and its children' : 'Push this document'}
      onclick={() => void remote.pushDocument(id, { children })}
    >
      {busy ? 'Working…' : children ? 'Push subtree' : 'Push'}
    </Button>
    <Button
      size="sm"
      disabled={busy || remote.syncBlocked || twin.link === null}
      title={twin.link === null
        ? 'Not on the remote yet'
        : 'Pull this document from the remote'}
      onclick={() => void remote.pullDocument(id)}
    >
      Pull
    </Button>
  </div>

  {#if remote.syncBlocked}
    <p class="hint">
      Push this view's edits to the board first.
    </p>
  {/if}
{/if}

{#if gaps.length > 0}
  <h4>Missing related documents · {gaps.length}</h4>
  <ul class="gaps">
    {#each gaps as gap (gap.id)}
      {@const reason = gap.reasons.find((entry) => entry.anchors.includes(id)) ?? gap.reasons[0]}
      <li>
        <span class="gap-id">{gap.id}</span>
        <span class="gap-title">{gap.title}</span>
        <span class="gap-why">{reason ? coverageRelationInfo(reason.relation).short : ''}</span>
      </li>
    {/each}
  </ul>
  <div class="actions">
    <Button
      size="sm"
      disabled={busy || remote.syncBlocked}
      title="Push only the documents listed above"
      onclick={() => void remote.pushDocuments(gaps.map((gap) => gap.id))}
    >
      Push these {gaps.length}
    </Button>
  </div>
{/if}

{#if twin === null && remote.reportPending}
  <!-- The report is on its way. Showing nothing here read as "not mirrored". -->
  <h4>Remote · {remote.badgeRemote}</h4>
  <p class="hint">Loading remote… large boards may take a minute.</p>
{/if}

<style>
  h4 {
    margin: var(--space-4) 0 var(--space-1);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }

  .remote-link {
    display: inline-block;
    font-size: var(--text-sm);
    color: var(--accent);
    text-decoration: none;
  }

  a.remote-link:hover {
    text-decoration: underline;
  }

  .hint {
    margin: var(--space-1) 0 var(--space-2);
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .hint.drifted {
    color: var(--ink);
  }

  .with-children {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-bottom: var(--space-2);
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
  }

  .gaps {
    list-style: none;
    margin: 0 0 var(--space-2);
    padding: 0;
    font-size: var(--text-xs);
  }

  .gaps li {
    display: flex;
    align-items: baseline;
    gap: var(--space-1);
    min-width: 0;
  }

  .gap-id {
    color: var(--ink-muted);
    font-variant-numeric: tabular-nums;
  }

  .gap-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gap-why {
    margin-left: auto;
    color: var(--ink-faint);
    white-space: nowrap;
  }
</style>
