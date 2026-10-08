<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import { draftProblems, useConnectionsState } from './connections.svelte.js';

  /**
   * Connect a remote: which tracker, where its project is, and the credential.
   *
   * Presentational. Every field comes from the provider descriptor the server
   * derives from the registry, so this file names no platform; every decision
   * lives in `connections.svelte.ts`.
   */
  interface Props {
    /** Remote names already declared on this board. */
    taken: readonly string[];
    onclose: () => void;
  }

  let { taken, onclose }: Props = $props();

  const connections = useConnectionsState();

  const draft = $derived(connections.draft);
  const provider = $derived(draft ? connections.providerNamed(draft.provider) : undefined);
  const problems = $derived(draft ? draftProblems(provider, draft, taken) : []);
  const conditionalKeys = $derived(new Set((provider?.conditional ?? []).map((field) => field.key)));
  const textFields = $derived(
    (provider?.connection ?? []).filter((field) => field.type === 'string' && !conditionalKeys.has(field.name)),
  );
  const discoverable = $derived(
    (provider?.connection ?? []).filter((field) => field.type === 'string' && conditionalKeys.has(field.name)),
  );
  const switches = $derived((provider?.connection ?? []).filter((field) => field.type === 'boolean'));

  const whyOf = (key: string): string => provider?.conditional.find((field) => field.key === key)?.why ?? '';

  async function submit(): Promise<void> {
    if (await connections.submitConnect(taken)) onclose();
  }
</script>

{#if draft && provider}
  <Modal title="Connect a remote" {onclose}>
    <form
      class="connect"
      autocomplete="off"
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div class="fields">
        <label>
          <span>Tracker</span>
          <select
            value={draft.provider}
            onchange={(event) => connections.chooseProvider(event.currentTarget.value, taken)}
          >
            {#each connections.providers as option (option.name)}
              <option value={option.name}>{option.name}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>Name</span>
          <input
            value={draft.name}
            oninput={(event) => (draft.name = event.currentTarget.value)}
            spellcheck="false"
          />
        </label>
      </div>

      {#if textFields.length || discoverable.length}
        <h4>Project</h4>
        <div class="fields">
          {#each textFields as field (field.name)}
            <label>
              <span>{field.name}{field.required ? '' : ' (optional)'}</span>
              <input
                value={String(draft.connection[field.name] ?? '')}
                oninput={(event) => (draft.connection[field.name] = event.currentTarget.value)}
                placeholder={field.example ?? ''}
                spellcheck="false"
              />
            </label>
          {/each}
          {#each discoverable as field (field.name)}
            <label>
              <span>{field.name} (optional)</span>
              <input
                value={String(draft.connection[field.name] ?? '')}
                oninput={(event) => (draft.connection[field.name] = event.currentTarget.value)}
                placeholder={field.example ?? ''}
                spellcheck="false"
              />
            </label>
            <p class="note wide">
              {whyOf(field.name)} Leave empty to detect it on <strong>Test connection</strong>.
            </p>
          {/each}
        </div>
      {/if}

      {#if provider.credentials.length}
        <h4>Credential</h4>
        {#if provider.credentialHint}
          <p class="note">{provider.credentialHint}</p>
        {/if}
        {#if provider.credentialUrl}
          <p class="note">
            <a href={provider.credentialUrl} target="_blank" rel="noreferrer">Create one ↗</a>
          </p>
        {/if}
        <div class="fields">
          {#each provider.credentials as field (field.key)}
            <label>
              <span>{field.key}</span>
              <input
                type={field.visible ? 'text' : 'password'}
                value={draft.credentials[field.key] ?? ''}
                oninput={(event) => (draft.credentials[field.key] = event.currentTarget.value)}
                autocomplete={field.visible ? 'off' : 'new-password'}
                spellcheck="false"
                placeholder={field.env ? `or set $${field.env}` : ''}
              />
            </label>
          {/each}
        </div>
        <p class="note">
          Stored in <code>.lpm/credentials.json</code> (git-ignored).
        </p>
      {/if}

      <details class="advanced">
        <summary>More options</summary>
        <div class="fields">
          <label>
            <span>Scope (optional)</span>
            <input
              value={draft.scope}
              oninput={(event) => (draft.scope = event.currentTarget.value)}
              placeholder="document id — empty for the whole board"
              spellcheck="false"
            />
          </label>
          {#each switches as field (field.name)}
            <label class="switch">
              <input
                type="checkbox"
                checked={draft.connection[field.name] === true}
                onchange={(event) => (draft.connection[field.name] = event.currentTarget.checked)}
              />
              <span>{field.name}</span>
            </label>
          {/each}
        </div>
        {#if switches.length}
          <p class="note">Unchecked options keep the tracker's default.</p>
        {/if}
      </details>

      {#if problems.length}
        <ul class="problems">
          {#each problems as problem (problem)}
            <li>{problem}</li>
          {/each}
        </ul>
      {/if}
    </form>

    {#snippet footer()}
      <Button onclick={onclose}>Cancel</Button>
      <Button variant="primary" disabled={problems.length > 0 || connections.submitting} onclick={() => void submit()}>
        {connections.submitting ? 'Connecting…' : 'Connect'}
      </Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .connect {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  h4 {
    margin: var(--space-3) 0 0;
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }

  .fields {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .fields label {
    display: contents;
  }

  .fields label > span {
    color: var(--ink-muted);
  }

  .fields input:not([type='checkbox']),
  .fields select {
    width: 100%;
  }

  .fields .switch {
    display: flex;
    grid-column: 1 / -1;
    align-items: center;
    gap: var(--space-2);
  }

  .note {
    margin: 0;
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .note.wide {
    grid-column: 1 / -1;
  }

  code {
    font-family: var(--font-mono);
    font-size: 0.9em;
  }

  .advanced {
    margin-top: var(--space-2);
  }

  .advanced summary {
    cursor: pointer;
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .advanced .fields {
    margin-top: var(--space-2);
  }

  .problems {
    margin: var(--space-2) 0 0;
    padding-left: var(--space-4);
    color: var(--danger, var(--warn));
    font-size: var(--text-xs);
  }
</style>
