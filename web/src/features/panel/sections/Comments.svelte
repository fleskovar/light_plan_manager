<script lang="ts">
  import { untrack } from 'svelte';
  import type { CommentDto } from '$shared';
  import { isTempId } from '$shared';
  import { ApiError, api } from '$lib/api/client.js';
  import Button from '$lib/ui/Button.svelte';
  import Markdown from '$lib/ui/Markdown.svelte';
  import { END_SLACK, followsToEnd, sameComments } from './comment-list.js';

  /**
   * A document's work log: what was tried, what broke, what a reviewer asked
   * for. Written straight to disk rather than queued in the view, because a
   * comment records something that already happened — see the API client.
   */
  interface Props {
    id: string;
    onerror: (error: unknown) => void;
    /** The comment being written. Bindable, so a window can warn before it closes on one. */
    draft?: string;
    /**
     * Fill the parent's height: the list scrolls and the input stays at the
     * bottom. The issue window sets it. The side panel lets the section grow.
     */
    fill?: boolean;
  }

  let { id, onerror, draft = $bindable(''), fill = false }: Props = $props();

  let comments = $state<CommentDto[]>([]);
  let busy = $state(false);
  let list = $state<HTMLElement | undefined>();

  /**
   * Replace the list only when it changed, so a refetch moves nothing on
   * screen. The read is untracked: the fetch effect calls this, and must not
   * run again because the list changed.
   */
  function show(next: CommentDto[]): void {
    if (!untrack(() => sameComments(comments, next))) comments = next;
  }

  // In a pane of its own the newest comment is the one to read. The list
  // scrolls to the end on the first load, and follows a new comment only
  // while the reader is at the end. `shown` and `atEnd` are plain variables,
  // so a scroll does not run this effect.
  let shown = 0;
  let atEnd = true;
  $effect(() => {
    const count = comments.length;
    if (fill && list && followsToEnd(shown, count, atEnd)) list.scrollTop = list.scrollHeight;
    shown = count;
  });

  function onscroll(): void {
    if (list) atEnd = list.scrollHeight - list.scrollTop - list.clientHeight <= END_SLACK;
  }

  /** A document that has never been pushed has nothing on disk to comment on. */
  const unsaved = $derived(isTempId(id));

  $effect(() => {
    const target = id;
    if (isTempId(target)) {
      show([]);
      return;
    }
    void api
      .comments(target)
      .then((result) => {
        // The panel may have moved on while this was in flight.
        if (target === id) show(result.comments);
      })
      .catch(() => {
        if (target === id) show([]);
      });
  });

  async function submit(): Promise<void> {
    const body = draft.trim();
    if (!body || busy) return;
    busy = true;
    try {
      await api.addComment(id, body);
      // The reader wants to see the comment they just posted.
      atEnd = true;
      show((await api.comments(id)).comments);
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
      show((await api.comments(id)).comments);
    } catch (error) {
      onerror(error);
    }
  }

  const when = (iso: string): string => new Date(iso).toLocaleString();
</script>

<section class="comments" class:fill>
  <h4>
    Comments
    {#if comments.length}<span class="count">{comments.length}</span>{/if}
  </h4>

  {#if unsaved}
    <p class="empty">Push this document before commenting.</p>
  {:else}
    <div class="list" bind:this={list} {onscroll}>
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
    </div>

    <div class="composer">
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
    </div>
  {/if}
</section>

<style>
  h4 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-4) 0 var(--space-1);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }

  .count {
    padding: 0 0.4rem;
    border-radius: 999px;
    background: var(--surface-3);
    color: var(--ink-muted);
    letter-spacing: 0;
  }

  /* In a pane: a header row, a list that scrolls, and the input at the bottom. */
  .fill {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .fill h4 {
    flex: none;
    margin: 0;
    padding: var(--space-2) var(--space-4);
    min-height: 2.25rem;
    box-sizing: border-box;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--ink-muted);
  }

  .fill .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-3) var(--space-4) 0;
  }

  .fill .composer {
    flex: none;
    padding: var(--space-2) var(--space-4) var(--space-3);
    border-top: 1px solid var(--border);
    background: var(--surface-1);
  }

  .fill > .empty {
    padding: var(--space-3) var(--space-4);
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
