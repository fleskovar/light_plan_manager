import type { LibraryEntryDto } from '$shared';

/**
 * The folder tree of the board library, as the Library page draws it.
 *
 * The server sends two flat lists: every folder (`prompts`, `prompts/review`)
 * and every document (`prompts/review/strict`). This module nests them. The
 * functions are pure, so `web/test/library.test.ts` checks them without a
 * browser.
 */
export interface FolderNode {
  kind: 'folder';
  /** The full path below `.lpm/library`, for example `prompts/review`. */
  path: string;
  /** The last part of the path, for example `review`. */
  name: string;
  depth: number;
  folders: FolderNode[];
  documents: DocumentNode[];
  /** The number of documents in this folder and in each folder below it. */
  count: number;
}

export interface DocumentNode {
  kind: 'document';
  entry: LibraryEntryDto;
  /** The last part of the id. */
  name: string;
  depth: number;
}

/** A row of the tree: what can be selected, dragged or dropped onto. */
export type LibraryItem = { kind: 'folder'; path: string } | { kind: 'document'; path: string };

/** The folder part of a path: `prompts` for `prompts/review`, an empty text for `notes`. */
export function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/** The last part of a path. */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The path `name` gets inside `folder`. The empty folder is the library folder itself. */
export function join(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

/** True when `path` is `folder` or lies below it. */
export function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** The path of `item` after a drop onto `folder`, or null when the drop changes nothing or is not allowed. */
export function dropTarget(item: LibraryItem, folder: string): string | null {
  if (parentOf(item.path) === folder) return null;
  // A folder cannot go into itself or into a folder below it.
  if (item.kind === 'folder' && within(folder, item.path)) return null;
  return join(folder, nameOf(item.path));
}

/** Every folder above `path`, outermost first: `a`, `a/b` for `a/b/c`. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, at) => parts.slice(0, at + 1).join('/'));
}

/**
 * The root of the tree: the folders and the documents at the top of the
 * library. Folders come before documents, and each list is sorted by name.
 */
export function buildLibraryTree(folders: readonly string[], entries: readonly LibraryEntryDto[]): FolderNode {
  const root: FolderNode = { kind: 'folder', path: '', name: '', depth: -1, folders: [], documents: [], count: 0 };
  const byPath = new Map<string, FolderNode>([['', root]]);

  const folderFor = (path: string): FolderNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const parent = folderFor(parentOf(path));
    const node: FolderNode = {
      kind: 'folder',
      path,
      name: nameOf(path),
      depth: parent.depth + 1,
      folders: [],
      documents: [],
      count: 0,
    };
    parent.folders.push(node);
    byPath.set(path, node);
    return node;
  };

  for (const folder of folders) folderFor(folder);
  for (const entry of entries) {
    const parent = folderFor(parentOf(entry.id));
    parent.documents.push({ kind: 'document', entry, name: nameOf(entry.id), depth: parent.depth + 1 });
    for (let node: FolderNode | undefined = parent; node; node = node.path ? byPath.get(parentOf(node.path)) : undefined) {
      node.count += 1;
    }
  }

  const sort = (node: FolderNode): void => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.documents.sort((a, b) => a.name.localeCompare(b.name));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** One visible row of the tree, in the order the page draws them. */
export type TreeRow = FolderNode | DocumentNode;

/**
 * The rows that the page shows: each folder, and below an expanded folder its
 * folders and documents. With a search, the rows are the documents that match
 * and the folders above them, and every folder is open.
 */
export function visibleRows(
  root: FolderNode,
  expanded: ReadonlySet<string>,
  matches: ((entry: LibraryEntryDto) => boolean) | null,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const holdsMatch = (node: FolderNode): boolean =>
    node.documents.some((doc) => matches!(doc.entry)) || node.folders.some(holdsMatch);
  const walk = (node: FolderNode): void => {
    for (const folder of node.folders) {
      if (matches && !holdsMatch(folder)) continue;
      rows.push(folder);
      if (matches || expanded.has(folder.path)) walk(folder);
    }
    for (const doc of node.documents) {
      if (!matches || matches(doc.entry)) rows.push(doc);
    }
  };
  walk(root);
  return rows;
}
