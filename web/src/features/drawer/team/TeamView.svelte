<script lang="ts">
  import { useShell } from '$lib/app/shell.svelte.js';
  import Button from '$lib/ui/Button.svelte';
  import { createNode, editNode, removeNodes } from '$lib/workspace/mutations.js';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import ResourceCard from './ResourceCard.svelte';
  import { buildRoster, groupRoster, type GroupMode } from './roster.js';
  import { buildSquads, availableForSquad, type SquadEntry } from './squads.js';

  /**
   * The roster: who is on the team, how loaded they are, and which pools they
   * can pick work up from. Grouping is a lens over the same cards rather than a
   * different list, so a person can legitimately appear twice.
   */
  const workspace = useWorkspace();
  const shell = useShell();

  let mode = $state<GroupMode>('type');
  let newType = $state('');

  const entries = $derived(buildRoster(workspace.nodes, workspace.config));
  const groups = $derived(groupRoster(workspace.nodes, workspace.config, entries, mode));
  const resourceTypes = $derived(
    Object.values(workspace.config.types).filter((type) => type.kind === 'resource'),
  );

  const hasSquads = $derived(workspace.config.hasSquads);
  const squads = $derived(hasSquads ? buildSquads(workspace.nodes) : []);
  let editingSquad = $state<SquadEntry | null>(null);
  let addMemberId = $state('');

  const modes: { id: GroupMode; label: string }[] = [
    { id: 'type', label: 'Discipline' },
    { id: 'team', label: 'Team' },
    { id: 'work', label: 'Assignment' },
    { id: 'pool', label: 'Pool' },
  ];

  function add(): void {
    const type = newType || resourceTypes[0]?.name;
    if (!type) return;
    // Straight into the form: a resource is worth nothing until it has a name
    // and, usually, a pool it covers. The form creates it, not this button.
    shell.newResource(type);
  }

  function remove(id: string): void {
    shell.confirm({
      title: 'Remove from the roster?',
      message: `${workspace.node(id)?.title ?? id} will be deleted on push.`,
      details: ['Their issues become unassigned.'],
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () => removeNodes(workspace, [id]),
    });
  }

  function addSquad(): void {
    const id = createNode(workspace, {
      nodeKind: 'squad',
      type: 'squad',
      title: 'New squad',
      parentId: null,
    });
    workspace.selection.set([id]);
  }

  function toggleMember(squad: SquadEntry, resourceId: string): void {
    const members = squad.squad.members;
    const next = members.includes(resourceId)
      ? members.filter((id) => id !== resourceId)
      : [...members, resourceId];
    editNode(workspace, squad.squad.id, { members: next });
  }

  function removeSquad(id: string): void {
    shell.confirm({
      title: 'Remove this squad?',
      message: `${workspace.node(id)?.title ?? id} will be deleted on push.`,
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () => removeNodes(workspace, [id]),
    });
  }
</script>

<div class="team">
  <div class="toolbar">
    <span class="label">Group by</span>
    {#each modes as option (option.id)}
      <button
        class="mode"
        class:active={mode === option.id}
        type="button"
        onclick={() => (mode = option.id)}
      >
        {option.label}
      </button>
    {/each}

    <div class="spacer"></div>

    <select bind:value={newType} aria-label="New resource type">
      {#each resourceTypes as type (type.name)}
        <option value={type.name}>{type.label}{type.generic ? ' (pool)' : ''}</option>
      {/each}
    </select>
    <Button size="sm" onclick={add} disabled={!resourceTypes.length}>Add</Button>
  </div>

  {#if !entries.length}
    <p class="empty">
      No team members. Add a person or a pool.
    </p>
  {:else}
    <div class="groups">
      {#each groups as group (group.key)}
        <section>
          <h3>
            {group.label}
            <span class="count">{group.entries.length}</span>
          </h3>
          <div class="cards">
            {#each group.entries as entry (entry.resource.id)}
              <ResourceCard
                {entry}
                config={workspace.config}
                selected={workspace.selection.has(entry.resource.id)}
                onselect={(id) => workspace.selection.set([id])}
                onedit={(id, patch) => editNode(workspace, id, patch)}
                onopen={(id) => shell.editResource(id)}
                onremove={remove}
              />
            {/each}
          </div>
        </section>
      {/each}
    </div>
    <p class="hint">
      Drag a card onto a node to assign it.
    </p>
  {/if}

  {#if hasSquads}
    <div class="squads-section">
      <div class="squads-toolbar">
        <h4>Squads</h4>
        <Button size="sm" onclick={addSquad}>New Squad</Button>
      </div>
      {#if squads.length === 0}
        <p class="empty">No squads. Create one to group resources into a sub-team.</p>
      {:else}
        <div class="cards">
          {#each squads as entry (entry.squad.id)}
            <div class="squad-card">
              <div class="squad-head">
                <span class="squad-title">{entry.squad.title}</span>
                <div class="squad-actions">
                  <button
                    type="button"
                    class="icon-btn"
                    title="Edit members"
                    onclick={() => (editingSquad = editingSquad === entry ? null : entry)}
                  >
                    {editingSquad === entry ? '✕' : '✎'}
                  </button>
                  <button
                    type="button"
                    class="icon-btn danger"
                    title="Remove squad"
                    onclick={() => removeSquad(entry.squad.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div class="squad-members">
                {#each entry.members as m (m.id)}
                  <span class="member-chip" title={m.id}>{m.title}</span>
                {/each}
                {#if entry.members.length === 0}
                  <span class="empty-members">No members</span>
                {/if}
              </div>

              {#if editingSquad === entry}
                <div class="member-editor">
                  <select bind:value={addMemberId} aria-label="Add resource to squad">
                    <option value="">Add member…</option>
                    {#each availableForSquad(workspace.nodes, entry.squad) as r (r.id)}
                      <option value={r.id}>{r.title}</option>
                    {/each}
                  </select>
                  <Button
                    size="sm"
                    disabled={!addMemberId}
                    onclick={() => {
                      toggleMember(entry, addMemberId);
                      addMemberId = '';
                    }}
                  >
                    Add
                  </Button>
                  {#each entry.members as m (m.id)}
                    <button
                      type="button"
                      class="remove-chip"
                      title="Remove {m.title}"
                      onclick={() => toggleMember(entry, m.id)}
                    >
                      {m.title} ✕
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .team {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--surface-1);
    z-index: 1;
  }

  .label {
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .mode {
    padding: 0.15rem 0.5rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .mode.active {
    background: var(--surface-3);
    border-color: var(--border);
    color: var(--ink);
    font-weight: 600;
  }

  .spacer {
    flex: 1;
  }

  select {
    padding: 0.15rem 0.3rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-xs);
  }

  .groups {
    flex: 1;
    overflow: auto;
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  h3 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
  }

  .count {
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--surface-3);
    color: var(--ink-muted);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: var(--space-2);
  }

  .hint,
  .empty {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .empty {
    padding: var(--space-5);
    text-align: center;
    font-size: var(--text-sm);
  }
</style>
