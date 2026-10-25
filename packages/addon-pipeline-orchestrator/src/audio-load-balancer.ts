/**
 * Simple two-level audio balancer.
 * L1: manual pin (audioNodeId device setting != 'auto')
 * L2: least-loaded node by device count
 */

export interface AudioNodeLoad {
  readonly nodeId: string
  /** Number of devices currently assigned to this node. */
  readonly deviceCount: number
}

export interface AudioBalancerInput {
  readonly nodes: readonly AudioNodeLoad[]
  /** Preferred node from device store setting. null = use balancer. */
  readonly preferredNode: string | null
}

export type AudioBalancerReason = 'manual' | 'capacity'

export interface AudioBalancerDecision {
  readonly nodeId: string
  readonly reason: AudioBalancerReason
}

export function balanceAudio(input: AudioBalancerInput): AudioBalancerDecision | null {
  if (input.nodes.length === 0) return null

  // L1: honour manual pin if that node is available
  if (input.preferredNode) {
    const pinned = input.nodes.find((n) => n.nodeId === input.preferredNode)
    if (pinned) return { nodeId: pinned.nodeId, reason: 'manual' }
  }

  // L2: pick the node with the fewest assigned devices
  const best = input.nodes.slice().toSorted((a, b) => a.deviceCount - b.deviceCount)[0]!
  return { nodeId: best.nodeId, reason: 'capacity' }
}
