<script lang="ts">
  import type { NodePatch, ResourceDto } from '$shared';
  import { nodesOfKind } from '$lib/board/selectors.js';
  import Button from '$lib/ui/Button.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import ResourceForm from './ResourceForm.svelte';
  import {
    canCreate,
    createFromDraft,
    draftNode,
    editDraft,
    newResourceDraft,
    toggleDraftCoverer,
  } from './resource-draft.js';
  import { coverageOptions } from './roster.js';

  /**
   * Adding a person or a pool. The same form as `ResourceDialog`, over a draft:
   * nothing is queued until Create, so the form cannot be pulled out from under
   * the reader by the push that follows every edit, and closing it leaves no
   * "New member" behind on the board.
   */
  interface Props {
    /** The type picked in the roster's toolbar; the form can still change it. */
    type: string;
    /** Called with the new resource's id after Create, or with nothing on cancel. */
    onclose: (created?: string) => void;
  }

  let { type, onclose }: Props = $props();

  const workspace = useWorkspace();

  // svelte-ignore state_referenced_locally
  let draft = $state(newResourceDraft(type));

  const resource = $derived(draftNode(draft, workspace.nodes, workspace.config));
  const types = $derived(
    Object.values(workspace.config.types)
      .filter((entry) => entry.kind === 'resource')
      .map((entry) => ({
        value: entry.name,
        label: `${entry.label}${entry.generic ? ' (pool)' : ''}`,
      })),
  );
  const coverage = $derived(coverageOptions(workspace.nodes, resource));
  const parents = $derived(
    resource.depth > 0
      ? nodesOfKind(workspace.nodes, 'resource').filter((one) => one.depth === resource.depth - 1)
      : [],
  );
  const ready = $derived(canCreate(draft));

  function edit(patch: NodePatch): void {
    draft = editDraft(draft, patch, workspace.nodes, workspace.config);
  }

  function toggleCover(poolId: string, on: boolean): void {
    const rest = draft.covers.filter((entry) => entry !== poolId);
    edit({ covers: on ? [...rest, poolId] : rest });
  }

  function toggleCoverer(coverer: ResourceDto, on: boolean): void {
    draft = toggleDraftCoverer(draft, coverer.id, on);
  }

  function create(): void {
    if (!ready) return;
    onclose(createFromDraft(workspace, $state.snapshot(draft)));
  }
</script>

<Modal title="Add to the team" onclose={() => onclose()}>
  <ResourceForm
    {resource}
    config={workspace.config}
    {types}
    {parents}
    {coverage}
    covering={(coverer) => draft.coveredBy.includes(coverer.id)}
    onedit={edit}
    ontype={(next) => edit({ type: next })}
    oncover={toggleCover}
    oncoverer={toggleCoverer}
    eager
    onsubmit={create}
  />

  {#snippet footer()}
    <Button onclick={() => onclose()}>Cancel</Button>
    <Button variant="primary" onclick={create} disabled={!ready}>Create</Button>
  {/snippet}
</Modal>
