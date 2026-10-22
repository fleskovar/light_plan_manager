<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import type { CanvasNodeData } from '../model.js';
  import { useCanvasEditing } from '../editing.js';
  import { useGraphSource } from '../source.js';
  import NodeShell from './NodeShell.svelte';

  /**
   * An expanded subflow. Its children are separate canvas nodes positioned in
   * its coordinate space, so this component draws only the frame — the body is
   * left empty on purpose, and the children render on top of it.
   */
  let { data, selected }: NodeProps & { data: CanvasNodeData } = $props();

  const source = useGraphSource();
  // Absent in the read-only viewer, which has no edit mode.
  const editing = useCanvasEditing();
  const id = $derived(data.node.id);
</script>

<NodeShell
  {data}
  selected={selected ?? false}
  ontoggle={(id) => source.toggleCollapsed(id)}
  onresize={(id, size) => source.setLayout(id, size)}
  renaming={editing?.renaming === id}
  onrename={(title) => editing?.finishRename(id, title)}
  onenter={editing?.enabled && editing.canEnter(id) ? () => editing.enter(id) : undefined}
/>
