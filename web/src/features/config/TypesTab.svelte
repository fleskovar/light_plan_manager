<script lang="ts">
  import type { ConfigNamespace } from '$shared';
  import type { ConfigEditor } from './editor.svelte.js';
  import LabelNameForm from './LabelNameForm.svelte';
  import { count, namespacesOf } from './model.js';
  import TypeCard from './TypeCard.svelte';

  /**
   * The hierarchy of each namespace that the board declares: issues, periods,
   * the team and squads. A level is one folder depth, and the types of a level
   * are the types that a document at that depth can have.
   *
   * A type is added in two ways. "Add a type to this level" puts the type
   * beside the types of an existing level. "Insert a level here" gives the type
   * a level of its own, and each level below moves one level down. The server
   * refuses a new level above existing documents, so that button is disabled
   * while a document sits at that depth or deeper.
   */
  interface Props {
    editor: ConfigEditor;
  }

  let { editor }: Props = $props();

  const namespaces = $derived(namespacesOf(editor.config, editor.nodes));
  const typeNames = $derived(Object.keys(editor.config.types));

  let adding = $state<{ kind: ConfigNamespace; level: number; placement: 'join' | 'insert' } | null>(null);

  const isAdding = (kind: ConfigNamespace, level: number, placement: 'join' | 'insert'): boolean =>
    adding?.kind === kind && adding.level === level && adding.placement === placement;

  async function add(label: string, name: string): Promise<void> {
    if (!adding) return;
    const { kind, level, placement } = adding;
    const done = await editor.apply(
      [{ op: 'add-type', kind, name, label, level, placement }],
      placement === 'join'
        ? `Added the type "${name}" to level ${level + 1}.`
        : `Added the type "${name}" as the new level ${level + 1}.`,
    );
    if (done) adding = null;
  }
</script>

{#each namespaces as namespace (namespace.kind)}
  <section>
    <h3>{namespace.title}</h3>
    <ol>
      {#each namespace.levels as level (level.index)}
        {@render insert(namespace.kind, level.index, level.documentsFrom, 'Insert a level here')}
        <li class="level">
          <span class="depth">Level {level.index + 1}</span>
          <div class="types">
            {#each level.types as type (type.name)}
              <TypeCard {editor} {type} {typeNames} />
            {/each}
            {#if isAdding(namespace.kind, level.index, 'join')}
              <LabelNameForm
                taken={typeNames}
                what="type name"
                submitLabel="Add the type"
                busy={editor.busy}
                onsubmit={add}
                oncancel={() => (adding = null)}
              />
            {:else}
              <button
                type="button"
                class="link"
                disabled={editor.busy}
                onclick={() => (adding = { kind: namespace.kind, level: level.index, placement: 'join' })}
              >
                + Add a type to this level
              </button>
            {/if}
          </div>
        </li>
      {/each}
      {@render insert(namespace.kind, namespace.levels.length, 0, 'Add a level below')}
    </ol>
  </section>
{/each}

{#snippet insert(kind: ConfigNamespace, level: number, documents: number, label: string)}
  <li class="insert">
    {#if isAdding(kind, level, 'insert')}
      <LabelNameForm
        taken={typeNames}
        what="type name"
        submitLabel="Add the level"
        busy={editor.busy}
        onsubmit={add}
        oncancel={() => (adding = null)}
      />
    {:else}
      <button
        type="button"
        class="link"
        disabled={editor.busy || documents > 0}
        title={documents > 0
          ? `${count(documents, 'document')} sit at this level or deeper. A new level here needs a new parent above each one.`
          : 'Give a new type a level of its own at this position'}
        onclick={() => (adding = { kind, level, placement: 'insert' })}
      >
        + {label}
      </button>
    {/if}
  </li>
{/snippet}

<style>
  section + section {
    margin-top: var(--space-5);
  }

  h3 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-md);
  }

  ol {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .level {
    display: grid;
    grid-template-columns: 4.5rem 1fr;
    gap: var(--space-3);
    align-items: start;
  }

  .depth {
    padding-top: var(--space-2);
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .types {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .insert {
    padding-left: calc(4.5rem + var(--space-3));
  }

  .link {
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    font-size: var(--text-xs);
    text-align: left;
  }

  .link:disabled {
    color: var(--ink-faint);
  }
</style>
