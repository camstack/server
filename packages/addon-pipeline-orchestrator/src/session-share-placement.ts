/**
 * The NODE tier of share placement (D748): turns the balancer's inputs into
 * share candidates and elects one. Used by the session dispatcher only when
 * the cluster policy is `share` and the camera carries no node pin (a pin is
 * L1 and still decided by `balance()`).
 *
 *  - share   = the node's `detectWeight` (absent = 1, as `balance()` reads it);
 *  - running = the node's PARALLEL sessions now: on-motion sessions and
 *    standing always-on cameras, each camera counted once;
 *  - capped  = at its explicit `maxCameras` (counted on attachments, exactly
 *    as `balance()` counts it, so the two tiers never disagree on a cap);
 *  - saturated = every device the node reports is at its pool's shed cap.
 *
 * A capacity derived from the measured latency table is NOT an input: it is
 * advisory in the Load balancing tab and must not become a de-facto cap.
 */
import type { RunnerLocalLoad, ShareAffinityElection, ShareElection } from '@camstack/types'
import { electByShareWithAffinity } from '@camstack/types'
import { isDeviceSaturated } from './device-balancer.js'
import type { ShareElectionHistory } from './share-election-history.js'

export interface NodeShareInput {
  /** Online nodes' loads (the same census `balance()` gets). */
  readonly loads: readonly RunnerLocalLoad[]
  /** Nodes that may run this camera (frame-sourceable ∧ inference-usable). */
  readonly eligible: readonly string[]
  readonly weights: Readonly<Record<string, number>>
  readonly caps: Readonly<Record<string, number | null>>
  /** nodeId → parallel sessions running there now. */
  readonly runningByNode: ReadonlyMap<string, number>
  /** Recent elections, so non-overlapping sessions still follow the weights. */
  readonly history?: ShareElectionHistory
  /**
   * The node this camera's previous session ran on (D916), kept while it is
   * within one session of the turn holder. Absent/null = a plain election.
   */
  readonly previousNodeId?: string | null
}

/** The history scope of the node tier (device tiers are scoped by node id). */
export const NODE_TIER_HISTORY_SCOPE = 'nodes'

function nodeSaturated(load: RunnerLocalLoad): boolean {
  return load.devices.length > 0 && load.devices.every((d) => isDeviceSaturated(d))
}

export function electNodeByShare(input: NodeShareInput): ShareElection {
  return electNodeByShareWithAffinity({ ...input, previousNodeId: null }).election
}

/** The node election with the camera's affinity, and what it saw (for the election line). */
export function electNodeByShareWithAffinity(input: NodeShareInput): ShareAffinityElection {
  const candidates = input.loads
    .filter((l) => l.nodeId.length > 0 && input.eligible.includes(l.nodeId))
    .map((load) => {
      const cap = input.caps[load.nodeId]
      const hasCap = cap !== null && cap !== undefined && cap > 0
      const weight = input.weights[load.nodeId]
      return {
        key: load.nodeId,
        share: weight !== undefined && weight > 0 ? weight : 1,
        running: input.runningByNode.get(load.nodeId) ?? 0,
        ...(input.history !== undefined
          ? { recent: input.history.recent(NODE_TIER_HISTORY_SCOPE, load.nodeId) }
          : {}),
        capped: hasCap && load.attachedCameras >= cap,
        saturated: nodeSaturated(load),
        ...(hasCap ? { spare: Math.max(0, cap - load.attachedCameras) } : {}),
      }
    })
  const outcome = electByShareWithAffinity(candidates, input.previousNodeId ?? null)
  if (outcome.election.kind === 'elected') {
    input.history?.noteElected(NODE_TIER_HISTORY_SCOPE, outcome.election.key)
  }
  return outcome
}

/** Parallel sessions per node: sessions and standing cameras, each camera once. */
export function countRunningByNode(
  placements: readonly { readonly deviceId: number; readonly nodeId: string }[],
): ReadonlyMap<string, number> {
  const seen = new Map<number, string>()
  for (const p of placements) if (!seen.has(p.deviceId)) seen.set(p.deviceId, p.nodeId)
  const out = new Map<string, number>()
  for (const nodeId of seen.values()) out.set(nodeId, (out.get(nodeId) ?? 0) + 1)
  return out
}
