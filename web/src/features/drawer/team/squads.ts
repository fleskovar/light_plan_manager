import type { NodeDto, SquadDto } from '$shared';
import type { WorkingNodes } from '$lib/board/working.js';

export interface SquadEntry {
  squad: SquadDto;
  /** Resource titles for each member id. */
  members: { id: string; title: string }[];
}

/** Squads from the board, with resolved member names. */
export function buildSquads(nodes: WorkingNodes): SquadEntry[] {
  const squads: SquadEntry[] = [];
  for (const node of Object.values(nodes)) {
    if (node.kind !== 'squad') continue;
    const squad = node as SquadDto;
    squads.push({
      squad,
      members: squad.members.map((id) => ({
        id,
        title: nodes[id]?.title ?? id,
      })),
    });
  }
  return squads.sort((a, b) => a.squad.title.localeCompare(b.squad.title));
}

/** Resource ids that are not already in the squad, for the "add member" picker. */
export function availableForSquad(
  nodes: WorkingNodes,
  squad: SquadDto,
): { id: string; title: string }[] {
  const members = new Set(squad.members);
  const result: { id: string; title: string }[] = [];
  for (const node of Object.values(nodes)) {
    if (node.kind === 'resource' && !members.has(node.id)) {
      result.push({ id: node.id, title: node.title });
    }
  }
  return result.sort((a, b) => a.title.localeCompare(b.title));
}
