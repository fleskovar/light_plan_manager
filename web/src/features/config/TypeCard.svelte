<script lang="ts">
  import type { AttributeDto, AttributeType, ConfigEdit } from '$shared';
  import Button from '$lib/ui/Button.svelte';
  import type { ConfigEditor } from './editor.svelte.js';
  import LabelNameForm from './LabelNameForm.svelte';
  import type { TypeRow } from './model.js';
  import {
    attributeEdits,
    attributeHolders,
    count,
    nameProblem,
    parseValues,
    typesSharing,
  } from './model.js';

  /**
   * One type of the hierarchy: its label, its name, the number of documents
   * that have the type, and its attributes. The card changes the label and the
   * name of the type, removes the type, and adds, changes and removes an
   * attribute.
   */
  interface Props {
    editor: ConfigEditor;
    type: TypeRow;
    /** The name of every type of the board, for the check that a new name is free. */
    typeNames: string[];
  }

  let { editor, type, typeNames }: Props = $props();

  const ATTRIBUTE_TYPES: AttributeType[] = ['string', 'text', 'int', 'float', 'bool', 'date', 'enum', 'array'];

  type Open =
    | { form: 'rename' }
    | { form: 'remove' }
    | { form: 'add-attribute' }
    | { form: 'edit-attribute'; attribute: string }
    | { form: 'remove-attribute'; attribute: string };

  let open = $state<Open | null>(null);
  let expanded = $state(false);

  // The fields of the attribute forms. `startAttribute` fills them when a form opens.
  let attrName = $state('');
  let attrType = $state<AttributeType>('string');
  let attrDescription = $state('');
  let attrValues = $state('');
  let everyType = $state(false);

  const editing = $derived(open?.form === 'edit-attribute' ? open.attribute : null);
  const original = $derived(type.attributes.find((attribute) => attribute.name === editing) ?? null);
  const sharing = $derived(editing ? typesSharing(editor.config, type.kind, type.name, editing) : []);
  const attributeNames = $derived(type.attributes.map((attribute) => attribute.name));
  const isEnum = $derived(open?.form === 'add-attribute' ? attrType === 'enum' : original?.type === 'enum');

  const attrProblem = $derived.by(() => {
    if (open?.form !== 'add-attribute' && open?.form !== 'edit-attribute') return null;
    if (attrName !== editing) {
      const problem = nameProblem(attrName, attributeNames, 'attribute name');
      if (problem) return problem;
    }
    if (isEnum && parseValues(attrValues).length === 0) return 'An enum attribute needs at least one value.';
    return null;
  });

  function startAttribute(attribute: AttributeDto | null): void {
    attrName = attribute?.name ?? '';
    attrType = attribute?.type ?? 'string';
    attrDescription = attribute?.description ?? '';
    attrValues = (attribute?.values ?? []).join(', ');
    everyType = false;
    expanded = true;
    open = attribute ? { form: 'edit-attribute', attribute: attribute.name } : { form: 'add-attribute' };
  }

  async function send(edits: ConfigEdit[], summary: string): Promise<void> {
    if (await editor.apply(edits, summary)) open = null;
  }

  function rename(label: string, name: string): void {
    const edit: ConfigEdit = { op: 'update-type', kind: type.kind, type: type.name };
    if (label !== type.label) edit.label = label;
    if (name !== type.name) edit.name = name;
    void send(
      [edit],
      name !== type.name
        ? `Renamed the type "${type.name}" to "${name}".`
        : `Changed the label of the type "${type.name}" to "${label}".`,
    );
  }

  function renameImpact(name: string): string | null {
    if (name === type.name) return null;
    return type.documents > 0
      ? `The name changes from "${type.name}" to "${name}". This rewrites the field "type" of ${count(type.documents, 'document')}.`
      : `The name changes from "${type.name}" to "${name}". No document has this type.`;
  }

  function addAttribute(event: SubmitEvent): void {
    event.preventDefault();
    if (attrProblem !== null || editor.busy) return;
    void send(
      [
        {
          op: 'add-attribute',
          kind: type.kind,
          type: type.name,
          name: attrName,
          attribute: {
            type: attrType,
            ...(attrDescription.trim() ? { description: attrDescription.trim() } : {}),
            ...(attrType === 'enum' ? { values: parseValues(attrValues) } : {}),
          },
        },
      ],
      `Added the attribute "${attrName}" to the type "${type.name}".`,
    );
  }

  function saveAttribute(event: SubmitEvent): void {
    event.preventDefault();
    if (!original || attrProblem !== null || editor.busy) return;
    const change: { name?: string; description?: string; values?: string[] } = {};
    if (attrName !== original.name) change.name = attrName;
    if (attrDescription.trim() !== (original.description ?? '')) change.description = attrDescription.trim();
    const values = parseValues(attrValues);
    if (original.type === 'enum' && values.join('\n') !== (original.values ?? []).join('\n')) {
      change.values = values;
    }
    if (!Object.keys(change).length) {
      open = null;
      return;
    }
    const types = everyType ? [type.name, ...sharing] : [type.name];
    void send(
      attributeEdits(type.kind, types, original.name, change),
      `Changed the attribute "${original.name}" of ${count(types.length, 'type')}.`,
    );
  }

  function removeAttribute(attribute: string): void {
    void send(
      [{ op: 'remove-attribute', kind: type.kind, type: type.name, attribute }],
      `Removed the attribute "${attribute}" from the type "${type.name}".`,
    );
  }

  const describe = (attribute: AttributeDto): string =>
    [
      attribute.values?.length ? attribute.values.join(', ') : '',
      attribute.default !== undefined ? `default: ${JSON.stringify(attribute.default)}` : '',
      attribute.required ? 'required' : '',
    ]
      .filter(Boolean)
      .join(' · ');
</script>

<article class="type">
  <header>
    <span class="label">{type.label}</span>
    <code>{type.name}</code>
    {#if type.atomic}<span class="flag" title="The queue offers work of this type whole">atomic</span>{/if}
    {#if type.generic}<span class="flag" title="A resource of this type is a pool, not a person">generic</span>{/if}
    <span class="uses">{count(type.documents, 'document')}</span>
    <span class="grow"></span>
    <button type="button" class="link" onclick={() => (expanded = !expanded)} aria-expanded={expanded}>
      {count(type.attributes.length, 'attribute')}
      {expanded ? '▴' : '▾'}
    </button>
    <Button size="sm" disabled={editor.busy} onclick={() => (open = { form: 'rename' })}>Rename</Button>
    <Button
      size="sm"
      disabled={editor.busy || type.documents > 0}
      title={type.documents > 0
        ? `${count(type.documents, 'document')} of this type exist. Convert or delete them first.`
        : 'Remove this type from the hierarchy'}
      onclick={() => (open = { form: 'remove' })}
    >
      Remove
    </Button>
  </header>

  {#if open?.form === 'rename'}
    <LabelNameForm
      label={type.label}
      name={type.name}
      taken={typeNames.filter((name) => name !== type.name)}
      what="type name"
      submitLabel="Save"
      busy={editor.busy}
      impact={renameImpact}
      onsubmit={rename}
      oncancel={() => (open = null)}
    />
  {:else if open?.form === 'remove'}
    <p class="confirm">
      <span>Remove the type "{type.name}" from the hierarchy? No document has this type.</span>
      <Button
        size="sm"
        variant="danger"
        disabled={editor.busy}
        onclick={() =>
          send(
            [{ op: 'remove-type', kind: type.kind, type: type.name }],
            `Removed the type "${type.name}".`,
          )}
      >
        Remove
      </Button>
      <Button size="sm" onclick={() => (open = null)}>Cancel</Button>
    </p>
  {/if}

  {#if expanded}
    <div class="attributes">
      {#if type.attributes.length}
        <table>
          <thead>
            <tr><th>Attribute</th><th>Type</th><th>Values</th><th>Description</th><th></th></tr>
          </thead>
          <tbody>
            {#each type.attributes as attribute (attribute.name)}
              <tr>
                <td><code>{attribute.name}</code></td>
                <td>{attribute.type}</td>
                <td>{describe(attribute)}</td>
                <td>{attribute.description ?? ''}</td>
                <td class="row-actions">
                  <button type="button" class="link" disabled={editor.busy} onclick={() => startAttribute(attribute)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    class="link danger"
                    disabled={editor.busy}
                    onclick={() => (open = { form: 'remove-attribute', attribute: attribute.name })}
                  >
                    Remove
                  </button>
                </td>
              </tr>
              {#if open?.form === 'remove-attribute' && open.attribute === attribute.name}
                {@const holders = attributeHolders(editor.nodes, type.kind, type.name, attribute.name)}
                <tr>
                  <td colspan="5">
                    <p class="confirm">
                      <span>
                        Remove the attribute "{attribute.name}" from the type "{type.name}"?
                        {holders > 0
                          ? `${count(holders, 'document')} hold a value, and the value is deleted from each.`
                          : 'No document holds a value.'}
                      </span>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={editor.busy}
                        onclick={() => removeAttribute(attribute.name)}
                      >
                        Remove
                      </Button>
                      <Button size="sm" onclick={() => (open = null)}>Cancel</Button>
                    </p>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="empty">This type declares no attributes.</p>
      {/if}

      {#if open?.form === 'add-attribute' || open?.form === 'edit-attribute'}
        <form class="attribute-form" onsubmit={open.form === 'add-attribute' ? addAttribute : saveAttribute}>
          <label>
            <span>Attribute name</span>
            <input class="mono" bind:value={attrName} spellcheck="false" />
          </label>
          {#if open.form === 'add-attribute'}
            <label>
              <span>Type</span>
              <select bind:value={attrType}>
                {#each ATTRIBUTE_TYPES as option (option)}
                  <option value={option}>{option}</option>
                {/each}
              </select>
            </label>
          {/if}
          {#if isEnum}
            <label class="wide">
              <span>Values, separated by commas</span>
              <input bind:value={attrValues} placeholder="high, medium, low" />
            </label>
          {/if}
          <label class="wide">
            <span>Description</span>
            <input bind:value={attrDescription} />
          </label>
          {#if open.form === 'edit-attribute' && sharing.length}
            <label class="check">
              <input type="checkbox" bind:checked={everyType} />
              Also change "{editing}" on {count(sharing.length, 'other type')}: {sharing.join(', ')}
            </label>
          {/if}
          <span class="actions">
            <Button size="sm" variant="primary" type="submit" disabled={editor.busy || attrProblem !== null}>
              {open.form === 'add-attribute' ? 'Add' : 'Save'}
            </Button>
            <Button size="sm" onclick={() => (open = null)}>Cancel</Button>
          </span>
          {#if attrProblem && attrName}
            <p class="problem">{attrProblem}</p>
          {:else if open.form === 'edit-attribute' && attrName !== editing && attrName}
            <p class="effect">
              The name changes from "{editing}" to "{attrName}". This moves the value in each document that
              holds one.
            </p>
          {/if}
        </form>
      {:else}
        <button type="button" class="link" disabled={editor.busy} onclick={() => startAttribute(null)}>
          + Add an attribute
        </button>
      {/if}
    </div>
  {/if}
</article>

<style>
  .type {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
  }

  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .label {
    font-weight: 600;
    font-size: var(--text-md);
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .flag {
    padding: 0 0.4rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .uses {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .grow {
    flex: 1;
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

  .link.danger {
    color: var(--danger);
  }

  .confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--danger);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }

  .confirm span {
    flex: 1;
    min-width: 14rem;
  }

  .attributes {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-xs);
  }

  th {
    text-align: left;
    color: var(--ink-muted);
    font-weight: 600;
    padding: 0 var(--space-2) var(--space-1) 0;
  }

  td {
    padding: var(--space-1) var(--space-2) var(--space-1) 0;
    border-top: 1px solid var(--surface-3);
    vertical-align: top;
  }

  .row-actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
    padding-right: 0;
  }

  .empty {
    margin: 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .attribute-form {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--accent);
    border-radius: var(--radius-md);
    background: var(--accent-soft);
  }

  .attribute-form label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 8rem;
  }

  .attribute-form .wide {
    flex: 1;
    min-width: 14rem;
  }

  .attribute-form label span {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .attribute-form .check {
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    flex-basis: 100%;
    font-size: var(--text-xs);
  }

  .attribute-form input:not([type='checkbox']),
  .attribute-form select {
    padding: 0.25rem 0.45rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-sm);
  }

  .mono {
    font-family: var(--font-mono);
  }

  .actions {
    display: inline-flex;
    gap: var(--space-2);
  }

  .attribute-form p {
    flex-basis: 100%;
    margin: 0;
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .problem {
    color: var(--danger);
  }

  .effect {
    color: var(--ink-muted);
  }
</style>
