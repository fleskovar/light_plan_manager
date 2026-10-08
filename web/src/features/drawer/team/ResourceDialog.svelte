<script lang="ts">
  import type { ResourceDto } from '$shared';
  import { nodesOfKind } from '$lib/board/selectors.js';
  import AttributeField from '$lib/ui/fields/AttributeField.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import TypeIcon from '$lib/ui/TypeIcon.svelte';
  import { conversionOptions } from '$features/canvas/menus.js';
  import { editNode } from '$lib/workspace/mutations.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import { coverageOptions } from './roster.js';

  /**
   * Everything about one person or pool, in one place.
   *
   * The card in the roster edits the two fields you change while reading it —
   * the name and the capacity — and that is all it should do. The rest of a
   * resource (what it is, whose team it is on, which pools it can take work
   * from, the attributes the board declares) belongs to a form you open on
   * purpose. Coverage in particular was the thing you could not do from a card
   * at all, and it is the reason this dialog exists.
   */
  interface Props {
    id: string;
    onclose: () => void;
  }

  let { id, onclose }: Props = $props();

  const workspace = useWorkspace();

  const resource = $derived(
    workspace.node(id)?.kind === 'resource' ? (workspace.node(id) as ResourceDto) : null,
  );
  const type = $derived(resource ? workspace.config.types[resource.type] : undefined);
  const conversions = $derived(resource ? conversionOptions(workspace, resource) : []);
  const coverage = $derived(resource ? coverageOptions(workspace.nodes, resource) : null);

  /** Only offered when the board's roster actually nests, e.g. people in teams. */
  const parents = $derived(
    resource && resource.depth > 0
      ? nodesOfKind(workspace.nodes, 'resource').filter((one) => one.depth === resource.depth - 1)
      : [],
  );

  function edit(patch: Record<string, unknown>): void {
    editNode(workspace, id, patch);
  }

  /** A pool this resource can take work from. Stored on this document. */
  function toggleCover(poolId: string, on: boolean): void {
    if (!resource) return;
    const covers = on
      ? [...resource.covers, poolId]
      : resource.covers.filter((entry) => entry !== poolId);
    edit({ covers });
  }

  /**
   * Someone who can take work from this pool. Stored on *their* document —
   * only forward edges are kept, here as much as on the board.
   */
  function toggleCoverer(coverer: ResourceDto, on: boolean): void {
    const covers = on
      ? [...coverer.covers, id]
      : coverer.covers.filter((entry) => entry !== id);
    editNode(workspace, coverer.id, { covers });
  }
</script>

<Modal title={resource ? `Edit ${resource.title}` : 'Edit resource'} {onclose}>
  {#if resource}
    <div class="fields">
      <label>
        <span>Name</span>
        <input
          value={resource.title}
          onchange={(event) => edit({ title: event.currentTarget.value })}
        />
      </label>

      <label>
        <span>Type</span>
        <select
          value={resource.type}
          onchange={(event) => {
            const option = conversions.find((entry) => entry.type === event.currentTarget.value);
            if (option) edit({ type: option.type, parentId: option.parentId });
          }}
        >
          <option value={resource.type}>{type?.label ?? resource.type}</option>
          {#each conversions as option (option.type)}
            <option value={option.type}>{option.label}</option>
          {/each}
        </select>
      </label>

      {#if parents.length}
        <label>
          <span>Team</span>
          <select
            value={resource.parentId ?? ''}
            onchange={(event) => edit({ parentId: event.currentTarget.value || null })}
          >
            <option value="">Unattached</option>
            {#each parents as parent (parent.id)}
              <option value={parent.id}>{parent.title}</option>
            {/each}
          </select>
        </label>
      {/if}

      <label>
        <span>Capacity</span>
        <input
          type="number"
          min="0"
          step="0.5"
          value={resource.capacity}
          onchange={(event) => edit({ capacity: Number(event.currentTarget.value) || 0 })}
        />
      </label>
    </div>

    {#if coverage?.pools.length}
      <h4>Covers</h4>
      <p class="note">Pools this {type?.label ?? 'resource'} can pick work up from.</p>
      <ul class="checks">
        {#each coverage.pools as pool (pool.id)}
          <li>
            <label>
              <input
                type="checkbox"
                checked={resource.covers.includes(pool.id)}
                onchange={(event) => toggleCover(pool.id, event.currentTarget.checked)}
              />
              <span class="icon"><TypeIcon type={pool.type} depth={pool.depth} /></span>
              {pool.title}
              <span class="muted">{workspace.config.types[pool.type]?.label ?? pool.type}</span>
            </label>
          </li>
        {/each}
      </ul>
    {/if}

    {#if resource.generic}
      <h4>Covered by</h4>
      {#if coverage?.coverers.length}
        <p class="note">Who can take work from this pool.</p>
        <ul class="checks">
          {#each coverage.coverers as coverer (coverer.id)}
            <li>
              <label>
                <input
                  type="checkbox"
                  checked={coverer.covers.includes(id)}
                  onchange={(event) => toggleCoverer(coverer, event.currentTarget.checked)}
                />
                <span class="icon"><TypeIcon type={coverer.type} depth={coverer.depth} /></span>
                {coverer.title}
              </label>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="note">Add a person to the team to cover this pool.</p>
      {/if}
    {/if}

    {#if type?.attributes.length}
      <h4>Attributes</h4>
      <div class="fields">
        {#each type.attributes as attribute (attribute.name)}
          <label>
            <span title={attribute.description}>{attribute.name.replace(/_/g, ' ')}</span>
            <AttributeField
              {attribute}
              value={resource.attributes[attribute.name]}
              onchange={(value) => edit({ attributes: { [attribute.name]: value } })}
            />
          </label>
        {/each}
      </div>
    {/if}

    <h4>Notes</h4>
    <textarea
      class="body"
      rows="6"
      value={resource.body}
      onchange={(event) => edit({ body: event.currentTarget.value })}
    ></textarea>
  {:else}
    <p class="note">That resource is no longer on the board.</p>
  {/if}

  {#snippet footer()}
    <Button variant="primary" onclick={onclose}>Done</Button>
  {/snippet}
</Modal>

<style>
  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  label {
    display: grid;
    grid-template-columns: 6rem 1fr;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  .fields label > span:first-child {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: capitalize;
  }

  .fields input,
  .fields select {
    width: 100%;
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-sm);
  }

  h4 {
    margin: var(--space-4) 0 var(--space-1);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-muted);
  }

  .note {
    margin: 0 0 var(--space-2);
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .checks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .checks label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0.15rem 0.3rem;
    border-radius: var(--radius-sm);
  }

  .checks label:hover {
    background: var(--surface-2);
  }

  .icon {
    display: inline-flex;
    color: var(--ink-muted);
  }

  .muted {
    margin-left: auto;
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .body {
    width: 100%;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.6;
    resize: vertical;
  }
</style>
