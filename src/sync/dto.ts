import path from 'node:path';
import type {
  AttributeDef,
  BoardConfig,
  Issue,
  LoadedBoard,
  QueueSimulation,
  NodeKind,
  Period,
  Resource,
  Squad,
  Template,
  TypeDef,
} from '../core/index.js';
import {
  depthOfType,
  hasPeriods,
  planningOf,
  hasResources,
  hasSquads,
  hierarchyFor,
  isActiveStatus,
  isAtomicType,
  isGenericType,
  isTemplateRoot,
  typesFor,
} from '../core/index.js';
import type {
  AttributeDto,
  BoardSnapshot,
  ConfigDto,
  IssueDto,
  QueueSequenceDto,
  NodeDtoBase,
  PeriodDto,
  ResourceDto,
  SquadDto,
  StatusDto,
  TemplateDto,
  TypeDto,
} from '../shared/index.js';
import { NODE_KINDS } from '../shared/index.js';

/**
 * Core model -> wire DTO.
 *
 * The only place that knows both shapes. Its job is to drop the filesystem
 * (`dir`, `file`) and to flatten the answers the client would otherwise need
 * config lookups for — a type's depth, whether a status counts as active,
 * whether a resource is a pool.
 */

function toAttributes(def: TypeDef): AttributeDto[] {
  return Object.entries(def.attributes).map(([name, attribute]: [string, AttributeDef]) => ({
    name,
    type: attribute.type,
    description: attribute.description,
    required: attribute.required,
    default: attribute.default,
    values: attribute.values,
  }));
}

/**
 * Every declared type, keyed by name across all namespaces.
 *
 * The registry deliberately reuses the *issue* types by name — a template of a
 * feature is drawn, labelled and given attributes exactly as a feature is — so
 * `template` is walked last and a name already claimed is left as it was. What
 * it contributes is the one type only it has: `folder`.
 */
function toTypes(config: BoardConfig): Record<string, TypeDto> {
  const types: Record<string, TypeDto> = {};
  for (const kind of NODE_KINDS) {
    for (const [name, def] of Object.entries(typesFor(config, kind as NodeKind))) {
      if (types[name]) continue;
      types[name] = {
        name,
        kind: kind as NodeKind,
        label: def.label,
        depth: depthOfType(config, kind as NodeKind, name),
        attributes: toAttributes(def),
        generic: kind === 'resource' && isGenericType(config, name),
        atomic: kind === 'issue' && isAtomicType(config, name),
      };
    }
  }
  return types;
}

function toStatuses(config: BoardConfig): StatusDto[] {
  return config.statuses.map((status) => ({
    id: status.id,
    label: status.label,
    terminal: status.terminal === true,
    active: isActiveStatus(config, status.id),
  }));
}

export function toConfig(board: LoadedBoard): ConfigDto {
  const { config } = board;
  return {
    boardName: path.basename(board.paths.root),
    statuses: toStatuses(config),
    defaultStatus: config.default_status,
    types: toTypes(config),
    hierarchy: {
      issue: hierarchyFor(config, 'issue'),
      period: hierarchyFor(config, 'period'),
      resource: hierarchyFor(config, 'resource'),
      squad: hierarchyFor(config, 'squad'),
      template: hierarchyFor(config, 'template'),
    },
    hasPeriods: hasPeriods(config),
    hasResources: hasResources(config),
    hasSquads: hasSquads(config),
    priorityAttribute: config.priority_attribute,
    effortAttribute: config.effort_attribute,
    planning: planningOf(config),
  };
}

function toBase(node: Issue | Period | Resource | Squad | Template): NodeDtoBase {
  return {
    kind: node.kind,
    id: node.id,
    type: node.type,
    title: node.title,
    body: node.body,
    parentId: node.parentId,
    depth: node.depth,
    attributes: node.attributes,
    created: node.created,
    updated: node.updated,
    author: node.author,
  };
}

export function toIssue(issue: Issue): IssueDto {
  return {
    ...toBase(issue),
    kind: 'issue',
    status: issue.status,
    assignee: issue.assignee,
    period: issue.period,
    flag: issue.flag,
    dependsOn: issue.depends_on,
    relatesTo: issue.relates_to,
    relatedFiles: issue.related_files,
  };
}

export function toPeriod(period: Period): PeriodDto {
  return {
    ...toBase(period),
    kind: 'period',
    starts: period.starts,
    ends: period.ends,
    active: period.active,
    squad: period.squad,
  };
}

export function toResource(board: LoadedBoard, resource: Resource): ResourceDto {
  return {
    ...toBase(resource),
    kind: 'resource',
    capacity: resource.capacity,
    covers: resource.covers,
    generic: isGenericType(board.config, resource.type),
  };
}

export function toSquad(squad: Squad): SquadDto {
  return {
    ...toBase(squad),
    kind: 'squad',
    members: squad.members,
  };
}

export function toTemplate(board: LoadedBoard, template: Template): TemplateDto {
  return {
    ...toBase(template),
    kind: 'template',
    description: template.description,
    params: template.params,
    // Denormalized so a front end never has to walk the registry to find out
    // whether something is offerable. @see src/core/board/registry.ts
    root: isTemplateRoot(board, template),
    dependsOn: template.depends_on,
    relatesTo: template.relates_to,
    relatedFiles: template.related_files,
  };
}

export function toSnapshot(board: LoadedBoard): BoardSnapshot {
  return {
    config: toConfig(board),
    issues: board.issues.map(toIssue),
    periods: board.periods.map(toPeriod),
    resources: board.resources.map((resource) => toResource(board, resource)),
    squads: board.squads.map(toSquad),
    templates: board.templates.map((template) => toTemplate(board, template)),
    problems: board.problems.map((problem) => ({
      level: problem.level,
      path: problem.path,
      message: problem.message,
    })),
    readAt: new Date().toISOString(),
  };
}

/**
 * A queue simulation as the queue panel reads it: ids in the engine's order,
 * and why the rest were never reached. Ids only — the browser already holds
 * every document, and its working copy is what it draws.
 */
export function toQueueSequence(board: LoadedBoard, run: QueueSimulation): QueueSequenceDto {
  return {
    resource: run.resource?.id ?? null,
    planning: planningOf(board.config),
    steps: run.steps.map((step) => ({
      id: step.issue.id,
      order: step.order,
      started: step.started,
    })),
    skipped: run.skipped.map((skip) => ({
      id: skip.issue.id,
      reason: skip.reason,
      blockedBy: skip.blockedBy.map((issue) => issue.id),
    })),
  };
}
