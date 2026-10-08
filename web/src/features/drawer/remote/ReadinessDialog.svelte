<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import { summarizeReadiness } from '$shared';
  import { useRemoteState } from './remote.svelte.js';

  /**
   * What this push is about to get wrong, and what to do about it.
   *
   * Shown before anything is written, because the alternative is finding out
   * from the issues themselves: forty stories filed unassigned because an
   * account id went stale, or unscheduled because nobody filed the sprint.
   *
   * Every row offers the same two answers — leave it blank, or fix it — and
   * Cancel is the third, at the bottom, because it is about the push rather
   * than about any one finding. Presentational: what each answer *does* lives
   * in the state machine.
   */
  const remote = useRemoteState();
  const report = $derived(remote.readiness);
</script>

{#if report !== null}
  <Modal title="Push check" size="lg" onclose={() => remote.dismissReadiness()}>
    <p class="lede">{summarizeReadiness(report)}</p>
    {#if report.unreachable}
      <p class="warn">
        Tracker unreachable: {report.unreachable}. Showing board checks only.
      </p>
    {/if}

    <ul class="findings">
      {#each report.findings as finding (finding.key)}
        {@const choice = remote.choiceFor(finding.key)}
        <li class="finding" class:blocks={finding.severity === 'blocks'}>
          <div class="head">
            <span class="title">{finding.title}</span>
            <span class="count">
              {finding.count}
              {finding.count === 1 ? 'document' : 'documents'}
            </span>
          </div>
          <p class="detail">{finding.detail}</p>
          <p class="docs">{finding.documents.join(', ')}{finding.count > finding.documents.length
              ? ` +${finding.count - finding.documents.length} more`
              : ''}</p>

          <div class="choices">
            <label class:chosen={choice === 'ignore'}>
              <input
                type="radio"
                name={finding.key}
                checked={choice === 'ignore'}
                disabled={finding.severity === 'blocks'}
                onchange={() => remote.chooseReadiness(finding.key, 'ignore')}
              />
              <span>
                <strong>Leave it</strong>
                <span class="effect">{finding.ignored}</span>
              </span>
            </label>

            {#if finding.fix}
              <label class:chosen={choice === 'fix'}>
                <input
                  type="radio"
                  name={finding.key}
                  checked={choice === 'fix'}
                  onchange={() => remote.chooseReadiness(finding.key, 'fix')}
                />
                <span>
                  {#if finding.fix.kind === 'link_account'}
                    <strong>Use this account</strong>
                    {#if finding.fix.candidates.length > 0}
                      <select
                        value={remote.readinessCandidate[finding.key] ?? ''}
                        onchange={(event) =>
                          remote.chooseCandidate(finding.key, event.currentTarget.value)}
                      >
                        {#each finding.fix.candidates as candidate (candidate.value)}
                          <option value={candidate.value}>
                            {candidate.label}{candidate.exact ? '' : ' (name matches)'}
                          </option>
                        {/each}
                      </select>
                      <span class="effect">
                        Saves it to <code>{finding.fix.via}</code> on {finding.fix.resourceTitle}.
                      </span>
                    {:else}
                      <span class="effect">
                        No account matches {finding.fix.resourceTitle}. Set <code>{finding.fix.via}</code>
                        on the roster document manually.
                      </span>
                    {/if}
                  {:else if finding.fix.kind === 'file_period'}
                    <strong>File {finding.fix.periodTitle} too</strong>
                    <span class="effect">
                      Creates the period in this push.
                    </span>
                  {:else}
                    <strong>Clear the assignee</strong>
                    <span class="effect">
                      Removes the assignee from these issues.
                    </span>
                  {/if}
                </span>
              </label>
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    {#snippet footer()}
      {#if remote.readinessBlocked}
        <span class="blocked-note">
          Fix blocking problems to push.
        </span>
      {/if}
      <span class="spacer"></span>
      <Button onclick={() => remote.dismissReadiness()}>Cancel</Button>
      <Button
        variant="primary"
        disabled={remote.readinessBlocked || remote.syncing}
        onclick={() => void remote.proceedReadiness()}
      >
        Push
      </Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .lede {
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
  }

  .warn {
    margin: 0 0 var(--space-2);
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .findings {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .finding {
    border-left: 2px solid var(--border);
    padding-left: var(--space-2);
  }

  .finding.blocks {
    border-left-color: var(--danger);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .title {
    font-weight: 600;
    font-size: var(--text-sm);
  }

  .count,
  .detail,
  .docs,
  .effect {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }

  .detail,
  .docs {
    margin: var(--space-1) 0 0;
  }

  .docs {
    font-variant-numeric: tabular-nums;
    color: var(--ink-faint);
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-top: var(--space-2);
  }

  .choices label {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    cursor: pointer;
  }

  .choices label > span {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .choices label.chosen strong {
    color: var(--accent);
  }

  strong {
    font-size: var(--text-sm);
    font-weight: 600;
  }

  select {
    max-width: 100%;
    font: inherit;
  }

  .blocked-note {
    color: var(--danger);
    font-size: var(--text-xs);
  }

  .spacer {
    flex: 1;
  }
</style>
