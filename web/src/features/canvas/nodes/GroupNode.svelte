<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import type { CanvasNodeData } from '../model.js';
  import { useGraphSource } from '../source.js';
  import NodeShell from './NodeShell.svelte';

  /**
   * An expanded subflow. Its children are separate canvas nodes positioned in
   * its coordinate space, so this component draws only the frame — the body is
   * left empty on purpose, and the children render on top of it.
   */
  let { data, selected }: NodeProps & { data: CanvasNodeData } = $props();

  const source = useGraphSource();
</script>

<NodeShell
  {data}
  selected={selected ?? false}
  ontoggle={(id) => source.toggleCollapsed(id)}
  onresize={(id, size) => source.setLayout(id, size)}
/>
