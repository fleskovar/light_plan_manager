<script lang="ts">
  import type { StoreJobDto } from '$shared';
  import { jobPercent, jobText } from './maintenance.js';

  /**
   * The progress of one background job (a move, a backup or a restore): a bar
   * and one line of text. A finished job shows its result without the bar.
   */
  interface Props {
    readonly job: StoreJobDto;
  }

  let { job }: Props = $props();

  const percent = $derived(jobPercent(job));
  const text = $derived(jobText(job));
</script>

<div class="job {job.state}" role={job.state === 'failed' ? 'alert' : 'status'}>
  {#if job.state === 'running'}
    <div
      class="bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label="Progress of the {job.kind}"
    >
      <div class="fill" style:width="{percent}%"></div>
    </div>
  {/if}
  <span class="text">{text}</span>
  {#if job.state !== 'running' && job.notes.length}
    <ul>
      {#each job.notes as note (note)}
        <li>{note}</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .job {
    display: grid;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--ink-muted);
  }

  .job.failed {
    color: var(--danger);
  }

  .job.done .text {
    color: var(--tone-done);
  }

  .bar {
    height: 0.4rem;
    border-radius: var(--radius-sm);
    background: var(--surface-3);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: var(--accent);
    transition: width var(--duration-fast);
  }

  .text {
    overflow-wrap: anywhere;
  }

  ul {
    margin: 0;
    padding-left: var(--space-4);
  }
</style>
