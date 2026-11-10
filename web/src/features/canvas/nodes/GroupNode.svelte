<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import type { CanvasNodeData } from '../model.js';
  import { useCanvasEditing } from '../editing.js';
  import { useCanvasGraph } from '../graph.svelte.js';
  import { useGraphSource } from '../source.js';
  import NodeShell from './NodeShell.svelte';
  import { resizeHandlers } from './NodeShell.svelte.js';

  /**
   * An expanded subflow. Its children are separate canvas nodes positioned in
   * its coordinate space, so this component draws only the frame — the body is
   * left empty on purpose, and the children render on top of it.
   */
  let { data, selected }: NodeProps & { data: CanvasNodeData } = $props();

  const source = useGraphSource();
  const resize = resizeHandlers(useCanvasGraph(), source);
  // Absent in the read-only viewer, which has no edit mode.
  const editing = useCanvasEditing();
  const id = $derived(data.node.id);
</script>

<NodeShell
  {data}
  selected={selected ?? false}
  ontoggle={(id) => source.toggleCollapsed(id)}
  {resize}
  renaming={editing?.renaming === id}
  onrename={(title) => editing?.finishRename(id, title)}
  onenter={editing?.enabled && editing.canEnter(id) ? () => editing.enter(id) : undefined}
/>
