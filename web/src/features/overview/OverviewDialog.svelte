<script lang="ts">
  import type { BoardSnapshot } from '$shared';
  import { plansWithPeriods } from '$shared';
  import Modal from '$lib/ui/Modal.svelte';
  import Digest from './Digest.svelte';

  /**
   * The board overview: the counts of the board, then the three readings that
   * `Digest` draws. View ▸ Board overview opens it.
   *
   * `Digest` places its three sections into the grid areas `now`, `added` and
   * `paths`. The grid below defines those areas, so the names are the contract
   * between the two files.
   */
  interface Props {
    /** The board as the server last sent it. Unpushed edits are not in it. */
    board: BoardSnapshot;
    /** The number of views on the board. */
    views: number;
    onclose: () => void;
  }

  let { board, views, onclose }: Props = $props();
</script>

<Modal title="Overview of {board.config.boardName}" size="lg" {onclose}>
  <div class="overview">
    <dl class="stats">
      <div>
        <dt>Issues</dt>
        <dd>{board.issues.length}</dd>
      </div>
      {#if plansWithPeriods(board.config)}
        <div>
          <dt>Periods</dt>
          <dd>{board.periods.length}</dd>
        </div>
      {:else if board.config.hasPeriods}
        <div title="Every period is ignored: the board is one continuous queue (lpm planning)">
          <dt>Planning</dt>
          <dd>Queue</dd>
        </div>
      {/if}
      {#if board.config.hasResources}
        <div>
          <dt>Roster</dt>
          <dd>{board.resources.length}</dd>
        </div>
      {/if}
      <div>
        <dt>Templates</dt>
        <dd>{board.templates.filter((template) => template.root).length}</dd>
      </div>
      <div>
        <dt>Views</dt>
        <dd>{views}</dd>
      </div>
    </dl>

    <div class="mosaic">
      <Digest {board} />
    </div>
  </div>
</Modal>

<style>
  /*
   * The rest of the app is a working surface with small type. A reader reads
   * the overview and does not operate it, so the overview raises the type
   * scale. `Digest` and the shared chips take their sizes from these custom
   * properties.
   */
  .overview {
    --text-xs: 0.8125rem;
    --text-sm: 0.9375rem;
    --text-md: 1.0625rem;
    --text-lg: 1.25rem;

    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
    margin: 0;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-lg);
    background: linear-gradient(140deg, var(--accent-soft), var(--surface-1) 65%);
  }

  .stats div {
    display: flex;
    flex-direction: column-reverse;
  }

  .stats dt {
    color: var(--ink-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .stats dd {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  /*
   * One column in a narrow window, two columns in a wide one. Every width names
   * all three areas: a section whose area name matches no cell does not fall
   * back to automatic placement, and the sections then overlap in one cell.
   */
  .mosaic {
    display: grid;
    gap: var(--space-4);
    align-items: start;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'now'
      'added'
      'paths';
  }

  @media (min-width: 50rem) {
    .mosaic {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-template-areas:
        'now   now'
        'added paths';
    }
  }
</style>
