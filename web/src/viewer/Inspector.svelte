<script lang="ts">
  import type { NodeDto } from '$shared';
  import { flagLabel, plansWithPeriods } from '$shared';
  import { dependentsIndex, rolledUpEffort } from '$lib/board/selectors.js';
  import StatusChip from '$lib/ui/StatusChip.svelte';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import type { ViewerBoard } from './board.svelte.js';

  /**
   * What the selected document says, and what sits either side of it.
   *
   * Everything is text: the body is rendered as written, never as markup. The
   * board this page is showing came from a URL, and a viewer that turned a
   * stranger's issue description into HTML would be handing them the page.
   */
  interface Props {
    board: ViewerBoard;
    onclose: () => void;
  }

  let { board, onclose }: Props = $props();

  const node = $derived(board.selection.primary ? board.node(board.selection.primary) : undefined);
  const config = $derived(board.config);
  const issue = $derived(node?.kind === 'issue' ? node : null);
  const dependents = $derived(dependentsIndex(board.nodes, board.index));

  const effort = $derived(
    node && config.effortAttribute ? rolledUpEffort(board.nodes, config, node.id, board.index) : 0,
  );

  /** Attributes worth showing: declared by the type, and actually set. */
  function attributesOf(entry: NodeDto): [string, string][] {
    return Object.entries(entry.attributes)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]);
  }

  function label(id: string): string {
    return board.node(id)?.title ?? id;
  }

  function go(id: string): void {
    if (board.node(id)) board.selection.focus(id);
  }
</script>

<aside class="inspector">
  <header>
    <h2>Details</h2>
    <button type="button" class="close" onclick={onclose} aria-label="Hide details">×</button>
  </header>

  {#if !node}
    <p class="hint">Select a node to see what it says.</p>
  {:else}
    <div class="head">
      <TypeIcon type={node.type} depth={node.depth} />
      <span class="id">{node.id}</span>
      <span class="type">{config.types[node.type]?.label ?? node.type}</span>
    </div>
    <h3>{node.title}</h3>

    <dl>
      {#if issue}
        <dt>Status</dt>
        <dd><StatusChip {config} status={issue.status} /></dd>

        {#if issue.flag}
          <dt>Flag</dt>
          <dd><span class="flag">{flagLabel(issue.flag)}</span></dd>
        {/if}

        {#if config.hasResources}
          <dt>Assignee</dt>
          <dd>
            {#if issue.assignee}
              <button type="button" class="link" onclick={() => go(issue.assignee!)}>
                {label(issue.assignee)}
              </button>
            {:else}
              <span class="none">Unassigned</span>
            {/if}
          </dd>
        {/if}

        {#if plansWithPeriods(config)}
          <dt>Period</dt>
          <dd>
            {#if issue.period}
              <button type="button" class="link" onclick={() => go(issue.period!)}>
                {label(issue.period)}
              </button>
            {:else}
              <span class="none">Unscheduled</span>
            {/if}
          </dd>
        {/if}
      {/if}

      {#if node.kind === 'period'}
        <dt>Runs</dt>
        <dd>{node.starts ?? '?'} → {node.ends ?? '?'}</dd>
      {/if}

      {#if node.kind === 'resource'}
        <dt>Capacity</dt>
        <dd>{node.capacity} FTE{node.generic ? ' (pool)' : ''}</dd>
      {/if}

      <dt>Parent</dt>
      <dd>
        {#if node.parentId && board.node(node.parentId)}
          <button type="button" class="link" onclick={() => go(node.parentId!)}>
            {label(node.parentId)}
          </button>
        {:else}
          <span class="none">—</span>
        {/if}
      </dd>

      {#if config.effortAttribute && effort}
        <dt>{config.effortAttribute}</dt>
        <dd>{effort}</dd>
      {/if}

      {#each attributesOf(node) as [name, value] (name)}
        {#if name !== config.effortAttribute}
          <dt>{name}</dt>
          <dd>{value}</dd>
        {/if}
      {/each}
    </dl>

    {#if issue}
      {#if issue.relatedFiles.length}
        <section>
          <h4>Files</h4>
          <ul>
            <!-- Text, never links: these are paths into somebody else's
                 checkout, and this page came from a URL a stranger supplied. -->
            {#each issue.relatedFiles as ref (ref)}
              <li class="path">{ref}</li>
            {/each}
          </ul>
        </section>
      {/if}

      {@render links('Blocked by', issue.dependsOn, 'Nothing blocks this.')}
      {@render links('Blocks', dependents[issue.id] ?? [], 'Nothing waits on this.')}
    {/if}

    {#if node.body.trim()}
      <section>
        <h4>Description</h4>
        <pre class="body">{node.body.trim()}</pre>
      </section>
    {/if}
  {/if}
</aside>

{#snippet links(heading: string, ids: string[], empty: string)}
  <section>
    <h4>{heading}</h4>
    {#if ids.length}
      <ul>
        {#each ids as id (id)}
          <li>
            <button type="button" class="link" onclick={() => go(id)}>
              <span class="id">{id}</span>
              {label(id)}
            </button>
          </li>
        {/each}
      </ul>
    {:else if empty}
      <p class="none">{empty}</p>
    {/if}
  </section>
{/snippet}

<style>
  .inspector {
    flex: none;
    width: 20rem;
    overflow-y: auto;
    padding: var(--space-3);
    border-left: 1px solid var(--border);
    background: var(--surface-1);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h2 {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-muted);
  }

  .close {
    border: none;
    background: none;
    color: var(--ink-muted);
    font-size: var(--text-lg);
    line-height: 1;
    cursor: pointer;
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-top: var(--space-3);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  h3 {
    margin: var(--space-1) 0 var(--space-3);
    font-size: var(--text-lg);
    line-height: 1.3;
  }

  h4 {
    margin: var(--space-4) 0 var(--space-1);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-muted);
  }

  dl {
    display: grid;
    grid-template-columns: 5.5rem 1fr;
    align-items: baseline;
    gap: var(--space-1) var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
  }

  dt {
    font-size: var(--text-xs);
    color: var(--ink-muted);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li + li {
    margin-top: 0.15rem;
  }

  .link {
    display: inline-flex;
    gap: var(--space-1);
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
  }

  .link:hover {
    text-decoration: underline;
  }

  .id {
    font-family: var(--font-mono);
    font-weight: 600;
  }

  .flag {
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--danger);
    color: var(--danger-ink);
    font-size: var(--text-xs);
    font-weight: 700;
  }

  .path {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }

  .none,
  .hint {
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }

  .hint {
    margin-top: var(--space-4);
  }

  .body {
    margin: 0;
    font-family: inherit;
    font-size: var(--text-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
