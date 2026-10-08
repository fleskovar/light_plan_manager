<script lang="ts">
  /**
   * The files an issue is about: the requirement it came from, the source that
   * has to change, the fixture that proves it.
   *
   * Edited as one path per line rather than as a list of rows, because that is
   * how they are pasted — out of an editor, out of a diff, out of a stack trace
   * — and because reordering and bulk-editing come free. They are never checked
   * against the filesystem: an issue naming a file that does not exist yet is
   * usually the point of the issue.
   */
  interface Props {
    files: string[];
    onchange: (files: string[]) => void;
  }

  let { files, onchange }: Props = $props();

  let editing = $state(false);
  const text = $derived(files.join('\n'));

  function commit(raw: string): void {
    const next: string[] = [];
    for (const line of raw.split('\n')) {
      const ref = line.trim();
      if (ref && !next.includes(ref)) next.push(ref);
    }
    if (next.length !== files.length || next.some((ref, at) => ref !== files[at])) onchange(next);
    editing = false;
  }
</script>

<div class="head">
  <h4>Files</h4>
  <button class="chip" type="button" onclick={() => (editing = !editing)}>
    {editing ? 'Done' : 'Edit'}
  </button>
</div>

{#if editing}
  <textarea
    rows={Math.max(3, files.length + 1)}
    value={text}
    placeholder={'docs/prd.md#L10-L42\nsrc/checkout/session.ts'}
    onchange={(event) => commit(event.currentTarget.value)}
  ></textarea>
  <p class="hint">One path per line, relative to the project root. Line ranges allowed.</p>
{:else if files.length}
  <ul>
    {#each files as ref (ref)}
      <li title={ref}>{ref}</li>
    {/each}
  </ul>
{:else}
  <p class="hint">None. List the files relevant to this issue.</p>
{/if}

<style>
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }

  h4 {
    margin: var(--space-4) 0 var(--space-1);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }

  .chip {
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-muted);
    font-size: var(--text-xs);
    padding: 0.1rem 0.35rem;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  li {
    padding: 0.1rem 0.35rem;
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  textarea {
    width: 100%;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.6;
    color: var(--ink);
    resize: vertical;
  }

  .hint {
    margin: var(--space-1) 0 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }
</style>
