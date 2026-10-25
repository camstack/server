/**
 * Binds the node benchmark service (D791) to the orchestrator's real
 * controllers: the placement ledger and topology for the camera facts, a
 * SCOPED rebalance for the drain and the restore, the shares for headroom,
 * and the target node's runner through `nodePin` — whichever runner the
 * operator's request first reached, the measurement runs on the node chosen.
 */
import {
  type AddonContext,
  type BenchmarkCameraFacts,
  errMsg,
  type NodeBenchRunnerInputRaw,
  type NodeBenchRunnerStatus,
  nodePin,
  type SuggestSharesResult,
} from '@camstack/types'
import type { NodeTopologyService } from '../node-topology.js'
import type { PlacementLedger } from '../placement-ledger.js'
import type { RebalanceOptions, RebalanceResult } from '../placement-service.js'
import type { NodeBenchmarkPersistence } from './node-benchmark-store.js'
import { NodeBenchmarkService, type NodeBenchRunnerClient } from './node-benchmark-service.js'

export interface NodeBenchmarkWiringDeps {
  readonly ctx: () => AddonContext
  readonly persistence: NodeBenchmarkPersistence
  readonly ledger: PlacementLedger
  readonly topology: NodeTopologyService
  readonly rebalance: (opts: RebalanceOptions) => Promise<RebalanceResult>
  /** The node a camera's on-motion session runs on now, if any. */
  readonly activeSessionNode: (deviceId: number) => string | null
  /** The camera's STORED node pin, as written — not the benchmark view of it. */
  readonly readStoredPipelinePin: (deviceId: number) => Promise<string | null>
  readonly listDeviceKeys: (nodeId: string) => Promise<readonly string[]>
  readonly sessionsNow: () => number
  readonly suggestShares: () => Promise<SuggestSharesResult>
  readonly onResultsWritten: (nodeId: string) => void
  /** Runner poll cadence (tests shorten it). */
  readonly pollIntervalMs?: number
}

export function makeRunnerClient(ctx: () => AddonContext): NodeBenchRunnerClient {
  return {
    start: async (nodeId: string, input: NodeBenchRunnerInputRaw) => {
      await ctx().api.pipelineRunner.startNodeBench.mutate(input, nodePin(nodeId))
    },
    status: async (nodeId: string, runId: string): Promise<NodeBenchRunnerStatus | null> =>
      ctx().api.pipelineRunner.getNodeBenchStatus.query({ runId }, nodePin(nodeId)),
    abort: async (nodeId: string, runId: string) => {
      await ctx().api.pipelineRunner.abortNodeBench.mutate({ runId }, nodePin(nodeId))
    },
  }
}

/** Every camera the orchestrator places, as the preflight reads it (benchmark ignored). */
export async function collectCameraFacts(
  deps: Pick<
    NodeBenchmarkWiringDeps,
    'ledger' | 'topology' | 'activeSessionNode' | 'readStoredPipelinePin'
  >,
): Promise<readonly BenchmarkCameraFacts[]> {
  const out: BenchmarkCameraFacts[] = []
  for (const deviceId of deps.ledger.listConfigIds()) {
    out.push({
      deviceId,
      placedNodeId:
        deps.ledger.getAssignment(deviceId)?.agentNodeId ?? deps.activeSessionNode(deviceId),
      nodePin: await deps.readStoredPipelinePin(deviceId),
      frameSourceNodes: deps.topology.detectionEligibleNodesIgnoringBenchmark(deviceId),
    })
  }
  return out
}

export function createNodeBenchmarkService(deps: NodeBenchmarkWiringDeps): NodeBenchmarkService {
  const logger = deps.ctx().logger
  return new NodeBenchmarkService({
    logger,
    persistence: deps.persistence,
    runner: makeRunnerClient(deps.ctx),
    isNodeOnline: (nodeId) => deps.topology.collectRunnerNodeIds().includes(nodeId),
    listDeviceKeys: deps.listDeviceKeys,
    cameraFacts: () => collectCameraFacts(deps),
    headroom: async (nodeId) => {
      let other: number | null = null
      try {
        const shares = await deps.suggestShares()
        other = shares.nodes
          .filter((n) => n.nodeId !== nodeId && n.skippedReason === null)
          .reduce((sum, n) => sum + n.capacitySessions, 0)
      } catch (err) {
        logger.debug('node benchmark: capacity read failed — headroom unknown', {
          meta: { error: errMsg(err) },
        })
      }
      return { sessionsNow: deps.sessionsNow(), otherNodesCapacitySessions: other }
    },
    drain: async (deviceIds) => {
      const result = await deps.rebalance({ minImprovement: 0, onlyDeviceIds: deviceIds })
      logger.info('node benchmark: drain pass', {
        meta: { migrated: result.migrated, skipped: result.skipped.length },
      })
    },
    camerasOnNode: async (nodeId) =>
      deps.ledger
        .listAssignments()
        .filter((a) => a.agentNodeId === nodeId)
        .map((a) => a.deviceId)
        .concat(
          deps.ledger
            .listConfigIds()
            .filter(
              (id) =>
                deps.ledger.getAssignment(id) === null && deps.activeSessionNode(id) === nodeId,
            ),
        ),
    restorePins: async (deviceIds) => {
      const result = await deps.rebalance({ minImprovement: 0, onlyDeviceIds: deviceIds })
      logger.info('node benchmark: cameras re-placed after the run', {
        meta: { migrated: result.migrated, skipped: result.skipped.length },
      })
    },
    onResultsWritten: deps.onResultsWritten,
    ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
  })
}
