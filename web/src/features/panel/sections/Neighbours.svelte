<script lang="ts">
  import type { ConfigDto } from '$shared';
  import type { WorkingNodes } from '$lib/board/working.js';
  import LinkSection from './LinkSection.svelte';

  /**
   * The immediate dependencies, in both directions. One hop only: this is for
   * walking the graph a step at a time, and the canvas is there for the rest.
   *
   * The last two lists are the reflection of the dependencies further down:
   * a story waiting on a story in another feature puts those two features in
   * order, and this is where a reader of the feature finds that out. They are
   * shown only when there are any, and they carry no unlink button — nothing
   * is written on these documents to break.
   */
  interface Props {
    nodes: WorkingNodes;
    config: ConfigDto;
    upstream: string[];
    downstream: string[];
    /** Containers this one stands behind because of the work inside them. */
    rolledUpUpstream?: string[];
    /** Containers standing behind this one for the same reason. */
    rolledUpDownstream?: string[];
    onopen: (id: string) => void;
    onunlink: (id: string, direction: 'upstream' | 'downstream') => void;
  }

  let {
    nodes,
    config,
    upstream,
    downstream,
    rolledUpUpstream = [],
    rolledUpDownstream = [],
    onopen,
    onunlink,
  }: Props = $props();
</script>

<LinkSection
  {nodes}
  {config}
  {onopen}
  heading="Blocked by"
  ids={upstream}
  empty="Nothing blocks this."
  unlinkLabel="Remove dependency"
  onunlink={(id) => onunlink(id, 'upstream')}
/>

<LinkSection
  {nodes}
  {config}
  {onopen}
  heading="Blocks"
  ids={downstream}
  empty="Nothing waits on this."
  unlinkLabel="Remove dependency"
  onunlink={(id) => onunlink(id, 'downstream')}
/>

{#if rolledUpUpstream.length}
  <LinkSection
    {nodes}
    {config}
    {onopen}
    heading="Waits on, from the work inside"
    ids={rolledUpUpstream}
    empty=""
  />
{/if}

{#if rolledUpDownstream.length}
  <LinkSection
    {nodes}
    {config}
    {onopen}
    heading="Waited on, from the work inside"
    ids={rolledUpDownstream}
    empty=""
  />
{/if}
