/**
 * Edits to `.lpm/config.yml`, and the board templates that a new board starts
 * from, as they travel between the web app and the server.
 *
 * A `ConfigEdit` names one change to the vocabulary of the board: a type, a
 * status or an attribute. `editBoardConfig` in `core/operations/config-edit.ts`
 * applies a list of edits. It rewrites `.lpm/config.yml` and every document
 * that holds a renamed or removed name.
 *
 * Like the rest of this folder, this module imports only types.
 */

import type { AttributeType } from './model.js';

/**
 * The four collections whose types `.lpm/config.yml` declares. The template
 * registry is absent: it uses the issue types.
 */
export type ConfigNamespace = 'issue' | 'period' | 'resource' | 'squad';

export const CONFIG_NAMESPACES: readonly ConfigNamespace[] = [
  'issue',
  'period',
  'resource',
  'squad',
];

/** The definition of an attribute that `add-attribute` writes. */
export interface NewAttribute {
  type: AttributeType;
  description?: string;
  /** The allowed values. Required for the type `enum`, refused for every other type. */
  values?: string[];
}

export type ConfigEdit =
  /**
   * Declare a type. With `placement: 'join'`, the type shares the existing
   * level `level`. With `placement: 'insert'`, the type gets a new level at the
   * index `level`, and each level from that index moves one level down.
   */
  | {
      op: 'add-type';
      kind: ConfigNamespace;
      name: string;
      label: string;
      level: number;
      placement: 'join' | 'insert';
    }
  /** Change the label of a type, its name, or both. A new name rewrites every document of the type. */
  | { op: 'update-type'; kind: ConfigNamespace; type: string; name?: string; label?: string }
  /** Remove a type that no document uses. */
  | { op: 'remove-type'; kind: ConfigNamespace; type: string }
  /** Add a status at the position `index`, or after the last status when `index` is absent. */
  | { op: 'add-status'; id: string; label: string; index?: number }
  /** Change the label of a status, its id, or both. A new id rewrites every issue in the status. */
  | { op: 'update-status'; status: string; id?: string; label?: string }
  /** Remove a status that no issue holds. */
  | { op: 'remove-status'; status: string }
  | {
      op: 'add-attribute';
      kind: ConfigNamespace;
      type: string;
      name: string;
      attribute: NewAttribute;
    }
  /**
   * Change the name, the description or the allowed values of an attribute of
   * one type. A new name moves the value in every document of the type.
   */
  | {
      op: 'update-attribute';
      kind: ConfigNamespace;
      type: string;
      attribute: string;
      name?: string;
      description?: string;
      values?: string[];
    }
  /** Remove an attribute from one type, and its value from every document of the type. */
  | { op: 'remove-attribute'; kind: ConfigNamespace; type: string; attribute: string };

/** The body of `POST /api/config/edits`. */
export interface ConfigEditRequest {
  edits: ConfigEdit[];
}

/** What `editBoardConfig` did. */
export interface ConfigEditResultDto {
  /** The number of documents that the edits rewrote. */
  rewritten: number;
  /** Each issue type that got a new name, old name to new name. */
  renamedTypes: Record<string, string>;
  /** Each file outside the documents that the edits also changed, and each reference that the edits did not follow. */
  notes: string[];
}

/** One board template that `lpm init --template` accepts by name. */
export interface BoardTemplateDto {
  name: string;
  /** `builtin` ships with light-plan. `user` is a file in the user folder. */
  source: 'builtin' | 'user';
}

/** The answer of `GET /api/board-templates`. */
export interface BoardTemplatesDto {
  templates: BoardTemplateDto[];
  /** The template that `lpm init` uses when no `--template` is given. */
  default: string;
  /** The folder that holds the user templates and `settings.json`. */
  folder: string;
}

/** The body of `POST /api/board-templates`. */
export interface SaveBoardTemplateRequest {
  name: string;
  /** Replace a user template of the same name. */
  overwrite?: boolean;
}

const IDENT_RE = /^[a-z][a-z0-9_]*$/;

/**
 * True for a name that `.lpm/config.yml` accepts as a type name, a status id or
 * an attribute name: lower-case letters, digits and `_`, starting with a letter.
 *
 * `core/config/schema.ts` holds the same pattern. The two must agree.
 */
export function isConfigName(value: string): boolean {
  return IDENT_RE.test(value);
}

/** The config name that a label suggests: `User Story` gives `user_story`. */
export function configNameFrom(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[_0-9]+|_+$/g, '');
}
