<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '$lib/ui/Button.svelte';
  import type { ConfigEditor } from './editor.svelte.js';

  /**
   * The board templates: the config files that `lpm init` copies into a new
   * board. The tab saves the configuration of this board as a template, chooses
   * the template that `lpm init` uses when no `--template` is given, and
   * deletes a template of the user.
   *
   * The templates are in the user folder (`~/.light-plan`), which the server
   * names in its answer. They belong to one person on one machine, and no board
   * holds them.
   */
  interface Props {
    editor: ConfigEditor;
  }

  let { editor }: Props = $props();

  // The server holds the same pattern in `operations/board-template.ts`.
  const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

  let name = $state('');
  let removing = $state<string | null>(null);

  const templates = $derived(editor.templates?.templates ?? []);
  const trimmed = $derived(name.trim());
  const existing = $derived(templates.find((template) => template.name === trimmed) ?? null);
  const problem = $derived(
    trimmed === ''
      ? null
      : !NAME_RE.test(trimmed)
        ? 'Use 1 to 40 lower-case letters, digits, "-" or "_", starting with a letter or a digit.'
        : existing?.source === 'builtin'
          ? `"${trimmed}" is a built-in template. Choose another name.`
          : null,
  );

  // `onMount` and not `$effect`: the load reads state of the editor, and an
  // effect that read it would run the load again after each request.
  onMount(() => {
    void editor.loadTemplates();
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!trimmed || problem !== null || editor.busy) return;
    if (await editor.saveTemplate(trimmed, existing !== null)) name = '';
  }

  async function remove(template: string): Promise<void> {
    if (await editor.removeTemplate(template)) removing = null;
  }
</script>

<section>
  <h3>Save this configuration as a template</h3>
  <p class="lede">
    The template holds the statuses, the types, the hierarchy and the attributes of this board. It does not
    hold the issues, the tracker remotes, the git settings or the planning mode.
  </p>
  <form onsubmit={save}>
    <label>
      <span>Template name</span>
      <input class="mono" bind:value={name} placeholder="team-flow" spellcheck="false" />
    </label>
    <Button size="sm" variant="primary" type="submit" disabled={!trimmed || problem !== null || editor.busy}>
      {existing?.source === 'user' ? 'Replace the template' : 'Save as a template'}
    </Button>
  </form>
  {#if problem}
    <p class="problem">{problem}</p>
  {:else if existing?.source === 'user'}
    <p class="hint">A template called "{trimmed}" exists. Saving replaces its file.</p>
  {/if}
</section>

<section>
  <h3>Template for new boards</h3>
  <p class="lede">
    <code>lpm init</code> starts a new board from the selected template when no <code>--template</code> is given.
  </p>
  {#if editor.templates}
    <ul>
      {#each templates as template (template.name)}
        <li>
          <label class="choice">
            <input
              type="radio"
              name="default-template"
              checked={editor.templates.default === template.name}
              disabled={editor.busy}
              onchange={() => editor.setDefault(template.name)}
            />
            <code>{template.name}</code>
          </label>
          <span class="source">{template.source === 'builtin' ? 'built-in' : 'saved by you'}</span>
          <span class="grow"></span>
          {#if template.source === 'user'}
            {#if removing === template.name}
              <span class="confirm">Delete the file of this template?</span>
              <Button size="sm" variant="danger" disabled={editor.busy} onclick={() => remove(template.name)}>
                Delete
              </Button>
              <Button size="sm" onclick={() => (removing = null)}>Cancel</Button>
            {:else}
              <Button size="sm" disabled={editor.busy} onclick={() => (removing = template.name)}>Delete</Button>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
    <p class="note">
      The templates of the user are files in <code>{editor.templates.folder}</code>. The default is the key
      <code>default_template</code> in the file <code>settings.json</code> of that folder.
    </p>
  {:else if !editor.problem}
    <p class="note">Reading the templates…</p>
  {/if}
</section>

<style>
  section + section {
    margin-top: var(--space-5);
  }

  h3 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-md);
  }

  .lede {
    margin: 0 0 var(--space-3);
    color: var(--ink-muted);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  form {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3);
  }

  form label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    max-width: 20rem;
  }

  form label span {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  form input {
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-sm);
  }

  .mono,
  code {
    font-family: var(--font-mono);
  }

  code {
    font-size: 0.95em;
  }

  .problem,
  .hint {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
  }

  .problem {
    color: var(--danger);
  }

  .hint {
    color: var(--ink-muted);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    border-top: 1px solid var(--border);
    font-size: var(--text-sm);
  }

  li:first-child {
    border-top: none;
  }

  .choice {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .source {
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .grow {
    flex: 1;
  }

  .confirm {
    font-size: var(--text-xs);
    color: var(--danger);
  }

  .note {
    margin: var(--space-3) 0 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
</style>
