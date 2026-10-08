<script lang="ts">
  /**
   * The glyph for a document type.
   *
   * A board declares its own types, so there is no fixed list to draw. Instead
   * a type is mapped to one of a handful of shapes by name, and anything
   * unrecognised falls back to a shape chosen by its depth — deep types get
   * simpler glyphs, which reads as "smaller unit of work" without needing to
   * know what the board calls them.
   */
  interface Props {
    type: string;
    depth?: number;
    size?: number;
  }

  let { type, depth = 0, size = 16 }: Props = $props();

  const BY_NAME: Record<string, string> = {
    program: 'target',
    portfolio: 'target',
    initiative: 'target',
    epic: 'flag',
    theme: 'flag',
    feature: 'layers',
    capability: 'layers',
    story: 'note',
    user_story: 'note',
    task: 'check',
    sub_task: 'check',
    bug: 'bug',
    defect: 'bug',
    test: 'beaker',
    increment: 'calendar',
    sprint: 'calendar',
    iteration: 'calendar',
    release: 'calendar',
    person: 'person',
    role: 'people',
    team: 'people',
    squad: 'people',
  };

  const BY_DEPTH = ['target', 'flag', 'layers', 'note', 'check'];

  const shape = $derived(BY_NAME[type] ?? BY_DEPTH[Math.min(depth, BY_DEPTH.length - 1)]!);
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if shape === 'target'}
    <circle cx="8" cy="8" r="6" />
    <circle cx="8" cy="8" r="2.2" />
  {:else if shape === 'flag'}
    <path d="M4 14V3h8l-1.6 2.6L12 8.2H4" />
  {:else if shape === 'layers'}
    <path d="M8 2.5 14 6l-6 3.5L2 6z" />
    <path d="m3.5 9 4.5 2.6L12.5 9" />
  {:else if shape === 'note'}
    <rect x="3" y="2.5" width="10" height="11" rx="1.6" />
    <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" />
  {:else if shape === 'check'}
    <rect x="2.5" y="2.5" width="11" height="11" rx="2.4" />
    <path d="m5.5 8.2 1.9 1.9 3.4-3.7" />
  {:else if shape === 'bug'}
    <rect x="5" y="5" width="6" height="8" rx="3" />
    <path d="M5 8H2.5M11 8h2.5M5.5 5.2 4 3.4M10.5 5.2 12 3.4M5 11H2.8M11 11h2.2" />
  {:else if shape === 'beaker'}
    <path d="M6.2 2.5v4L3 12.4A1.2 1.2 0 0 0 4.1 14h7.8a1.2 1.2 0 0 0 1.1-1.6L9.8 6.5v-4" />
    <path d="M5.5 2.5h5M4.8 10.4h6.4" />
  {:else if shape === 'calendar'}
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.6" />
    <path d="M2.5 6.6h11M5.5 2v2.6M10.5 2v2.6" />
  {:else if shape === 'person'}
    <circle cx="8" cy="5.4" r="2.6" />
    <path d="M3.2 13.5a4.8 4.8 0 0 1 9.6 0" />
  {:else}
    <circle cx="6" cy="5.2" r="2.2" />
    <circle cx="11.2" cy="6" r="1.7" />
    <path d="M2.2 13a4 4 0 0 1 7.6 0M11 9.4a3.4 3.4 0 0 1 2.8 3.6" />
  {/if}
</svg>
