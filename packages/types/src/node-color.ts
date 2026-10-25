import { z } from 'zod'

/** Fixed cluster node palette ids (maps to `--color-node-*` theme tokens). */
export const NODE_COLOR_IDS = [
  'node-a',
  'node-b',
  'node-c',
  'node-d',
  'node-e',
  'node-f',
  'node-g',
  'node-h',
] as const

export const NodeColorIdSchema = z.enum(NODE_COLOR_IDS)

export type NodeColorId = z.infer<typeof NodeColorIdSchema>

/** Stable FNV-1a hash → one palette slot (same nodeId always gets the same colour). */
function hashNodeId(nodeId: string): number {
  let h = 2166136261
  for (let i = 0; i < nodeId.length; i++) {
    h ^= nodeId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function assignNodeColorId(nodeId: string): NodeColorId {
  const slot = hashNodeId(nodeId) % NODE_COLOR_IDS.length
  const id = NODE_COLOR_IDS[slot]
  if (id !== undefined) return id
  return 'node-a'
}
