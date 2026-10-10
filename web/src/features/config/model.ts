import type {
  AttributeDto,
  ConfigDto,
  ConfigEdit,
  ConfigNamespace,
  NodeDto,
  StatusDto,
} from '$shared';
import { CONFIG_NAMESPACES, isConfigName } from '$shared';

/**
 * What the board configuration dialog shows, worked out from the snapshot.
 *
 * Every function here is pure: it reads a `ConfigDto` and the documents of the
 * board, and returns the rows that a component draws. The counts say how many
 * documents an edit rewrites, and which edits the server refuses.
 */

export interface TypeRow {
  kind: ConfigNamespace;
  name: string;
  label: string;
  attributes: AttributeDto[];
  /** True for an issue type that the queue offers whole. */
  atomic: boolean;
  /** True for a resource type that describes a pool. */
  generic: boolean;
  /** The number of documents of this type. */
  documents: number;
}

export interface LevelRow {
  /** The depth of the level, which is its index in the hierarchy. */
  index: number;
  types: TypeRow[];
  /** The number of documents at this depth or deeper. A new level here is refused when it is not 0. */
  documentsFrom: number;
}

export interface NamespaceRow {
  kind: ConfigNamespace;
  title: string;
  levels: LevelRow[];
}

const TITLES: Record<ConfigNamespace, string> = {
  issue: 'Issue types',
  period: 'Period types',
  resource: 'Team types',
  squad: 'Squad types',
};

/**
 * The documents that carry the types of a namespace. A registry template
 * carries an issue type, so it counts as a document of the issue namespace.
 * `documentsOf` in `core/operations/config-edit.ts` holds the same rule.
 */
export function documentsOf(nodes: NodeDto[], kind: ConfigNamespace): NodeDto[] {
  return nodes.filter((node) => node.kind === kind || (kind === 'issue' && node.kind === 'template'));
}

/** Each namespace that the board declares, with its levels and its types. */
export function namespacesOf(config: ConfigDto, nodes: NodeDto[]): NamespaceRow[] {
  return CONFIG_NAMESPACES.filter((kind) => config.hierarchy[kind].length > 0).map((kind) => {
    const documents = documentsOf(nodes, kind);
    return {
      kind,
      title: TITLES[kind],
      levels: config.hierarchy[kind].map((names, index) => ({
        index,
        documentsFrom: documents.filter((node) => node.depth >= index).length,
        types: names.map((name) => {
          const type = config.types[name];
          return {
            kind,
            name,
            label: type?.label ?? name,
            attributes: type?.attributes ?? [],
            atomic: type?.atomic === true,
            generic: type?.generic === true,
            documents: documents.filter((node) => node.type === name).length,
          };
        }),
      })),
    };
  });
}

export interface StatusRow extends StatusDto {
  /** The number of issues in this status. */
  issues: number;
  /** True for the status that a new issue gets. */
  isDefault: boolean;
}

export function statusRows(config: ConfigDto, nodes: NodeDto[]): StatusRow[] {
  return config.statuses.map((status) => ({
    ...status,
    issues: nodes.filter((node) => node.kind === 'issue' && node.status === status.id).length,
    isDefault: status.id === config.defaultStatus,
  }));
}

/** The number of documents of `type` that hold a value for `attribute`. */
export function attributeHolders(
  nodes: NodeDto[],
  kind: ConfigNamespace,
  type: string,
  attribute: string,
): number {
  return documentsOf(nodes, kind).filter((node) => node.type === type && attribute in node.attributes)
    .length;
}

/** The other types of the namespace that declare an attribute of the same name. */
export function typesSharing(
  config: ConfigDto,
  kind: ConfigNamespace,
  type: string,
  attribute: string,
): string[] {
  return config.hierarchy[kind]
    .flat()
    .filter(
      (name) =>
        name !== type && config.types[name]?.attributes.some((entry) => entry.name === attribute),
    );
}

/**
 * Why `value` cannot be a new type name, status id or attribute name, or null
 * when it can. The server checks the same rules again.
 */
export function nameProblem(value: string, taken: string[], what: string): string | null {
  if (!value) return `Enter a ${what}.`;
  if (!isConfigName(value)) {
    return `Use lower-case letters, digits and "_", starting with a letter.`;
  }
  if (taken.includes(value)) return `The ${what} "${value}" is in use.`;
  return null;
}

/** The values of an enum, from the text of a field that separates them with commas. */
export function parseValues(text: string): string[] {
  return [...new Set(text.split(',').map((value) => value.trim()).filter(Boolean))];
}

/**
 * The edits that rename an attribute, change its description or change its
 * values, on one type or on every type of `types`. Each type gets one edit, and
 * the server applies the list in one call.
 */
export function attributeEdits(
  kind: ConfigNamespace,
  types: string[],
  attribute: string,
  change: { name?: string; description?: string; values?: string[] },
): ConfigEdit[] {
  return types.map((type) => ({ op: 'update-attribute', kind, type, attribute, ...change }));
}

/** `3 documents`, `1 document`. */
export function count(total: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? '' : 's'}`;
}
