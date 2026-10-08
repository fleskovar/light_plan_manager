import type { IssueDto, NodeDto, ResourceDto } from '$shared';
import type { Shell } from '$lib/app/shell.svelte.js';
import { childTypes } from '$lib/board/links.js';
import { ancestorsOf, orderedTree } from '$lib/board/selectors.js';
import type { MenuEntry, MenuItem } from '$lib/ui/menu/types.js';
import {
  addUpstream,
  assignSelection,
  countOf,
  createNode,
  duplicate,
  editNode,
  insertOnEdge,
  removeDependency,
  removeNodes,
  scheduleSelection,
  scheduleUpstream,
  setStatus,
} from '$lib/workspace/mutations.js';
import type { Workspace } from '$lib/workspace/workspace.svelte.js';
import type { RemoteState } from '$features/drawer/remote/remote.svelte.js';

/** The registry's container type. @see src/core/model/types.ts */
const TEMPLATE_FOLDER = 'folder';

/**
 * The canvas context menus.
 *
 * Builders, not components: each returns a plain description of what the menu
 * offers, so the options can be reasoned about (and tested) without a DOM, and
 * so the same entries can be reused by a toolbar or a shortcut later.
 */
export interface MenuContext {
  workspace: Workspace;
  shell: Shell;
  /**
   * The remote state machine, when a remote is declared and its report has
   * been read. Optional because the menus are built in two places and neither
   * should have to care: with no remote there is nothing to push to, and the
   * entry is simply absent rather than present and disabled.
   */
  remote?: RemoteState;
  /** Where the click happened, in canvas coordinates, for placing new nodes. */
  at?: { x: number; y: number };
  onarrange?: () => void;
}

/**
 * Types this document could become. A type deeper in the hierarchy would need a
 * parent nobody has chosen, so only same-level and higher conversions are
 * offered; dropping a node onto another is how you demote one.
 */
export function conversionOptions(
  workspace: Workspace,
  node: NodeDto,
): { type: string; label: string; parentId: string | null }[] {
  const config = workspace.config;
  const ancestors = ancestorsOf(workspace.nodes, node.id);
  const options: { type: string; label: string; parentId: string | null }[] = [];

  for (const [depth, names] of config.hierarchy[node.kind].entries()) {
    if (depth > node.depth) continue;
    // Level 0 goes to the root; anything else keeps the ancestor at depth - 1.
    const parentId = depth === 0 ? null : (ancestors[node.depth - depth]?.id ?? null);
    if (depth > 0 && !parentId) continue;
    const parent = parentId ? workspace.node(parentId) : null;
    for (const type of names) {
      if (type === node.type) continue;
      // Mirroring the one registry rule the hierarchy cannot express: a folder
      // groups templates and never sits inside one. The board refuses this on
      // push either way; offering it would queue an edit that cannot land.
      // @see placementProblem in src/core/board/registry.ts
      if (type === TEMPLATE_FOLDER && parent && parent.type !== TEMPLATE_FOLDER) continue;
      options.push({ type, label: config.types[type]?.label ?? type, parentId });
    }
  }
  return options;
}

// -- editing many issues at once -------------------------------------------
//
// Everything down to `paneMenu` acts on whatever is selected rather than on one
// node, which is what makes the same three submenus useful from a node, from a
// table row and from the bare canvas. The rule they share: the *selection*
// decides what is edited, and right-clicking never quietly changes it — a menu
// only replaces the selection when the click lands outside it.
//
// A tick means every selected issue is already there, so a submenu answers
// "what are these set to?" as well as offering to change it.

function issuesIn(workspace: Workspace, ids: string[]): IssueDto[] {
  return ids
    .map((id) => workspace.node(id))
    .filter((node): node is IssueDto => node?.kind === 'issue');
}

const byTitle = (a: NodeDto, b: NodeDto): number => a.title.localeCompare(b.title);

/** One level of indent inside a menu label. An em space survives HTML; ' ' does not. */
const INDENT = ' ';

function tickIf(all: boolean): string | undefined {
  return all ? '✓' : undefined;
}

/**
 * Who work can go to: everyone on the roster, people first and the generic
 * pools after them, plus the way back to nobody. A pool wears its type, because
 * "Backend" as a person and "Backend" as a queue are different promises.
 */
function assignEntry(context: MenuContext, ids: string[]): MenuEntry {
  const { workspace } = context;
  const issues = issuesIn(workspace, ids);
  const roster = Object.values(workspace.nodes).filter(
    (node): node is ResourceDto => node.kind === 'resource',
  );
  const people = roster.filter((one) => !one.generic).sort(byTitle);
  const pools = roster.filter((one) => one.generic).sort(byTitle);

  const holds = (assignee: string | null): boolean =>
    issues.length > 0 && issues.every((issue) => issue.assignee === assignee);

  const item = (resource: ResourceDto): MenuItem => ({
    label: resource.title,
    hint:
      tickIf(holds(resource.id)) ??
      (resource.generic ? (workspace.config.types[resource.type]?.label ?? 'Pool') : undefined),
    onSelect: () => assignSelection(workspace, ids, resource.id),
  });

  const items: MenuEntry[] = [...people.map(item)];
  if (people.length && pools.length) items.push({ separator: true });
  items.push(...pools.map(item));
  if (items.length) {
    items.push(
      { separator: true },
      {
        label: 'Nobody',
        hint: tickIf(holds(null)),
        onSelect: () => assignSelection(workspace, ids, null),
      },
    );
  }

  return {
    label: 'Assign to',
    disabled: !issues.length || !roster.length,
    items,
  };
}

function statusEntry(context: MenuContext, ids: string[]): MenuEntry {
  const { workspace } = context;
  const issues = issuesIn(workspace, ids);
  return {
    label: 'Change status',
    disabled: !issues.length,
    items: workspace.config.statuses.map((status) => ({
      label: status.label,
      hint: tickIf(issues.length > 0 && issues.every((issue) => issue.status === status.id)),
      onSelect: () => setStatus(workspace, ids, status.id),
    })),
  };
}

/**
 * Scheduling from the menu is the keyboard-and-pointer twin of carrying an
 * issue into a period box, so it means the same thing: the *work* under what is
 * selected moves, not the container standing over it.
 */
function scheduleEntry(context: MenuContext, ids: string[]): MenuEntry {
  const { workspace } = context;
  const issues = issuesIn(workspace, ids);
  const periods = orderedTree(workspace.nodes, 'period');

  return {
    label: 'Schedule into',
    disabled: !issues.length || !periods.length,
    items: [
      ...periods.map((period) => ({
        // Nesting is the whole shape of a timeline: a sprint listed flat beside
        // its increment is a list of names nobody can pick from. The indent is
        // an em space, because HTML collapses the ordinary kind away.
        label: `${INDENT.repeat(period.depth)}${period.title}`,
        onSelect: () => scheduleSelection(workspace, ids, period.id),
      })),
      { separator: true },
      { label: 'Backlog', onSelect: () => scheduleSelection(workspace, ids, null) },
    ],
  };
}

/**
 * The edits that read a selection: what these issues are, who has them, and
 * when they happen. The caller decides whether to head them with a count —
 * a bulk edit must never happen silently, but a menu on a single node saying
 * "1 item selected" is noise.
 */
export function bulkEntries(context: MenuContext, ids: string[]): MenuEntry[] {
  // Status, assignee and period are properties of a piece of work. A template
  // is the shape of one and has none of them, so a registry view offers none
  // rather than three permanently greyed-out submenus.
  if (context.workspace.mode === 'templates') return [];
  const entries: MenuEntry[] = [statusEntry(context, ids), assignEntry(context, ids)];
  if (context.workspace.config.hasPeriods) entries.push(scheduleEntry(context, ids));
  return entries;
}

/**
 * Mirroring a selection: push it, or pull it back.
 *
 * The selection travels as `only`, so a push acts on **exactly** the documents
 * that were selected — never on the subtrees under them. Right-clicking a
 * feature and choosing Push files that feature, and a reader who wanted its
 * stories too selects them. The alternative (expanding to the subtree) is the
 * kind of quiet extra work nobody asked for, and the side panel offers it
 * explicitly for the one document it is showing.
 */
export function remoteEntries(context: MenuContext, ids: string[]): MenuEntry[] {
  const remote = context.remote;
  // Tracker remotes are experimental (`lpm ui --experimental`); without the
  // flag a published build names no tracker anywhere, menus included.
  if (!remote?.enabled) return [];
  // No remote declared, or its report has not been read: nothing to mirror to.
  if (remote.badgeRemote === null) return [];
  // A template is the shape of work, not work: it has no twin anywhere.
  if (context.workspace.mode === 'templates') return [];

  const many = ids.length > 1;
  const linked = ids.filter((id) => remote.documentRemote(id)?.link != null);
  /**
   * What the mirror is missing around this selection: the work inside it, the
   * containers above it, the period it was filed without, the far end of a
   * dependency. Deduplicated, because two selected stories in one feature are
   * missing the same epic.
   */
  const gaps = [...new Set(ids.flatMap((id) => remote.gapsFor(id).map((gap) => gap.id)))];
  const blocked = remote.syncing || remote.syncBlocked;

  return [
    {
      label: many ? `Push ${countOf(ids.length, 'item')}` : 'Push',
      disabled: blocked || ids.length === 0,
      onSelect: () => void remote.pushDocuments(ids),
    },
    // Offered only when there is something to offer: a greyed "push 0 missing"
    // on every menu of a healthy mirror is noise, and the point of this entry
    // is that it appears exactly when the tracker's copy of the plan is
    // incomplete around what was clicked.
    ...(gaps.length > 0
      ? [
          {
            label: `Push ${countOf(gaps.length, 'missing document')}`,
            hint: 'related',
            disabled: blocked,
            onSelect: () => void remote.pushDocuments(gaps),
          },
        ]
      : []),
    {
      label: many ? `Pull ${countOf(linked.length, 'item')}` : 'Pull',
      // Pulling something with no twin is not a smaller pull, it is nothing.
      disabled: blocked || linked.length === 0,
      // Until the report arrives no twin is known, so say why Pull is grey
      // rather than let it read as "none of these are mirrored".
      ...(remote.reportPending ? { hint: 'loading…' } : {}),
      onSelect: () => void remote.pullDocuments(linked),
    },
  ];
}

/** "4 items selected", for the menus that are about to act on all of them. */
export function selectionHeading(ids: string[]): MenuEntry {
  return { heading: `${countOf(ids.length, 'item')} selected` };
}

/** Taking a selection off the canvas, and off the board. Both count out loud. */
export function removalEntries(context: MenuContext, ids: string[]): MenuEntry[] {
  const { workspace, shell } = context;
  const many = ids.length > 1;

  return [
    {
      label: many ? `Remove ${countOf(ids.length, 'item')} from view` : 'Remove from view',
      disabled: !ids.length,
      onSelect: () => workspace.removeMembers(ids),
    },
    {
      label: many ? `Delete ${countOf(ids.length, 'item')}` : 'Delete',
      hint: 'Del',
      danger: true,
      disabled: !ids.length,
      onSelect: () =>
        shell.confirm({
          title: 'Delete from the board?',
          message: many
            ? `${ids.length} documents and their children will be deleted on push.`
            : `${ids[0]} and its children will be deleted on push.`,
          confirmLabel: 'Delete',
          danger: true,
          onConfirm: () => removeNodes(workspace, ids),
        }),
    },
  ];
}

function newChildEntries(context: MenuContext, node: NodeDto): MenuEntry[] {
  const { workspace } = context;
  return childTypes(workspace.config, node.kind, node.depth).map((type) => ({
    label: workspace.config.types[type]?.label ?? type,
    onSelect: () => {
      const id = createNode(workspace, { type, parentId: node.id });
      workspace.selection.focus(id);
    },
  }));
}

/**
 * The two things you can do with the work behind an issue: see all of it, and
 * hand all of it out.
 *
 * "Everything required to close this" is a question the canvas is the natural
 * place to ask, because the answer is a shape rather than a list. Both entries
 * are thin callers of `$shared` — `upstreamWork` for the drawing and
 * `planScheduleUpstream` for the edit — so the picture and `lpm upstream` agree.
 *
 * Templates have dependencies but no sprint and no assignee: a shape of work is
 * not scheduled, so the registry gets neither entry rather than two dead ones.
 */
function upstreamEntries(context: MenuContext, node: NodeDto): MenuEntry[] {
  const { workspace } = context;
  if (node.kind !== 'issue' || workspace.mode === 'templates') return [];

  // Scheduling copies this issue's own period and assignee onto the work behind
  // it, so an issue carrying neither has nothing to copy. Say so in the menu
  // rather than opening it and reporting an error.
  const nothingToCopy = node.period === null && node.assignee === null;

  return [
    {
      label: 'Add upstream dependencies',
      hint: 'Everything it waits on',
      onSelect: () => addUpstream(workspace, node.id),
    },
    {
      label: 'Schedule upstream dependencies',
      hint: nothingToCopy ? 'Needs a sprint or an assignee' : 'Same sprint and assignee',
      disabled: nothingToCopy,
      onSelect: () => scheduleUpstream(workspace, node.id),
    },
  ];
}

export function nodeMenu(context: MenuContext, id: string): MenuEntry[] {
  const { workspace, shell } = context;
  const node = workspace.node(id);
  if (!node) return [];

  const selected = workspace.selection.has(id) ? workspace.selection.ids : [id];
  const children = newChildEntries(context, node);
  const conversions = conversionOptions(workspace, node);
  // Upstream is about the one issue that was right-clicked, never the whole
  // selection: "everything behind these six" is a different question nobody
  // asked, and answering it would schedule six chains at once.
  const upstream = upstreamEntries(context, node);

  return [
    // Right-clicking one of several selected nodes edits all of them, so the
    // menu says how many before it offers anything.
    ...(selected.length > 1 ? [selectionHeading(selected)] : []),
    {
      label: 'Add new…',
      items: children,
      disabled: !children.length,
    },
    {
      label: 'Convert to',
      disabled: !conversions.length,
      items: conversions.map((option) => ({
        label: option.label,
        onSelect: () =>
          editNode(workspace, id, { type: option.type, parentId: option.parentId }),
      })),
    },
    ...bulkEntries(context, selected),
    ...(() => {
      const remote = remoteEntries(context, selected);
      return remote.length > 0 ? [{ separator: true } as MenuEntry, ...remote] : [];
    })(),
    { separator: true },
    {
      label: 'Break down…',
      disabled: node.kind !== 'issue',
      onSelect: () => shell.openBreakdown(id),
    },
    // A group of its own: these two read the dependency graph rather than
    // acting on this document, so they do not belong beside Duplicate.
    ...(upstream.length ? [{ separator: true } as MenuEntry, ...upstream, { separator: true } as MenuEntry] : []),
    {
      label: 'Duplicate',
      hint: 'Ctrl+D',
      onSelect: () => workspace.selection.set(duplicate(workspace, selected)),
    },
    { separator: true },
    ...removalEntries(context, selected),
  ];
}

export function edgeMenu(
  context: MenuContext,
  edge: { from: string; to: string; aggregated: boolean },
): MenuEntry[] {
  const { workspace } = context;
  const source = workspace.node(edge.from);
  const siblings = source
    ? (workspace.config.hierarchy[source.kind][source.depth] ?? [])
    : [];

  return [
    {
      label: 'New…',
      // Splicing creates an issue between two others; the registry has no
      // equivalent, because a template's edges are a shape, not a schedule.
      disabled: !source || edge.aggregated || workspace.mode === 'templates',
      items: siblings.map((type) => ({
        label: workspace.config.types[type]?.label ?? type,
        onSelect: () => {
          const id = insertOnEdge(workspace, edge.from, edge.to, type);
          if (id) workspace.selection.focus(id);
        },
      })),
    },
    { separator: true },
    {
      label: 'Delete dependency',
      danger: true,
      disabled: edge.aggregated,
      onSelect: () => removeDependency(workspace, edge.to, edge.from),
    },
  ];
}

/**
 * The menu on the bare canvas — and, when something is selected, the place bulk
 * editing is actually reachable from.
 *
 * Shift-clicking a dozen nodes and then hunting for one of them to right-click
 * is the long way round to "give these to Ana": a right-click on the background
 * keeps the selection (only a left-click clears it), so this is where the whole
 * selection is addressed.
 */
export function paneMenu(context: MenuContext): MenuEntry[] {
  const { workspace, shell } = context;
  // In a registry view the same canvas creates templates, so the types on
  // offer come from the registry's hierarchy — the issue levels, plus a folder
  // at every one of them. @see templateHierarchy
  const rootTypes = workspace.config.hierarchy[workspace.nodeKind][0] ?? [];
  const selected = workspace.selection.ids;

  const onSelection: MenuEntry[] = selected.length
    ? [
        selectionHeading(selected),
        ...bulkEntries(context, selected),
        { separator: true },
        ...removalEntries(context, selected),
        { separator: true },
      ]
    : [];

  return [
    ...onSelection,
    {
      label: 'New',
      items: rootTypes.map((type) => ({
        label: workspace.config.types[type]?.label ?? type,
        onSelect: () => {
          const id = createNode(workspace, { type, parentId: null });
          if (context.at) workspace.setLayout(id, context.at);
          workspace.selection.focus(id);
        },
      })),
    },
    {
      label: 'Paste',
      hint: 'Ctrl+V',
      disabled: !workspace.clipboard.length,
      onSelect: () => workspace.selection.set(duplicate(workspace, workspace.clipboard)),
    },
    { separator: true },
    { label: 'Arrange', hint: 'Ctrl+L', onSelect: () => context.onarrange?.() },
  ];
}
