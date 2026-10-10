<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import { defaultBranch, effectiveBranch, gitDraftProblem, nameList, useGitState } from './git.svelte.js';

  /**
   * Share the board through git: this project's repository on a branch of its
   * own, or a repository of the board's own on any host. **Check** asks git
   * whether it can reach it with the credentials it already has; **Share**
   * pushes the board and turns syncing on for everybody.
   *
   * On a board that mirrors onto a tracker, Share first opens a warning in
   * place of the form: sharing through git turns the mirror off, for everybody,
   * and that is asked rather than done. **Back** returns to the form as it was.
   *
   * Presentational; every decision is in `git.svelte.ts`.
   */
  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  const git = useGitState();
  const draft = $derived(git.draft);
  const status = $derived(git.status);
  const problem = $derived(draft ? gitDraftProblem(draft, status) : null);
  const branch = $derived(draft ? effectiveBranch(draft, status) : '');
  const suggested = $derived(draft ? defaultBranch(draft.where, status) : '');
  const check = $derived(git.check);

  async function submit(turnOffRemotes = false): Promise<void> {
    if (await git.submitSetup(turnOffRemotes)) onclose();
  }

  const turnOff = $derived(git.turnOffQuestion);
  const names = $derived(turnOff ? nameList(turnOff) : '');
</script>

{#if draft && status && turnOff}
  <!-- Rendered instead of the form, never on top of it, so the two never
       stack and Escape closes only what is in front. -->
  <Modal
    title={`Turn off ${names}?`}
    size="sm"
    onclose={() => git.cancelTurnOff()}
  >
    <div class="warning">
      <p>
        This board mirrors onto <strong>{names}</strong>. Enabling git sync turns off tracker remotes
        for everyone.
      </p>
      <p class="muted">Settings and links are kept. To switch back, turn off git sync.</p>
    </div>

    {#snippet footer()}
      <Button onclick={() => git.cancelTurnOff()} disabled={git.busy !== null}>Back</Button>
      <Button variant="primary" disabled={git.busy !== null} onclick={() => void submit(true)}>
        {git.busy === 'sharing' ? 'Sharing…' : `Turn off ${names} and share`}
      </Button>
    {/snippet}
  </Modal>
{:else if draft && status}
  <Modal title="Share this board through git" {onclose}>
    <form
      class="setup"
      autocomplete="off"
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset>
        <legend>Repository</legend>
        {#if status.project}
          <label class="choice">
            <input
              type="radio"
              name="where"
              checked={draft.where === 'project'}
              onchange={() => git.chooseWhere('project')}
            />
            <span>
              <strong>This project's repository</strong>
              <span class="detail">
                {status.project.url}, branch <code>{status.projectBranch}</code>
              </span>
            </span>
          </label>
        {/if}
        <label class="choice">
          <input
            type="radio"
            name="where"
            checked={draft.where === 'url'}
            onchange={() => git.chooseWhere('url')}
          />
          <span>
            <strong>Separate repository</strong>
            <span class="detail">Must be empty</span>
          </span>
        </label>
      </fieldset>

      <div class="fields">
        {#if draft.where === 'url'}
          <label>
            <span>URL</span>
            <input
              value={draft.url}
              oninput={(event) => {
                draft.url = event.currentTarget.value;
                git.check = null;
              }}
              placeholder="https://github.com/acme/board.git"
              spellcheck="false"
            />
          </label>
        {/if}
        <label>
          <span>Branch</span>
          <input
            value={draft.branch}
            oninput={(event) => {
              draft.branch = event.currentTarget.value;
              git.check = null;
            }}
            placeholder={suggested}
            spellcheck="false"
          />
        </label>
        <!-- The field opens with the suggested branch in it. The line below
             says what an empty field does, so the reader does not have to
             guess whether the grey text is a value. -->
        <p class="hint">
          {#if draft.branch.trim() === ''}
            An empty field uses the branch <code>{suggested}</code>.
          {:else if draft.branch.trim() === suggested}
            light-plan suggests this branch. You can type another name.
          {:else}
            The suggested branch is <code>{suggested}</code>.
          {/if}
        </p>
      </div>

      {#if draft.where === 'url' && !check}
        <details class="hosts">
          <summary>URL examples</summary>
          <dl>
            {#each status.hosts as host (host.id)}
              <dt>{host.label}</dt>
              <dd>
                {#each host.examples as example (example)}<code>{example}</code> {/each}
              </dd>
            {/each}
          </dl>
        </details>
      {/if}

      {#if check}
        <div class="check" class:ok={check.reachable} class:bad={!check.reachable}>
          {#if check.reachable}
            <p>
              <strong>Reachable</strong> — {check.host.label}.
              {check.branchExists
                ? `Branch ${branch} exists.`
                : `Branch ${branch} will be created.`}
            </p>
          {:else}
            <p><strong>Unreachable</strong> — {check.error}</p>
            <p class="note">{check.host.credentials}</p>
            <p class="note">Does it exist? {check.host.create}</p>
            <p class="note">
              Uses your git credentials. Test with <code>git ls-remote {check.url}</code>.
            </p>
          {/if}
        </div>
      {/if}

      {#if problem}
        <p class="problem">{problem}</p>
      {/if}
    </form>

    {#snippet footer()}
      <Button onclick={onclose}>Cancel</Button>
      <Button onclick={() => void git.checkDraft()} disabled={!!problem || git.busy !== null}>
        {git.busy === 'checking' ? 'Checking…' : 'Check'}
      </Button>
      <Button variant="primary" disabled={!!problem || git.busy !== null} onclick={() => void submit()}>
        {git.busy === 'sharing' ? 'Sharing…' : 'Share'}
      </Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .warning {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    font-size: var(--text-sm);
  }

  .warning p {
    margin: 0;
    line-height: 1.55;
  }

  .warning .muted {
    color: var(--ink-muted);
  }

  .setup {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    font-size: var(--text-sm);
  }

  fieldset {
    margin: 0;
    padding: 0;
    border: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  legend {
    margin-bottom: var(--space-2);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }

  .choice {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    cursor: pointer;
  }

  .choice > span {
    display: flex;
    flex-direction: column;
  }

  .detail {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
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

  .hint {
    grid-column: 2;
    margin: calc(var(--space-1) * -1) 0 0;
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  .fields input {
    width: 100%;
  }

  .note {
    margin: 0;
    color: var(--ink-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .hosts summary {
    cursor: pointer;
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .hosts dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-1) var(--space-3);
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
  }

  .hosts dt {
    color: var(--ink-muted);
  }

  .hosts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .check {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .check p {
    margin: 0;
  }

  .check.ok {
    border-color: var(--tone-done);
  }

  .check.bad {
    border-color: var(--danger);
  }

  .problem {
    margin: 0;
    color: var(--danger, var(--warn));
    font-size: var(--text-xs);
  }

  code {
    font-family: var(--font-mono);
    font-size: 0.9em;
    overflow-wrap: anywhere;
  }
</style>
