/**
 * T2 — Frame-source-aware placement at the orchestrator level.
 *
 * The balancer alone (see `load-balancer.spec.ts`) enforces `eligibleNodes`;
 * this suite proves the ORCHESTRATOR feeds it the right set at every
 * placement path. Since the decode-flag removal, decode is co-located with
 * detection by construction (detect ⇒ decode): every detect-enabled node can
 * obtain a camera's frames (it owns the pull, or it dials the owner's
 * restream and decodes locally), so:
 *
 * Scenario A (the cam-104 case, INVERTED by design): with
 * `detect = ['hub','agent']`, a camera dispatched to the hub MIGRATES to the
 * agent when the hub fails over — the agent decodes locally via the
 * remote-restream leg. The old trap (detect-enabled node silently ineligible
 * because its decode flag was off) no longer exists.
 *
 * Scenario B: `assignPipeline` to a NON-detect-enabled node is rejected up
 * front with a descriptive error, never persisting a dead pin.
 *
 * Harness note: the live trigger is a critical-cap `down` event
 * (`watchCapability` → `handleNodeDisconnect`). The fake harness has no
 * readiness-registry plumbing, so we drive the equivalent node-disconnect via
 * the broker's `removeNode` (which fires `AgentOffline` → `handleNodeDisconnect`
 * on the same code path the balancer sees). Both funnel through the identical
 * failover `balance()` call.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { computeFrameSourceNodes } from '../frame-source-eligibility.js'
import PipelineOrchestratorAddon from '../index.js'
import type { PendingReason } from '../placement-ledger.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeRunnerCameraConfig,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'

/**
 * Test subclass exposing the protected `pendingReasons` seam so the spec can
 * assert WHY a camera was left unassigned (consumed for real by T3).
 */
class TestOrchestrator extends PipelineOrchestratorAddon {
  peekPendingReason(deviceId: number): PendingReason | undefined {
    return this.ledger?.getPendingReason(deviceId)
  }
}

describe('PipelineOrchestratorAddon — frame-source eligibility (T2)', () => {
  let addon: TestOrchestrator

  afterEach(async () => {
    if (addon) await addon.shutdown()
  })

  it('cap-down failover migrates the camera to the other detect-enabled node (detect ⇒ decode: no silent trap)', async () => {
    const broker = makeFakeBroker('hub')

    const hubRunner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', hubRunner)

    // agent — detect-enabled, hence frame-source eligible BY CONSTRUCTION
    // (it decodes the owner's restream locally via the satellite plane).
    // Pre-loaded with one camera so the L2 capacity score deterministically
    // places the unpinned test camera on the (empty) hub — a pinned camera
    // would follow the `pinnedOnDisconnect` policy instead of migrating.
    const agentRunner = makeFakeRunner({ nodeId: 'agent' })
    wireRunnerToBroker(broker, 'agent', agentRunner)
    broker.addNode('agent')
    await agentRunner.attachCamera(makeRunnerCameraConfig(999))

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['hub', 'agent'],
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    await addon.dispatchCamera(makeRunnerCameraConfig(104))
    expect(addon.getPipelineAssignment({ deviceId: 104 })?.agentNodeId).toBe('hub')
    expect(hubRunner.attachedCameras.has(104)).toBe(true)

    // Cap-down / disconnect the hub. The agent IS a valid failover target now
    // — the old decode-flag trap (detect-enabled but decode-disabled → camera
    // stranded pending) is gone by construction.
    broker.removeNode('hub')

    // Failover is async — wait for the camera to land on the agent.
    await waitUntil(
      () => addon.getPipelineAssignment({ deviceId: 104 })?.agentNodeId === 'agent',
      2000,
    )
    expect(agentRunner.attachedCameras.has(104)).toBe(true)
    // The off-owner placement carries the remote-restream leg naming the
    // (departed) owner — the agent decodes locally.
    expect(agentRunner.attachedCameras.get(104)?.frameSource).toEqual({
      kind: 'remote-restream',
      ownerNodeId: 'hub',
    })
  })

  it('assignPipeline rejects a pin to a node that is not detect-enabled', async () => {
    const broker = makeFakeBroker('hub')

    const hubRunner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', hubRunner)
    const agentRunner = makeFakeRunner({ nodeId: 'agent' })
    wireRunnerToBroker(broker, 'agent', agentRunner)
    broker.addNode('agent')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        // agent is online but NOT detect-enabled → never a valid placement.
        enabledNodes: ['hub'],
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    await expect(addon.assignPipeline({ deviceId: 104, agentNodeId: 'agent' })).rejects.toThrow(
      /cannot obtain this camera's decoded frames/,
    )

    // The dead pin must NOT have been persisted (neither the canonical
    // `pipelineNodeId` nor the legacy `preferredAgent` key), and no attach happened.
    const persisted = await ctx.settings?.readDeviceStore(104)
    expect(persisted?.['pipelineNodeId']).toBeUndefined()
    expect(persisted?.['preferredAgent']).toBeUndefined()
    expect(agentRunner.attachedCameras.has(104)).toBe(false)

    // A pin to the frame-source node IS accepted.
    await addon.dispatchCamera(makeRunnerCameraConfig(104))
    await expect(addon.assignPipeline({ deviceId: 104, agentNodeId: 'hub' })).resolves.toEqual({
      success: true,
    })

    // The accepted pin persists the canonical `pipelineNodeId` key and nulls
    // the legacy `preferredAgent` (lazy migration onto the canonical key).
    const afterAccept = await ctx.settings?.readDeviceStore(104)
    expect(afterAccept?.['pipelineNodeId']).toBe('hub')
    expect(afterAccept?.['preferredAgent']).toBeNull()
  })
})

/**
 * P2a — per-camera frame-source eligibility (pure predicate).
 *
 * Rule (restream-owner design §2.3): a node N can source camera X's frames iff
 * N can decode locally (`enabledDecoderNodes`) AND (N owns X's source pull OR
 * N is allowed to pull the owner's restream — `remoteSourcingNodes`).
 *
 * SAFETY INVARIANT (the P2a contract): until later phases assign a
 * `sourceOwnerNodeId`, the predicate MUST collapse to exactly today's global
 * `enabledDecoderNodes` — bit-identical, order included — so the rollout is a
 * pure refactor with zero behavior change.
 */
describe('computeFrameSourceNodes — P2a per-camera predicate', () => {
  it('default (no owner, no remoteSourcingNodes) is bit-identical to enabledDecoderNodes', () => {
    const enabledDecoderNodes = ['hub', 'agent-a', 'mac-mini']
    const result = computeFrameSourceNodes({ enabledDecoderNodes })
    expect(result).toEqual(enabledDecoderNodes)
    // Order + membership exact — the safe-rollout guarantee.
    expect([...result]).toStrictEqual(['hub', 'agent-a', 'mac-mini'])
  })

  it('default with an empty decoder whitelist stays empty (strict list, not "all allowed")', () => {
    expect(computeFrameSourceNodes({ enabledDecoderNodes: [] })).toEqual([])
  })

  it('remoteSourcingNodes without a source owner does NOT restrict eligibility (ownership unmodeled → today semantics)', () => {
    const enabledDecoderNodes = ['hub', 'agent-a']
    const result = computeFrameSourceNodes({
      enabledDecoderNodes,
      remoteSourcingNodes: ['agent-a'],
    })
    expect(result).toEqual(['hub', 'agent-a'])
  })

  it('owner-only: with an owner and no remote-sourcing, only the owner is eligible', () => {
    const result = computeFrameSourceNodes({
      enabledDecoderNodes: ['hub', 'agent-a', 'agent-b'],
      sourceOwnerNodeId: 'hub',
    })
    expect(result).toEqual(['hub'])
  })

  it('remoteSourcingNodes widens eligibility beyond the owner', () => {
    const result = computeFrameSourceNodes({
      enabledDecoderNodes: ['hub', 'agent-a', 'agent-b'],
      sourceOwnerNodeId: 'hub',
      remoteSourcingNodes: ['agent-a'],
    })
    expect(result).toEqual(['hub', 'agent-a'])
  })

  it('a node not in enabledDecoderNodes is NEVER eligible, even when remote-sourcing-enabled', () => {
    const result = computeFrameSourceNodes({
      enabledDecoderNodes: ['hub'],
      sourceOwnerNodeId: 'hub',
      remoteSourcingNodes: ['agent-a'], // cannot decode locally → out
    })
    expect(result).toEqual(['hub'])
  })

  it('an owner that cannot decode locally is not eligible either (empty set → camera goes pending, never stranded)', () => {
    const result = computeFrameSourceNodes({
      enabledDecoderNodes: ['agent-a'],
      sourceOwnerNodeId: 'hub',
      remoteSourcingNodes: [],
    })
    expect(result).toEqual([])
  })

  it('per-camera divergence: different owners yield different sets from the same cluster state', () => {
    const enabledDecoderNodes = ['hub', 'agent-a']
    const camX = computeFrameSourceNodes({ enabledDecoderNodes, sourceOwnerNodeId: 'hub' })
    const camY = computeFrameSourceNodes({ enabledDecoderNodes, sourceOwnerNodeId: 'agent-a' })
    expect(camX).toEqual(['hub'])
    expect(camY).toEqual(['agent-a'])
  })

  it('never mutates its inputs and preserves enabledDecoderNodes order', () => {
    const enabledDecoderNodes = ['agent-b', 'hub', 'agent-a']
    const remoteSourcingNodes = ['agent-a', 'agent-b']
    const result = computeFrameSourceNodes({
      enabledDecoderNodes,
      sourceOwnerNodeId: 'hub',
      remoteSourcingNodes,
    })
    expect(result).toEqual(['agent-b', 'hub', 'agent-a'])
    expect(enabledDecoderNodes).toEqual(['agent-b', 'hub', 'agent-a'])
    expect(remoteSourcingNodes).toEqual(['agent-a', 'agent-b'])
  })
})

/**
 * P2d — source-owner assignment wired into the orchestrator, rollout knob
 * `remoteSourcingNodes` (default EMPTY = OFF).
 *
 * SAFETY INVARIANT (rollout OFF): eligibility, assignment, and the attach
 * payload are IDENTICAL to today — `sourceOwner()` stays unmodeled, the
 * predicate collapses to `enabledDecoderNodes`, and every attach carries
 * `frameSource: { kind: 'local-broker' }` (≡ the schema default an absent
 * field would produce).
 *
 * Rollout ON (knob populated): an agent in BOTH `enabledDecoderNodes` and
 * `remoteSourcingNodes` becomes assignable; a camera placed there receives
 * `frameSource: { kind: 'remote-restream', ownerNodeId: <hub> }` so the
 * runner dials the owner's restream and decodes locally.
 */
describe('PipelineOrchestratorAddon — source-owner assignment (P2d)', () => {
  let addon: TestOrchestrator

  afterEach(async () => {
    if (addon) await addon.shutdown()
  })

  it('hub-only detect: attach payload carries local-broker and a non-detect agent stays pin-rejected', async () => {
    const broker = makeFakeBroker('hub')
    const hubRunner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', hubRunner)
    const agentRunner = makeFakeRunner({ nodeId: 'agent' })
    wireRunnerToBroker(broker, 'agent', agentRunner)
    broker.addNode('agent')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        // Only the hub is detect-enabled: ownership stays unmodeled
        // (remoteSourcing derives empty) → classic hub-only cluster.
        enabledNodes: ['hub'],
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    await addon.dispatchCamera(makeRunnerCameraConfig(104))
    expect(addon.getPipelineAssignment({ deviceId: 104 })?.agentNodeId).toBe('hub')
    // The attach payload's frameSource is the schema default — today's path.
    expect(hubRunner.attachedCameras.get(104)?.frameSource).toEqual({ kind: 'local-broker' })

    // The non-detect agent is never a valid placement.
    await expect(addon.assignPipeline({ deviceId: 104, agentNodeId: 'agent' })).rejects.toThrow(
      /cannot obtain this camera's decoded frames/,
    )
  })

  it('a detect-enabled agent gets a remote-restream attach payload naming the hub owner (cross-node activation)', async () => {
    const broker = makeFakeBroker('hub')
    const hubRunner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', hubRunner)
    const agentRunner = makeFakeRunner({ nodeId: 'agent' })
    wireRunnerToBroker(broker, 'agent', agentRunner)
    broker.addNode('agent')

    // Cross-node activation: `remoteSourcingNodes` is DERIVED from the detect
    // set (every detect-enabled node except the ingest owner). A camera
    // placed on a detect-enabled agent therefore attaches with a
    // `remote-restream` payload naming the hub as the source owner — the agent
    // decodes the hub's restream locally instead of the (unreachable) local
    // broker. Pinned to the hub itself the payload stays `local-broker`
    // (target IS the owner).
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['hub', 'agent'],
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    await addon.dispatchCamera(makeRunnerCameraConfig(104))

    await expect(addon.assignPipeline({ deviceId: 104, agentNodeId: 'agent' })).resolves.toEqual({
      success: true,
    })
    // No per-node reachableHost override set → the payload names the owner but
    // carries no ownerReachableHost (the runner auto-detects via CAMSTACK_HUB_URL).
    expect(agentRunner.attachedCameras.get(104)?.frameSource).toEqual({
      kind: 'remote-restream',
      ownerNodeId: 'hub',
    })

    // Pin it back to the hub — target IS the owner → local-broker.
    await expect(addon.assignPipeline({ deviceId: 104, agentNodeId: 'hub' })).resolves.toEqual({
      success: true,
    })
    expect(hubRunner.attachedCameras.get(104)?.frameSource).toEqual({ kind: 'local-broker' })
  })

  it('a non-detect-enabled agent is never assignable', async () => {
    const broker = makeFakeBroker('hub')
    const hubRunner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', hubRunner)
    const agentRunner = makeFakeRunner({ nodeId: 'agent' })
    wireRunnerToBroker(broker, 'agent', agentRunner)
    broker.addNode('agent')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['hub'], // agent is not detect-enabled → never a placement
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    await addon.dispatchCamera(makeRunnerCameraConfig(104))
    await expect(addon.assignPipeline({ deviceId: 104, agentNodeId: 'agent' })).rejects.toThrow(
      /cannot obtain this camera's decoded frames/,
    )
  })
})
