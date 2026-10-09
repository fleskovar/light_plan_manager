<script lang="ts">
  import type { NodePatch, ResourceDto } from '$shared';
  import { nodesOfKind } from '$lib/board/selectors.js';
  import Button from '$lib/ui/Button.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import { conversionOptions } from '$features/canvas/menus.js';
  import { editNode } from '$lib/workspace/mutations.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import ResourceForm from './ResourceForm.svelte';
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
   *
   * Every edit here lands on the board as it is made. A resource that does not
   * exist yet is `NewResourceDialog`'s, which creates nothing until asked.
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
  const types = $derived.by(() => {
    if (!resource) return [];
    const current = workspace.config.types[resource.type];
    return [
      { value: resource.type, label: current?.label ?? resource.type },
      ...conversionOptions(workspace, resource).map((option) => ({
        value: option.type,
        label: option.label,
      })),
    ];
  });
  const coverage = $derived(resource ? coverageOptions(workspace.nodes, resource) : null);

  /** Only offered when the board's roster actually nests, e.g. people in teams. */
  const parents = $derived(
    resource && resource.depth > 0
      ? nodesOfKind(workspace.nodes, 'resource').filter((one) => one.depth === resource.depth - 1)
      : [],
  );

  function edit(patch: NodePatch): void {
    editNode(workspace, id, patch);
  }

  function retype(type: string): void {
    if (!resource) return;
    const option = conversionOptions(workspace, resource).find((entry) => entry.type === type);
    if (option) edit({ type: option.type, parentId: option.parentId });
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
    <ResourceForm
      {resource}
      config={workspace.config}
      {types}
      {parents}
      {coverage}
      covering={(coverer) => coverer.covers.includes(id)}
      onedit={edit}
      ontype={retype}
      oncover={toggleCover}
      oncoverer={toggleCoverer}
    />
  {:else}
    <p class="note">That resource is no longer on the board.</p>
  {/if}

  {#snippet footer()}
    <Button variant="primary" onclick={onclose}>Done</Button>
  {/snippet}
</Modal>

<style>
  .note {
    margin: 0;
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }
</style>
