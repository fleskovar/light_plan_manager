<script lang="ts">
  import { untrack } from 'svelte';
  import { useShell } from '$lib/app/shell.svelte.js';
  import Button from '$lib/ui/Button.svelte';
  import {
    describeCredential,
    describePrerequisites,
    unresolvedWords,
    useConnectionsState,
  } from './connections.svelte.js';

  /**
   * One remote's connection: where it points, its credential, a test that asks
   * the tracker about itself, and removal.
   *
   * Presentational. Nothing here names a platform or decides anything — the
   * fields come from the provider descriptor, and the refusals (a remote with
   * twins is not re-pointed, a secret never reaches config.yml) come back from
   * the server in its own words.
   */
  interface Props {
    name: string;
  }

  let { name }: Props = $props();

  const connections = useConnectionsState();
  const shell = useShell();

  // Load when the remote changes — and only then: loadConnection reads state,
  // and tracking it here would reload on every change it makes.
  $effect(() => {
    const target = name;
    untrack(() => void connections.loadConnection(target));
  });

  const connection = $derived(connections.connection?.name === name ? connections.connection : null);
  const provider = $derived(connection ? connections.providerNamed(connection.provider) : undefined);
  const textFields = $derived((provider?.connection ?? []).filter((field) => field.type === 'string'));
  const switches = $derived((provider?.connection ?? []).filter((field) => field.type === 'boolean'));
  const missing = $derived(connection ? connection.credentials.filter((state) => state.source === undefined) : []);
  const report = $derived(connections.inspection?.remoteName === name ? connections.inspection : null);
  const words = $derived(report ? unresolvedWords(report) : []);
  const prerequisites = $derived(report ? describePrerequisites(report) : []);

  function confirmRemove(): void {
    shell.confirm({
      title: `Remove remote "${name}"?`,
      message:
        'Links and credentials are kept. The tracker is not changed.',
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () => void connections.remove(),
    });
  }
</script>

<section class="connection" aria-label="Connection of {name}">
  {#if !connection || !provider}
    <p class="hint">{connections.loadingConnection ? 'Loading…' : 'Could not read the connection.'}</p>
  {:else}
    <h4>Where</h4>
    {#if textFields.length || switches.length}
      <div class="fields">
        {#each textFields as field (field.name)}
          <label>
            <span>{field.name}{field.required ? '' : ' (optional)'}</span>
            <input
              value={String(connections.connectionDraft[field.name] ?? '')}
              oninput={(event) => connections.setConnectionValue(field.name, event.currentTarget.value)}
              placeholder={field.example ?? ''}
              autocomplete="off"
              spellcheck="false"
            />
          </label>
        {/each}
        {#each switches as field (field.name)}
          <label class="switch">
            <input
              type="checkbox"
              checked={connections.connectionDraft[field.name] === true}
              onchange={(event) => connections.setConnectionValue(field.name, event.currentTarget.checked)}
            />
            <span>{field.name}</span>
          </label>
        {/each}
      </div>
    {/if}
    <p class="note">
      {connection.provider}{connection.scope ? ` · scope ${connection.scope}` : ' · the whole board'}
      {#if connection.linked > 0}
        · {connection.linked} linked document{connection.linked === 1 ? '' : 's'}. To change the target,
        remove and reconnect.
      {/if}
    </p>
    <div class="row">
      <span class="spacer"></span>
      <Button
        size="sm"
        disabled={!connections.connectionDirty || connections.savingConnection}
        onclick={() => void connections.saveConnection()}
      >
        {connections.savingConnection ? 'Saving…' : 'Save'}
      </Button>
    </div>

    {#if provider.credentials.length}
      <h4>Credential</h4>
      <ul class="states">
        {#each connection.credentials as state (state.key)}
          <li class:missing={state.source === undefined}>
            <strong>{state.key}</strong>
            <span>{describeCredential(state)}</span>
          </li>
        {/each}
      </ul>
      <div class="fields">
        {#each provider.credentials as field (field.key)}
          <label>
            <span>{field.key}</span>
            <input
              type={field.visible ? 'text' : 'password'}
              value={connections.credentialDraft[field.key] ?? ''}
              oninput={(event) => connections.setCredentialValue(field.key, event.currentTarget.value)}
              placeholder="leave empty to keep the stored value"
              autocomplete={field.visible ? 'off' : 'new-password'}
              spellcheck="false"
            />
          </label>
        {/each}
      </div>
      <div class="row">
        {#if provider.credentialUrl}
          <a class="link" href={provider.credentialUrl} target="_blank" rel="noreferrer">Create one ↗</a>
        {/if}
        <span class="spacer"></span>
        <Button
          size="sm"
          disabled={!connections.credentialsTyped || connections.savingCredentials}
          onclick={() => void connections.saveCredentials()}
        >
          {connections.savingCredentials ? 'Storing…' : 'Store credential'}
        </Button>
      </div>
    {/if}

    <h4>Test</h4>
    <div class="row">
      <Button
        size="sm"
        variant="primary"
        disabled={connections.inspecting || missing.length > 0}
        title={missing.length > 0
          ? `Store ${missing.map((state) => state.key).join(' and ')} first`
          : 'Check access and detect settings'}
        onclick={() => void connections.inspect(name)}
      >
        {connections.inspecting ? 'Testing…' : 'Test connection'}
      </Button>
      {#if missing.length > 0}
        <span class="note">Needs {missing.map((state) => state.key).join(' and ')} first.</span>
      {/if}
    </div>

    {#if report}
      <div class="report" aria-live="polite">
        {#if report.reachability}
          <p class={report.reachability.reachable ? 'good' : 'bad'}>
            {report.reachability.reachable ? 'Reachable' : 'Unreachable'}
            <span class="muted">{report.reachability.evidence}</span>
          </p>
        {/if}
        {#if report.stopped}
          <p class="bad">Stopped: cannot reach the tracker with this credential.</p>
        {:else}
          {#each report.found as found (found.key)}
            <p class="good">Found {found.key} {found.value} <span class="muted">— {found.label}</span></p>
          {/each}

          {#each report.choices as question (question.key)}
            <label class="ask">
              <span>Which {question.key}?</span>
              <select
                value={connections.answers.connection[question.key] ?? ''}
                onchange={(event) => connections.setAnswer('connection', question.key, event.currentTarget.value)}
              >
                <option value="">Choose…</option>
                {#each question.candidates as candidate (candidate.value)}
                  <option value={candidate.value}>{candidate.label} ({candidate.value})</option>
                {/each}
              </select>
            </label>
          {/each}

          {#each report.needed as question (question.key)}
            <p class="warn">Needed: {question.key} <span class="muted">— {question.why}</span></p>
          {/each}

          {#if report.vocabulary}
            {#each words as word (word.block + word.boardKey)}
              <label class="ask">
                <span>
                  {word.block === 'types' ? 'Type' : 'Status'} “{word.boardKey}”: “{word.claimed}” not found on
                  the tracker
                </span>
                <select
                  value={connections.answers[word.block][word.boardKey] ?? ''}
                  onchange={(event) => connections.setAnswer(word.block, word.boardKey, event.currentTarget.value)}
                >
                  <option value="">Leave it</option>
                  {#each word.candidates as candidate (candidate)}
                    <option value={candidate}>{candidate}</option>
                  {/each}
                </select>
              </label>
            {/each}
            {#if words.length === 0}
              <p class="good">All mapped types and statuses exist on the tracker.</p>
            {/if}
          {/if}

          {#each prerequisites as line (line)}
            <p class="muted">{line}</p>
          {/each}

          {#if report.written.length}
            <p class="muted">Written to .lpm/config.yml:</p>
            <ul class="written">
              {#each report.written as line (line)}
                <li><code>{line}</code></li>
              {/each}
            </ul>
          {/if}

          {#if connections.hasAnswers}
            <div class="row">
              <span class="spacer"></span>
              <Button
                size="sm"
                variant="primary"
                disabled={connections.answering}
                onclick={() => void connections.submitAnswers()}
              >
                {connections.answering ? 'Saving…' : 'Save answers'}
              </Button>
            </div>
          {:else if report.ready}
            <p class="good"><strong>Ready.</strong> Preview a push before the first sync.</p>
          {/if}
        {/if}
      </div>
    {/if}

    <h4>Remove</h4>
    <div class="row">
      <span class="note">Stop mirroring to {name}.</span>
      <span class="spacer"></span>
      <Button size="sm" variant="danger" disabled={connections.removing} onclick={confirmRemove}>
        {connections.removing ? 'Removing…' : 'Remove…'}
      </Button>
    </div>
  {/if}
</section>

<style>
  .connection {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
  }

  h4 {
    margin: var(--space-2) 0 0;
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

  .fields input:not([type='checkbox']) {
    width: 100%;
  }

  .fields .switch {
    display: flex;
    grid-column: 1 / -1;
    align-items: center;
    gap: var(--space-2);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .spacer {
    flex: 1;
  }

  .note,
  .hint,
  .muted {
    margin: 0;
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .link {
    color: var(--accent);
    font-size: var(--text-xs);
  }

  .states {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--text-xs);
  }

  .states li {
    display: flex;
    gap: var(--space-2);
  }

  .states li.missing span {
    color: var(--warn);
  }

  .report {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-size: var(--text-xs);
  }

  .report p {
    margin: 0;
  }

  .good {
    color: var(--ok, var(--accent));
  }

  .bad {
    color: var(--danger, var(--warn));
  }

  .warn {
    color: var(--warn);
  }

  .ask {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .written {
    margin: 0;
    padding-left: var(--space-4);
  }

  code {
    font-family: var(--font-mono);
    font-size: 0.9em;
  }
</style>
