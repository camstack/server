/**
 * nodeId → palette slot for assignment pills, NodePicker and other cluster surfaces.
 * Reads persisted `color` from listAgentSettings; falls back to assignNodeColorId.
 */
import { NodeColorIdSchema, assignNodeColorId, type NodeColorId } from '@camstack/types'

export interface AgentSettingsColorRow {
  readonly nodeId: string
  readonly settings: object
}

function readSettingsColor(settings: object): unknown {
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'color') return value
  }
  return undefined
}

export function buildColorByNodeId(
  rows: readonly AgentSettingsColorRow[] | undefined,
): ReadonlyMap<string, NodeColorId> {
  const map = new Map<string, NodeColorId>()
  for (const row of rows ?? []) {
    const parsed = NodeColorIdSchema.safeParse(readSettingsColor(row.settings))
    map.set(row.nodeId, parsed.success ? parsed.data : assignNodeColorId(row.nodeId))
  }
  return map
}

export function colorIdForNode(
  colorByNodeId: ReadonlyMap<string, NodeColorId>,
  nodeId: string,
): NodeColorId {
  return colorByNodeId.get(nodeId) ?? assignNodeColorId(nodeId)
}
