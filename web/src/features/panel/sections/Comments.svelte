<script lang="ts">
  import type { CommentDto } from '$shared';
  import { isTempId } from '$shared';
  import { ApiError, api } from '$lib/api/client.js';
  import Button from '$lib/ui/Button.svelte';
  import Markdown from '$lib/ui/Markdown.svelte';

  /**
   * A document's work log: what was tried, what broke, what a reviewer asked
   * for. Written straight to disk rather than queued in the view, because a
   * comment records something that already happened — see the API client.
   */
  interface Props {
    id: string;
    onerror: (error: unknown) => void;
  }

  let { id, onerror }: Props = $props();

  let comments = $state<CommentDto[]>([]);
  let draft = $state('');
  let busy = $state(false);
  /** A document that has never been pushed has nothing on disk to comment on. */
  const unsaved = $derived(isTempId(id));

  $effect(() => {
    const target = id;
    if (isTempId(target)) {
      comments = [];
      return;
    }
    void api
      .comments(target)
      .then((result) => {
        // The panel may have moved on while this was in flight.
        if (target === id) comments = result.comments;
      })
      .catch(() => {
        if (target === id) comments = [];
      });
  });

  async function submit(): Promise<void> {
    const body = draft.trim();
    if (!body || busy) return;
    busy = true;
    try {
      await api.addComment(id, body);
      comments = (await api.comments(id)).comments;
      draft = '';
    } catch (error) {
      onerror(error instanceof ApiError ? error : new Error(String(error)));
    } finally {
      busy = false;
    }
  }

  async function remove(index: number): Promise<void> {
    try {
      await api.deleteComment(id, index);
      comments = (await api.comments(id)).comments;
    } catch (error) {
      onerror(error);
    }
  }

  const when = (iso: string): string => new Date(iso).toLocaleString();
</script>

<h4>Comments</h4>

{#if unsaved}
  <p class="empty">Push this document before commenting.</p>
{:else}
  {#if comments.length}
    <ul>
      {#each comments as comment (comment.index)}
        <li>
          <header>
            <span class="author">{comment.author}</span>
            <span class="at">{when(comment.at)}</span>
            <button
              type="button"
              aria-label="Delete comment {comment.index}"
              title="Delete"
              onclick={() => remove(comment.index)}
            >
              ×
            </button>
          </header>
          <Markdown source={comment.body} placeholder="" />
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">No comments yet.</p>
  {/if}

  <textarea
    bind:value={draft}
    rows="3"
    placeholder="What did you try? What did you find?"
    onkeydown={(event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void submit();
    }}
  ></textarea>
  <div class="actions">
    <span class="hint">Ctrl+Enter to post</span>
    <Button size="sm" variant="primary" disabled={!draft.trim() || busy} onclick={submit}>
      Comment
    </Button>
  </div>
{/if}

<style>
  h4 {
    margin: var(--space-4) 0 var(--space-1);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }

  ul {
    margin: 0 0 var(--space-2);
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  li {
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
  }

  li header {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-xs);
  }

  .author {
    font-weight: 600;
  }

  .at {
    flex: 1;
    color: var(--ink-faint);
  }

  li header button {
    border: none;
    background: none;
    color: var(--ink-faint);
    line-height: 1;
  }

  /* The body is rendered markdown; only the space above it belongs here. */
  li :global(.prose) {
    margin-top: var(--space-1);
  }

  textarea {
    width: 100%;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font: inherit;
    font-size: var(--text-sm);
    color: var(--ink);
    resize: vertical;
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }

  .hint,
  .empty {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .empty {
    margin: 0 0 var(--space-2);
  }
</style>
