<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api/client.js';
  import Button from '$lib/ui/Button.svelte';
  import { useWorkspace } from '$lib/workspace/workspace.svelte.js';
  import BoardPicker from './BoardPicker.svelte';
  import {
    MappingState,
    addRemoteName,
    assignStatus,
    assignType,
    boardStatusesFor,
    boardTypesFor,
    mapsPeriods,
    pushStatus,
    remoteStatusesOf,
    remoteTypeLevels,
    remoteTypesOf,
    sharedStatuses,
    staleNames,
    unassignStatus,
  } from './mapping.svelte.js';

  /**
   * The mapping of one tracker remote, side by side: the items of this board on
   * the left, the items that the tracker reports on the right. Each tracker
   * item has a control that chooses the board items that map to it.
   *
   * Three blocks, one for each thing that `remotes.<name>.mapping` maps: issue
   * types, statuses and periods. Save writes all three into `.lpm/config.yml`.
   *
   * Presentational. `mapping.svelte.ts` holds the draft and every rule.
   */
  interface Props {
    /** The name of the remote, as `remotes.<name>` declares it. */
    name: string;
    onback: () => void;
  }

  let { name, onback }: Props = $props();

  const workspace = useWorkspace();
  const mapping = new MappingState(api, () => workspace.config);

  // `onMount` and not `$effect`: the load reads and writes the state of the editor.
  onMount(() => {
    void mapping.load(name);
  });

  const config = $derived(workspace.config);
  const view = $derived(mapping.view);
  const draft = $derived(mapping.draft);
  const working = $derived(mapping.busy !== null);

  const labelOf = (type: string): string => config.types[type]?.label ?? type;
  const statusLabel = (id: string): string =>
    config.statuses.find((status) => status.id === id)?.label ?? id;

  const typeLevels = $derived(view && draft ? remoteTypeLevels(remoteTypesOf(view, draft)) : []);
  const remoteStatuses = $derived(view && draft ? remoteStatusesOf(view, draft) : []);
  const stale = $derived(view ? staleNames(view) : []);
  const shared = $derived(draft ? sharedStatuses(draft) : []);
  const periods = $derived(view !== null && mapsPeriods(view, config));
  const periodTypes = $derived(config.hierarchy.period.flat());

  let newType = $state('');
  let newStatus = $state('');

  function addName(block: 'types' | 'statuses'): void {
    const value = block === 'types' ? newType : newStatus;
    mapping.change((current) => addRemoteName(current, view!, block, value));
    if (block === 'types') newType = '';
    else newStatus = '';
  }

  const levelName = (level: number | null): string =>
    level === null ? '' : level < 0 ? 'Sub-task level' : `Level ${level}`;
</script>

<div class="editor">
  <header class="bar">
    <Button size="sm" onclick={onback}>← Remote board</Button>
    <strong>Mapping of “{name}”</strong>
    {#if view}<span class="faint">{view.provider}</span>{/if}
    <span class="grow"></span>
    <Button size="sm" disabled={working} onclick={() => void mapping.load(name)}>
      {mapping.busy === 'reading' ? 'Reading the tracker…' : 'Read the tracker again'}
    </Button>
    <Button
      size="sm"
      variant="primary"
      disabled={working || !mapping.dirty || mapping.problems.length > 0}
      onclick={() => void mapping.save()}
    >
      {mapping.busy === 'saving' ? 'Saving…' : 'Save the mapping'}
    </Button>
  </header>

  {#if mapping.problem}
    <div class="strip bad" role="alert">
      <strong>{mapping.problem.message}</strong>
      {#if mapping.problem.details.length}
        <ul>
          {#each mapping.problem.details as detail (detail)}<li>{detail}</li>{/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if mapping.saved}
    <div class="strip good" role="status">
      {#if mapping.saved.length}
        <strong>Saved to .lpm/config.yml.</strong>
        <ul>
          {#each mapping.saved as line (line)}<li><code>{line}</code></li>{/each}
        </ul>
        {#if view && view.linked > 0}
          <p>
            This remote mirrors {view.linked} document{view.linked === 1 ? '' : 's'}. The next sync stops
            until you run <code>lpm remote rebase {name}</code>.
          </p>
        {/if}
      {:else}
        <strong>The file already held this mapping.</strong>
      {/if}
    </div>
  {/if}

  {#if !view || !draft}
    {#if mapping.busy === 'reading'}
      <p class="placeholder">Asking the tracker for its issue types, statuses and sprints…</p>
    {/if}
  {:else}
    {#if view.reachability && !view.reachability.reachable}
      <div class="strip warn">
        <strong>The tracker is not reachable, so the lists below come from the mapping.</strong>
        <p>{view.reachability.evidence}</p>
      </div>
    {/if}
    {#each view.problems as problem (problem)}
      <div class="strip warn"><p>{problem}</p></div>
    {/each}
    {#if stale.length}
      <div class="strip warn">
        <strong>The mapping names words that the tracker does not have.</strong>
        <ul>
          {#each stale as entry (entry.block + entry.boardKey + entry.name)}
            <li>
              {entry.block === 'types' ? 'Type' : 'Status'} <code>{entry.boardKey}</code> maps to
              “{entry.name}”. Choose another item for it.
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#each mapping.problems as problem (problem)}
      <div class="strip bad"><p>{problem}</p></div>
    {/each}

    <!-- Issue types -->
    <section>
      <h4>Issue types</h4>
      <div class="sides">
        <div class="side">
          <h5>This board</h5>
          <ul class="tree">
            {#each config.hierarchy.issue as level, depth (depth)}
              {#each level as type (type)}
                <li style:padding-left="{depth * 0.9}rem" class:unmapped={!draft.types[type]}>
                  <span class="item">{labelOf(type)} <code>{type}</code></span>
                  <span class="to">{draft.types[type] ? `→ ${draft.types[type]}` : 'not mapped'}</span>
                </li>
              {/each}
            {/each}
          </ul>
        </div>
        <div class="side">
          <h5>{name}</h5>
          <ul class="tree">
            {#each typeLevels as level (level.level)}
              {#if level.level !== null}
                <li class="level" style:padding-left="{level.indent * 0.9}rem">{levelName(level.level)}</li>
              {/if}
              {#each level.types as item (item.name)}
                {@const chosen = boardTypesFor(draft, item.name)}
                <li style:padding-left="{level.indent * 0.9 + (level.level === null ? 0 : 0.9)}rem">
                  <span class="item">
                    {item.name}
                    {#if item.subtask}<span class="flag" title="The tracker creates this type only under a parent">sub-task</span>{/if}
                  </span>
                  <BoardPicker
                    chosen={chosen.map((type) => ({ id: type, label: labelOf(type) }))}
                    options={Object.keys(draft.types)
                      .filter((type) => !chosen.includes(type))
                      .map((type) => ({
                        id: type,
                        label: labelOf(type),
                        hint: draft.types[type] ? `now ${draft.types[type]}` : 'not mapped',
                      }))}
                    placeholder="Add a board type…"
                    disabled={working}
                    onadd={(type) => mapping.change((current) => assignType(current, type, item.name))}
                    onremove={(type) => mapping.change((current) => assignType(current, type, ''))}
                  />
                </li>
              {/each}
            {/each}
          </ul>
          {#if !view.types.fixed}
            <p class="note">
              The tracker reported no list of issue types. The names above come from the mapping, and
              light-plan writes each name as it is.
            </p>
            <form class="add" onsubmit={(event) => { event.preventDefault(); addName('types'); }}>
              <input bind:value={newType} placeholder="Another tracker type" aria-label="Another tracker type" />
              <Button size="sm" type="submit" disabled={!newType.trim()}>Add</Button>
            </form>
          {/if}
        </div>
      </div>
    </section>

    <!-- Statuses -->
    <section>
      <h4>Statuses</h4>
      <div class="sides">
        <div class="side">
          <h5>This board</h5>
          <ul class="tree">
            {#each config.statuses as status (status.id)}
              {@const states = draft.statuses[status.id] ?? []}
              <li class:unmapped={states.length === 0}>
                <span class="item">
                  {status.label} <code>{status.id}</code>
                  {#if status.terminal}<span class="flag">terminal</span>{/if}
                </span>
                <span class="to">
                  {#if states.length === 0}
                    not mapped
                  {:else if states.length === 1}
                    → {states[0]}
                  {:else}
                    <label class="push">
                      a push writes
                      <select
                        value={states[0]}
                        disabled={working}
                        onchange={(event) => {
                          const chosen = event.currentTarget.value;
                          mapping.change((current) => pushStatus(current, status.id, chosen));
                        }}
                      >
                        {#each states as option (option)}<option value={option}>{option}</option>{/each}
                      </select>
                    </label>
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        </div>
        <div class="side">
          <h5>{name}</h5>
          <ul class="tree">
            {#each remoteStatuses as remote (remote)}
              {@const chosen = boardStatusesFor(draft, remote)}
              <li>
                <span class="item">{remote}</span>
                <BoardPicker
                  chosen={chosen.map((id) => ({ id, label: statusLabel(id) }))}
                  options={config.statuses
                    .filter((status) => !chosen.includes(status.id))
                    .map((status) => ({
                      id: status.id,
                      label: status.label,
                      hint: (draft.statuses[status.id] ?? []).length ? undefined : 'not mapped',
                    }))}
                  placeholder="Add a board status…"
                  disabled={working}
                  onadd={(id) => mapping.change((current) => assignStatus(current, id, remote))}
                  onremove={(id) => mapping.change((current) => unassignStatus(current, id, remote))}
                />
              </li>
            {/each}
          </ul>
          {#if !view.statuses.fixed}
            <p class="note">
              The tracker reported no list of statuses. The names above come from the mapping.
            </p>
            <form class="add" onsubmit={(event) => { event.preventDefault(); addName('statuses'); }}>
              <input bind:value={newStatus} placeholder="Another tracker status" aria-label="Another tracker status" />
              <Button size="sm" type="submit" disabled={!newStatus.trim()}>Add</Button>
            </form>
          {/if}
        </div>
      </div>
      {#each shared as entry (entry.remote)}
        <p class="note">
          “{entry.remote}” means {entry.statuses.length} board statuses: {entry.statuses.join(', ')}. A pull
          cannot tell them apart, and <code>lpm check</code> reports the pair.
        </p>
      {/each}
    </section>

    <!-- Periods -->
    {#if config.hasPeriods}
      <section>
        <h4>Periods</h4>
        {#if !view.periods.native}
          <p class="note">
            This tracker has no container for a period. light-plan stores the period of each issue in the
            managed block of the issue, so nothing is mapped here.
          </p>
        {:else}
          <div class="sides">
            <div class="side">
              <h5>This board</h5>
              <ul class="tree">
                {#each config.hierarchy.period as level, depth (depth)}
                  {#each level as type (type)}
                    <li style:padding-left="{depth * 0.9}rem">
                      <span class="item">{labelOf(type)} <code>{type}</code></span>
                      <span class="to">
                        {draft.periodContainer === type
                          ? `→ ${view.periods.carrier ?? 'the container of the tracker'}`
                          : 'stored in the managed block'}
                      </span>
                    </li>
                  {/each}
                {/each}
              </ul>
            </div>
            <div class="side">
              <h5>{name}</h5>
              <ul class="tree">
                <li>
                  <span class="item">{view.periods.carrier ?? 'Period container'}</span>
                  <select
                    aria-label="The board period type that maps to this container"
                    value={draft.periodContainer ?? ''}
                    disabled={working || !periods}
                    onchange={(event) => {
                      const chosen = event.currentTarget.value;
                      mapping.change((current) => ({ ...current, periodContainer: chosen || null }));
                    }}
                  >
                    <option value="">Choose a period type…</option>
                    {#each periodTypes as type (type)}
                      <option value={type}>{labelOf(type)}</option>
                    {/each}
                  </select>
                </li>
                {#each view.periods.items ?? [] as item (item.name)}
                  <li class="child">
                    <span class="item">{item.name}</span>
                    <span class="to">
                      {item.state}{item.starts ? ` · ${item.starts}` : ''}{item.ends ? ` to ${item.ends}` : ''}
                    </span>
                  </li>
                {/each}
              </ul>
              {#if view.periods.items === null}
                <p class="note">The tracker did not list its {view.periods.carrier ?? 'containers'}.</p>
              {:else if view.periods.items.length === 0}
                <p class="note">The tracker holds no {view.periods.carrier ?? 'container'} yet.</p>
              {:else}
                <p class="note">
                  A push matches a period of the mapped type to one of these by its title.
                </p>
              {/if}
            </div>
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .grow {
    flex: 1;
  }

  .faint {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .placeholder {
    margin: var(--space-4) 0;
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }

  .strip {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .strip p {
    margin: 0;
  }

  .strip ul {
    margin: var(--space-1) 0 0;
    padding-left: var(--space-4);
    font-size: var(--text-xs);
  }

  .strip.bad {
    border: 1px solid var(--danger);
    color: var(--danger);
  }

  .strip.warn {
    border: 1px solid var(--warn);
  }

  .strip.good {
    border: 1px solid var(--tone-done);
    background: var(--tone-done-soft);
  }

  h4 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-md);
  }

  h5 {
    margin: 0 0 var(--space-1);
    color: var(--ink-muted);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .sides {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    gap: var(--space-4);
    align-items: start;
  }

  .side {
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
  }

  .tree {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .tree li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    min-height: 1.9rem;
    border-top: 1px solid var(--surface-3);
    font-size: var(--text-sm);
  }

  .tree li:first-child {
    border-top: none;
  }

  .tree .level {
    min-height: 1.4rem;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .tree .child {
    padding-left: 0.9rem;
  }

  .item {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .to {
    flex: none;
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-align: right;
  }

  .unmapped .to {
    color: var(--danger);
    font-weight: 600;
  }

  .flag {
    padding: 0 0.35rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .push {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }

  select,
  .add input {
    padding: 0.15rem 0.3rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-xs);
  }

  .add {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .add input {
    flex: 1;
    min-width: 0;
  }

  .note {
    margin: var(--space-2) 0 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  section > .note code {
    color: inherit;
  }
</style>
