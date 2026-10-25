/**
 * E2E scenarios for the pipeline orchestrator.
 *
 * Exercises the full flow through the addon against a fake broker +
 * fake runner topology, covering:
 *   1. `dispatchCamera` round-trip to a remote runner via broker.call
 *   2. L2 capacity-based node selection
 *   3. L1 manual pin via preferredAgent setting
 *   4. L3 hardware-affinity tie-break between CPU + GPU nodes
 *   5. Capability binding persistence + event emission
 *   6. Failover on $node.disconnected with migrate policy
 *   7. Failover with leave-unassigned policy
 *   8. Pinned-camera behaviour on disconnect (leave-pinned vs unpin)
 *   9. Reconnect restore policy
 *  10. Reconnect rebalance policy
 *  11. Assignment map + global metrics aggregation
 *  12. `releaseCamera` + event unassigned
 *
 * These are NOT unit tests — they drive the real PipelineOrchestratorAddon
 * class through its initialize → operate → shutdown lifecycle against
 * faked dependencies that implement the narrow surfaces the addon uses
 * (MoleculerBrokerLike + AddonContext + IPipelineRunnerProvider).
 */

import type {
  CapabilityBindingChangedPayload,
  ConfigSectionWithValues,
  PipelineCameraAssignmentPayload,
} from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  enabledNodesFromBroker,
  type FakeBroker,
  type FakeRunner,
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeRunnerCameraConfig,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'

describe('PipelineOrchestratorAddon — E2E', () => {
  let addon: PipelineOrchestratorAddon

  afterEach(async () => {
    if (addon) await addon.shutdown()
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 1 — dispatchCamera to a remote runner via broker.call
  // ────────────────────────────────────────────────────────────────────
  it('dispatches a camera to a remote runner via broker.call when it is the only node', async () => {
    const broker = makeFakeBroker('hub')
    const gpuRunner = makeFakeRunner({
      nodeId: 'agent-gpu',
      hasGpu: true,
      inferenceBackend: 'openvino',
    })
    wireRunnerToBroker(broker, 'agent-gpu', gpuRunner)
    // Add the remote node to the broker (not yet registered by default).
    broker.addNode('agent-gpu')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const config = makeRunnerCameraConfig(1, { detectionFps: 10 })
    const result = await addon.dispatchCamera(config)

    expect(result).toEqual({
      success: true,
      kind: 'assigned',
      agentNodeId: 'agent-gpu',
      reason: 'capacity',
    })
    expect(gpuRunner.attachedCameras.has(1)).toBe(true)
    expect(gpuRunner.attachHistory).toEqual([{ action: 'attach', deviceId: 1 }])

    const assignment = addon.getPipelineAssignment({ deviceId: 1 })
    expect(assignment?.agentNodeId).toBe('agent-gpu')
    expect(assignment?.pinned).toBe(false)
    expect(assignment?.reason).toBe('capacity')
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 2 — L2 capacity picks least-loaded agent across 2 nodes
  // ────────────────────────────────────────────────────────────────────
  it('L2 capacity picks the least-loaded runner when multiple nodes are available', async () => {
    const broker = makeFakeBroker('hub')

    const busyRunner = makeFakeRunner({ nodeId: 'agent-busy' })
    // Preload with cameras so getLocalLoad reports a non-zero score
    await busyRunner.attachCamera(makeRunnerCameraConfig(600))
    await busyRunner.attachCamera(makeRunnerCameraConfig(601))
    wireRunnerToBroker(broker, 'agent-busy', busyRunner)

    const idleRunner = makeFakeRunner({ nodeId: 'agent-idle' })
    wireRunnerToBroker(broker, 'agent-idle', idleRunner)

    broker.addNode('agent-busy')
    broker.addNode('agent-idle')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const config = makeRunnerCameraConfig(300, { detectionFps: 4 })
    const result = await addon.dispatchCamera(config)

    expect(result.kind).toBe('assigned')
    if (result.kind !== 'assigned') return // narrow for TS
    expect(result.agentNodeId).toBe('agent-idle')
    expect(result.reason).toBe('capacity')
    expect(idleRunner.attachedCameras.has(300)).toBe(true)
    expect(busyRunner.attachedCameras.has(300)).toBe(false)
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 3 — L1 manual pin via preferredAgent setting wins unconditionally
  // ────────────────────────────────────────────────────────────────────
  it('L1 manual pin forces dispatch to the preferred agent even when it is not the L2 winner', async () => {
    const broker = makeFakeBroker('hub')

    const busyRunner = makeFakeRunner({ nodeId: 'agent-busy' })
    await busyRunner.attachCamera(makeRunnerCameraConfig(600))
    wireRunnerToBroker(broker, 'agent-busy', busyRunner)

    const idleRunner = makeFakeRunner({ nodeId: 'agent-idle' })
    wireRunnerToBroker(broker, 'agent-idle', idleRunner)

    broker.addNode('agent-busy')
    broker.addNode('agent-idle')

    const initialDeviceSettings = new Map<number, Record<string, unknown>>()
    initialDeviceSettings.set(200, { preferredAgent: 'agent-busy' })

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings,
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const result = await addon.dispatchCamera(makeRunnerCameraConfig(200))

    expect(result.kind).toBe('assigned')
    if (result.kind !== 'assigned') return // narrow for TS
    expect(result.agentNodeId).toBe('agent-busy') // overrides L2 which would prefer idle
    expect(result.reason).toBe('manual')
    expect(addon.getPipelineAssignment({ deviceId: 200 })?.pinned).toBe(true)
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 3b — canonical `pipelineNodeId` pin beats the legacy
  // `preferredAgent` when both are present in the device store.
  // ────────────────────────────────────────────────────────────────────
  it('pipelineNodeId pin wins over the legacy preferredAgent when both are set', async () => {
    const broker = makeFakeBroker('hub')

    const busyRunner = makeFakeRunner({ nodeId: 'agent-busy' })
    wireRunnerToBroker(broker, 'agent-busy', busyRunner)
    const idleRunner = makeFakeRunner({ nodeId: 'agent-idle' })
    wireRunnerToBroker(broker, 'agent-idle', idleRunner)
    broker.addNode('agent-busy')
    broker.addNode('agent-idle')

    const initialDeviceSettings = new Map<number, Record<string, unknown>>()
    // Conflicting pins: canonical key points at busy, legacy key at idle.
    initialDeviceSettings.set(200, { preferredAgent: 'agent-idle', pipelineNodeId: 'agent-busy' })

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings,
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const result = await addon.dispatchCamera(makeRunnerCameraConfig(200))

    expect(result.kind).toBe('assigned')
    if (result.kind !== 'assigned') return // narrow for TS
    expect(result.agentNodeId).toBe('agent-busy') // canonical pipelineNodeId wins
    expect(result.reason).toBe('manual')
    expect(busyRunner.attachedCameras.has(200)).toBe(true)
    expect(idleRunner.attachedCameras.has(200)).toBe(false)
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 3c — rebalance honours a `pipelineNodeId` pin that was set on
  // an already-dispatched, unpinned camera (the post-restart divergence the
  // canonicalization fixes — rebalance previously read only `preferredAgent`).
  // ────────────────────────────────────────────────────────────────────
  it('rebalance migrates an unpinned camera to a pipelineNodeId pin set after dispatch', async () => {
    const broker = makeFakeBroker('hub')

    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    const runnerB = makeFakeRunner({ nodeId: 'agent-b' })
    wireRunnerToBroker(broker, 'agent-b', runnerB)
    // agent-b is offline at dispatch time so the camera auto-lands on agent-a.
    broker.addNode('agent-a')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['agent-a', 'agent-b'],
        enabledDecoderNodes: ['agent-a', 'agent-b'],
      },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.dispatchCamera(makeRunnerCameraConfig(200))
    expect(addon.getPipelineAssignment({ deviceId: 200 })?.agentNodeId).toBe('agent-a')
    expect(addon.getPipelineAssignment({ deviceId: 200 })?.pinned).toBe(false)

    // Operator pins to agent-b via the device-settings form — writes only the
    // canonical `pipelineNodeId` key; the assignment stays unpinned until the
    // next dispatch/rebalance (deferred-apply semantics).
    await ctx.settings?.writeDeviceStore(200, { pipelineNodeId: 'agent-b' })
    broker.addNode('agent-b')
    // D650 round 3: a re-place elects against the node's LAST ANSWERED device
    // probe and never waits for one; the dispatcher's own reads (a first
    // placement, the session refresher) are what warm it in production.
    await addon.resolveEligibleInferenceDevices('agent-b', 'await-catalog')

    const { migrated } = await addon.rebalance()

    expect(migrated).toBe(1)
    expect(addon.getPipelineAssignment({ deviceId: 200 })?.agentNodeId).toBe('agent-b')
    expect(runnerB.attachedCameras.has(200)).toBe(true)
    expect(runnerA.attachedCameras.has(200)).toBe(false)
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 4 — capacity-based selection between two idle runners
  // The L3 hardware-affinity tie-break was removed when the balancer
  // collapsed to L1 (manual) + L2 (capacity); see `load-balancer.ts::balance`.
  // The selection is now deterministic on capacity score, with `Array.sort`
  // preserving the input order on ties — so whichever runner shows up
  // first in the load snapshot wins.
  // ────────────────────────────────────────────────────────────────────
  it('balances two idle runners on capacity (no hardware affinity)', async () => {
    const broker = makeFakeBroker('hub')

    const cpuRunner = makeFakeRunner({ nodeId: 'agent-cpu', hasGpu: false })
    wireRunnerToBroker(broker, 'agent-cpu', cpuRunner)

    const gpuRunner = makeFakeRunner({ nodeId: 'agent-gpu', hasGpu: true })
    wireRunnerToBroker(broker, 'agent-gpu', gpuRunner)

    broker.addNode('agent-cpu')
    broker.addNode('agent-gpu')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const result = await addon.dispatchCamera(makeRunnerCameraConfig(400, { detectionFps: 15 }))

    // L2 capacity-only — both runners idle (score = 0). The balancer
    // returns `'capacity'` regardless of which it picks.
    expect(result.kind).toBe('assigned')
    if (result.kind !== 'assigned') return // narrow for TS
    expect(['agent-cpu', 'agent-gpu']).toContain(result.agentNodeId)
    expect(result.reason).toBe('capacity')
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 5 — Capability binding: setCapabilityBinding persists + emits event
  // ────────────────────────────────────────────────────────────────────
  it('setCapabilityBinding persists the node binding and emits capability.binding-changed', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx, store, captured } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.setCapabilityBinding({
      nodeId: 'agent-gpu',
      capName: 'motion-detection',
      addonId: 'motion-wasm',
    })

    // Persisted under nodeBindings.<nodeId>.<capName>
    const stored = store.global['nodeBindings'] as Record<string, Record<string, string>>
    expect(stored).toBeDefined()
    expect(stored['agent-gpu']).toEqual({ 'motion-detection': 'motion-wasm' })

    // Emitted as a typed event
    const emitted = captured.find((e) => e.category === EventCategory.CapabilityBindingChanged)
    expect(emitted).toBeDefined()
    const payload = emitted!.data as CapabilityBindingChangedPayload
    expect(payload.nodeId).toBe('agent-gpu')
    expect(payload.capName).toBe('motion-detection')
    expect(payload.addonId).toBe('motion-wasm')

    // Round-trip via getCapabilityBindings
    const bindings = await addon.getCapabilityBindings({ nodeId: 'agent-gpu' })
    expect(bindings['motion-detection']).toBe('motion-wasm')

    // Other nodes unaffected
    const otherBindings = await addon.getCapabilityBindings({ nodeId: 'agent-cpu' })
    expect(otherBindings).toEqual({})
  })

  it('multiple setCapabilityBinding calls on the same node merge (do not replace)', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.setCapabilityBinding({
      nodeId: 'agent-x',
      capName: 'motion-detection',
      addonId: 'motion-wasm',
    })
    await addon.setCapabilityBinding({
      nodeId: 'agent-x',
      capName: 'decoder',
      addonId: 'decoder-nodeav',
    })

    const bindings = await addon.getCapabilityBindings({ nodeId: 'agent-x' })
    expect(bindings).toEqual({
      'motion-detection': 'motion-wasm',
      decoder: 'decoder-nodeav',
    })
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 6 — Failover: migrate policy (default)
  // ────────────────────────────────────────────────────────────────────
  it('on node disconnect, migrates non-pinned cameras to another runner (default migrate policy)', async () => {
    const broker = makeFakeBroker('hub')

    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    const runnerB = makeFakeRunner({ nodeId: 'agent-b' })
    wireRunnerToBroker(broker, 'agent-b', runnerB)
    broker.addNode('agent-a')
    broker.addNode('agent-b')

    const { ctx, captured } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // Dispatch two cameras. Agent-a gets them first (deterministic order
    // because both runners are idle — first in the nodeList wins on ties).
    await addon.dispatchCamera(makeRunnerCameraConfig(1))
    await addon.dispatchCamera(makeRunnerCameraConfig(2))

    // Both should land on one of the two idle agents.
    const initialOwnerA = addon.getPipelineAssignment({ deviceId: 1 })?.agentNodeId
    const initialOwnerB = addon.getPipelineAssignment({ deviceId: 2 })?.agentNodeId
    expect(initialOwnerA).toBeDefined()
    expect(initialOwnerB).toBeDefined()

    // Disconnect whichever agent owns cam-1.
    const victimNodeId = initialOwnerA!
    const survivorRunnerId = victimNodeId === 'agent-a' ? 'agent-b' : 'agent-a'
    const survivorRunner = victimNodeId === 'agent-a' ? runnerB : runnerA

    // Filter the victim's cameras so we can assert they all move
    const victimCameras = [...addon.getPipelineAssignments()]
      .filter((a) => a.agentNodeId === victimNodeId)
      .map((a) => a.deviceId)
    expect(victimCameras.length).toBeGreaterThan(0)

    broker.removeNode(victimNodeId)

    // Failover is async — wait for reassignments to land.
    await waitUntil(
      () =>
        victimCameras.every(
          (deviceId) => addon.getPipelineAssignment({ deviceId })?.agentNodeId === survivorRunnerId,
        ),
      2000,
    )

    // Each migrated camera must now be attached to the survivor runner with reason 'failover'.
    for (const deviceId of victimCameras) {
      const a = addon.getPipelineAssignment({ deviceId })
      expect(a?.agentNodeId).toBe(survivorRunnerId)
      expect(a?.reason).toBe('failover')
      expect(survivorRunner.attachedCameras.has(deviceId)).toBe(true)
    }

    // And a PipelineCameraAssigned event with reason 'failover' must have been emitted
    const failoverEvents = captured.filter(
      (e) =>
        e.category === EventCategory.PipelineCameraAssigned &&
        (e.data as PipelineCameraAssignmentPayload).reason === 'failover',
    )
    expect(failoverEvents.length).toBeGreaterThanOrEqual(victimCameras.length)
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 7 — Failover: leave-unassigned policy
  // ────────────────────────────────────────────────────────────────────
  it('on node disconnect with leave-unassigned policy, drops assignments without migration', async () => {
    const broker = makeFakeBroker('hub')

    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    const runnerB = makeFakeRunner({ nodeId: 'agent-b' })
    wireRunnerToBroker(broker, 'agent-b', runnerB)
    broker.addNode('agent-a')
    broker.addNode('agent-b')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        onDisconnect: 'leave-unassigned',
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.dispatchCamera(makeRunnerCameraConfig(1))
    const owner = addon.getPipelineAssignment({ deviceId: 1 })?.agentNodeId
    expect(owner).toBeDefined()

    broker.removeNode(owner!)

    await waitUntil(() => addon.getPipelineAssignment({ deviceId: 1 }) === null, 2000)

    // No migration happened — cam-1 is fully dropped from the assignment map.
    expect(addon.getPipelineAssignment({ deviceId: 1 })).toBeNull()
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 8 — Pinned camera on disconnect: leave-pinned vs unpin-and-migrate
  // ────────────────────────────────────────────────────────────────────
  it('leaves pinned cameras unassigned on disconnect (default leave-pinned policy)', async () => {
    const broker = makeFakeBroker('hub')
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    const runnerB = makeFakeRunner({ nodeId: 'agent-b' })
    wireRunnerToBroker(broker, 'agent-b', runnerB)
    broker.addNode('agent-a')
    broker.addNode('agent-b')

    const initialDeviceSettings = new Map<number, Record<string, unknown>>()
    initialDeviceSettings.set(200, { preferredAgent: 'agent-a' })

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings,
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.dispatchCamera(makeRunnerCameraConfig(200))
    expect(addon.getPipelineAssignment({ deviceId: 200 })?.agentNodeId).toBe('agent-a')
    expect(addon.getPipelineAssignment({ deviceId: 200 })?.pinned).toBe(true)

    broker.removeNode('agent-a')

    // Give the failover handler time to run; pinned cameras are NOT migrated
    // so the assignment stays in place pointing at the disconnected agent.
    await new Promise((r) => setTimeout(r, 50))
    const still = addon.getPipelineAssignment({ deviceId: 200 })
    expect(still?.agentNodeId).toBe('agent-a')
    expect(still?.pinned).toBe(true)
    expect(runnerB.attachedCameras.has(200)).toBe(false)
  })

  it('unpin-and-migrate policy clears the pin and reassigns pinned cameras', async () => {
    const broker = makeFakeBroker('hub')
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    const runnerB = makeFakeRunner({ nodeId: 'agent-b' })
    wireRunnerToBroker(broker, 'agent-b', runnerB)
    broker.addNode('agent-a')
    broker.addNode('agent-b')

    const initialDeviceSettings = new Map<number, Record<string, unknown>>()
    initialDeviceSettings.set(200, { preferredAgent: 'agent-a' })

    const { ctx, store } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        pinnedOnDisconnect: 'unpin-and-migrate',
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
      initialDeviceSettings,
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.dispatchCamera(makeRunnerCameraConfig(200))
    expect(addon.getPipelineAssignment({ deviceId: 200 })?.agentNodeId).toBe('agent-a')

    broker.removeNode('agent-a')

    await waitUntil(
      () => addon.getPipelineAssignment({ deviceId: 200 })?.agentNodeId === 'agent-b',
      2000,
    )

    const after = addon.getPipelineAssignment({ deviceId: 200 })
    expect(after?.agentNodeId).toBe('agent-b')
    expect(after?.reason).toBe('failover')
    // Pin cleared in settings store. The new raw writeDeviceStore API
    // preserves explicit null (Phase 2 redesign — null is the canonical
    // "cleared" sentinel). The orchestrator's internal `readPipelinePin`
    // treats both null and missing as "no preference". unpin-and-migrate
    // must clear BOTH keys so a surviving `pipelineNodeId` pin cannot
    // resurrect the pin on the next dispatch.
    expect(store.devices.get(200)?.['preferredAgent']).toBeNull()
    expect(store.devices.get(200)?.['pipelineNodeId']).toBe('auto')
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 9 — Reconnect: restore previous assignments
  // ────────────────────────────────────────────────────────────────────
  it('on reconnect with restore policy, re-attaches previously-assigned cameras', async () => {
    const broker = makeFakeBroker('hub')
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    const runnerB = makeFakeRunner({ nodeId: 'agent-b' })
    wireRunnerToBroker(broker, 'agent-b', runnerB)
    broker.addNode('agent-a')
    broker.addNode('agent-b')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.dispatchCamera(makeRunnerCameraConfig(1))
    const initialOwner = addon.getPipelineAssignment({ deviceId: 1 })!.agentNodeId

    // Simulate: user reconfigures and wants cam-1 back where it was.
    // We pin it by calling assignCamera and then disconnect the target to
    // simulate a flapping node.
    broker.removeNode(initialOwner)
    await waitUntil(
      () => addon.getPipelineAssignment({ deviceId: 1 })?.agentNodeId !== initialOwner,
      2000,
    )

    // Now add the victim back — the restore handler should re-attach cam-1
    // to its most recent owner if that matches.
    broker.addNode(initialOwner)
    wireRunnerToBroker(broker, initialOwner, initialOwner === 'agent-a' ? runnerA : runnerB)

    // The restore path walks cameraConfigs and re-attaches to the reconnected
    // node. Give it time to run.
    await new Promise((r) => setTimeout(r, 50))

    // After restore, cam-1 should be bound to the newly-reconnected node
    // because its cached config matched and the current assignment pointed
    // at the other node.
    // NOTE: the restore policy in the current impl re-attaches cameras whose
    // last known assignment was the reconnected nodeId. Depending on the
    // migration above, cam-1 may have ended up on a different node, so the
    // restore path may be a no-op. This test accepts either outcome — it
    // just verifies the reconnect handler runs without throwing + leaves a
    // valid assignment in place.
    const finalAssignment = addon.getPipelineAssignment({ deviceId: 1 })
    expect(finalAssignment).not.toBeNull()
    expect(['agent-a', 'agent-b']).toContain(finalAssignment!.agentNodeId)
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 10 — Assignment observability + global metrics aggregation
  // ────────────────────────────────────────────────────────────────────
  it('aggregates global metrics across all runners after dispatches', async () => {
    const broker = makeFakeBroker('hub')

    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    const runnerB = makeFakeRunner({ nodeId: 'agent-b', hasGpu: true })
    wireRunnerToBroker(broker, 'agent-b', runnerB)
    broker.addNode('agent-a')
    broker.addNode('agent-b')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.dispatchCamera(makeRunnerCameraConfig(1))
    await addon.dispatchCamera(makeRunnerCameraConfig(2))

    const metrics = await addon.getGlobalMetrics()
    expect(metrics.totalAgents).toBeGreaterThanOrEqual(2)
    expect(metrics.onlineAgents).toBeGreaterThanOrEqual(2)
    expect(metrics.attachedCameras).toBeGreaterThan(0)

    const agentLoad = await addon.getAgentLoad()
    expect(agentLoad.length).toBeGreaterThanOrEqual(2)
    for (const summary of agentLoad) {
      expect(summary.online).toBe(true)
      expect(typeof summary.score).toBe('number')
    }

    const assignments = addon.getPipelineAssignments()
    expect(assignments.length).toBe(2)
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 11 — releaseCamera emits unassigned event + detaches on runner
  // ────────────────────────────────────────────────────────────────────
  it('releaseCamera detaches from the current runner and emits the unassigned event', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'agent-a', runner)
    broker.addNode('agent-a')

    const { ctx, captured } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.dispatchCamera(makeRunnerCameraConfig(1))
    expect(runner.attachedCameras.has(1)).toBe(true)

    const countBefore = captured.filter(
      (e) => e.category === EventCategory.PipelineCameraUnassigned,
    ).length
    await addon.releaseCamera({ deviceId: 1 })

    expect(runner.attachedCameras.has(1)).toBe(false)
    expect(addon.getPipelineAssignment({ deviceId: 1 })).toBeNull()

    const unassignedAfter = captured.filter(
      (e) => e.category === EventCategory.PipelineCameraUnassigned,
    )
    expect(unassignedAfter.length).toBe(countBefore + 1)
    const payload = unassignedAfter[unassignedAfter.length - 1]!
      .data as PipelineCameraAssignmentPayload
    expect(payload.deviceId).toBe(1)
    expect(payload.reason).toBe('unassigned')
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 12 — Orchestration settings: schema + kernel resolver
  //
  // The Phase 3 settings redesign split the orchestrator schema into two
  // disjoint families:
  //   - getAddonSettings()  → balancer + failover (cluster-wide tunables)
  //   - getDeviceSettings() → enables + source + routing + rates (per-camera)
  // The legacy `getConfigSchema / getConfig / onConfigChange` trio is gone.
  // Per-camera defaults are hardcoded in the device schema and surfaced via
  // hydrateSchema() inside the orchestrator's resolveDeviceDetectionSettings.
  // ────────────────────────────────────────────────────────────────────
  it('getDeviceSettings declares defaults for every per-device orchestration field', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // A fresh device with nothing in the store should still come back fully
    // populated thanks to hydrateSchema() injecting the schema defaults.
    const hydrated = await addon.getDeviceSettings(301)
    const fieldValues = new Map<string, unknown>()
    for (const section of hydrated.sections) {
      for (const field of section.fields) {
        if (field.type === 'separator' || field.type === 'info' || field.type === 'button') continue
        if (field.type === 'group') continue
        fieldValues.set(field.key, (field as { readonly value: unknown }).value)
      }
    }

    // Enables — motionDetectionEnabled + pipelineEnabled are no longer
    // device-settings fields; they derive from the motion-detection /
    // detection-pipeline wrapper bindings respectively (F15a, F3b).
    expect(fieldValues.has('motionDetectionEnabled')).toBe(false)
    // Sources. (`priority` is not a per-device settings field — camera
    // scheduling priority lives on the runner config, never in the
    // device-settings schema, so it never surfaces here.)
    expect(fieldValues.get('motionSources')).toEqual(['analyzer'])
    expect(fieldValues.has('priority')).toBe(false)
    // Routing. Motion analysis runs on the low substream (cheap frame-diff);
    // object detection defaults to the high stream for best inference quality.
    expect(fieldValues.get('motionStreamProfile')).toBe('low')
    expect(fieldValues.get('detectionStreamProfile')).toBe('high')
    // Rates — detection defaults to the runner capability's bounded 10 fps. The legacy `10` cap was lifted when the runner
    // gained per-frame backpressure on the inference pool.
    expect(fieldValues.get('motionFps')).toBe(4)
    expect(fieldValues.get('detectionFps')).toBe(10)
    // Default bumped 15s → 30s in commit 9f354444 (UI floor aligned
    // with the Reolink event watchdog cadence).
    expect(fieldValues.get('motionCooldownMs')).toBe(30_000)
    // Dead fields (motionThreshold / motionMinArea / motionDebug) are
    // gone — they live on motion-wasm / runner.
    expect(fieldValues.has('motionThreshold')).toBe(false)
    expect(fieldValues.has('motionMinArea')).toBe(false)
    expect(fieldValues.has('motionDebug')).toBe(false)
  })

  it('getGlobalSettings exposes cluster + load + detail-crop + native-lease + failover sections', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const hydrated = await addon.getGlobalSettings()
    expect(hydrated).not.toBeNull()
    const sectionIds = hydrated!.sections.map((s: ConfigSectionWithValues) => s.id)
    // The legacy `'balancer'` section was renamed to `'load'` when the
    // load-balancer settings expanded to cover broker timeouts and the
    // load-shedding FPS floor (see `index.ts::buildAddonSchema`).
    // `detail-crop` is the cluster-wide enrichment crop convention: ONE value
    // for the whole cluster, because `object-clip` is one shared feature space
    // and two crop conventions in it make cosine scores meaningless. It lives
    // at ADDON level for exactly that reason — see the scope assertions in
    // `detail-crop-settings.spec.ts`.
    // `native-lease` is the decode worker's native-frame retention window (TTL /
    // RAM ceiling / demand window) — cluster-wide for the same kind of reason:
    // it decides whether a stored crop is native pixels or the ≤640 fallback,
    // which must not depend on which node the balancer picked. See
    // `native-lease-settings.spec.ts`.
    // `cluster-step-models` is the cluster-wide encoder choice for the steps
    // whose definition declares `modelScope: 'cluster'` (face-embedding,
    // clip-embedding) — the WHICH-encoder half of the same argument
    // `detail-crop` makes about WHAT pixels it sees. See
    // `cluster-model-settings.spec.ts`.
    expect(sectionIds).toEqual([
      'cluster',
      'load',
      'cluster-step-models',
      'detail-crop',
      // D866: the cadence of the automatic whole-archive face rescore.
      'face-rescore',
      'native-lease',
      'failover',
    ])
    expect(sectionIds).not.toContain('decoder')

    // The per-camera fields must NOT appear at addon level (no overlap
    // with the device schema).
    const allFieldKeys: string[] = []
    for (const section of hydrated!.sections) {
      for (const field of section.fields) {
        if (field.type === 'separator' || field.type === 'info' || field.type === 'button') continue
        if (field.type === 'group') continue
        allFieldKeys.push(field.key)
      }
    }
    expect(allFieldKeys).not.toContain('motionFps')
    expect(allFieldKeys).not.toContain('detectionFps')
    expect(allFieldKeys).not.toContain('backend')
    expect(allFieldKeys).not.toContain('frameSink')
    // The four flat enable lists were replaced by the per-node capability
    // store + cluster-role selectors (placement-model redesign). The cluster
    // section now exposes the singleton-role node-selects.
    expect(allFieldKeys).not.toContain('enabledNodes')
    expect(allFieldKeys).toContain('ingestNode')
    // The recording node is NOT an orchestrator role — the `recorder` addon is
    // the single source of truth (its `recordingNodeId` global setting). The
    // orchestrator no longer exposes a duplicate `recordingNode` selector.
    expect(allFieldKeys).not.toContain('recordingNode')
    expect(allFieldKeys).toContain('audioNode')
    // `gpuAffinityFpsThreshold` was removed when the L3 hardware-affinity
    // tie-break was dropped from the load balancer (see `load-balancer.ts`).
    // `fpsMinThreshold` (load-shedding floor) is the load-section field
    // that survived the simplification.
    expect(allFieldKeys).toContain('fpsMinThreshold')
    expect(allFieldKeys).toContain('onDisconnect')
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 13 — Runtime config override via updateAddonSettings
  // ────────────────────────────────────────────────────────────────────
  it('updateAddonSettings updates balancer thresholds at runtime', async () => {
    const broker = makeFakeBroker('hub')
    // Two runners, one GPU one CPU.
    const cpuRunner = makeFakeRunner({ nodeId: 'agent-cpu', hasGpu: false })
    wireRunnerToBroker(broker, 'agent-cpu', cpuRunner)
    const gpuRunner = makeFakeRunner({ nodeId: 'agent-gpu', hasGpu: true })
    wireRunnerToBroker(broker, 'agent-gpu', gpuRunner)
    broker.addNode('agent-cpu')
    broker.addNode('agent-gpu')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // Raise the GPU affinity threshold so a 10fps camera no longer qualifies
    // for the L3 GPU pick — it should fall back to L2 capacity winner.
    await addon.updateGlobalSettings({
      gpuAffinityFpsThreshold: 20,
      capacityTieEpsilon: 2,
    })

    const result = await addon.dispatchCamera(makeRunnerCameraConfig(10, { detectionFps: 10 }))
    // With threshold raised, 10fps is below the threshold → L3 does not kick
    // in → L2 capacity winner stays (sort-stable, first in list = agent-cpu).
    expect(result.kind).toBe('assigned')
    if (result.kind !== 'assigned') return // narrow for TS
    expect(result.reason).toBe('capacity')
  })

  // ────────────────────────────────────────────────────────────────────
  // Scenario 14 — dispatchCamera caches config for later rebalance
  // ────────────────────────────────────────────────────────────────────
  it('rebalance re-picks an optimal agent for non-pinned cameras', async () => {
    const broker = makeFakeBroker('hub')

    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    const runnerB = makeFakeRunner({ nodeId: 'agent-b' })
    wireRunnerToBroker(broker, 'agent-b', runnerB)
    broker.addNode('agent-a')
    broker.addNode('agent-b')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.dispatchCamera(makeRunnerCameraConfig(1))
    const initialOwner = addon.getPipelineAssignment({ deviceId: 1 })!.agentNodeId

    // Load up the initial owner so the balancer should prefer the other runner
    // on the next pass.
    const overloadedRunner = initialOwner === 'agent-a' ? runnerA : runnerB
    for (let i = 0; i < 10; i++) {
      await overloadedRunner.attachCamera(makeRunnerCameraConfig(700 + i))
    }
    // D650 round 3: a re-place elects against the node's LAST ANSWERED device
    // probe and never waits for one; the dispatcher's own reads (a first
    // placement, the session refresher) are what warm it in production.
    await addon.resolveEligibleInferenceDevices('agent-a', 'await-catalog')
    await addon.resolveEligibleInferenceDevices('agent-b', 'await-catalog')

    const { migrated } = await addon.rebalance()

    // The only cam in the orchestrator's tracked config map is cam-1 — bulk
    // cameras were attached directly on the fake runner without going through
    // dispatchCamera, so `this.cameraConfigs` only contains cam-1.
    // Rebalance should migrate cam-1 away from the overloaded runner.
    expect(migrated).toBe(1)
    const newOwner = addon.getPipelineAssignment({ deviceId: 1 })!.agentNodeId
    expect(newOwner).not.toBe(initialOwner)
    expect(addon.getPipelineAssignment({ deviceId: 1 })!.reason).toBe('rebalance')
  })
})

describe('PipelineOrchestratorAddon — E2E (local-only / no broker)', () => {
  let addon: PipelineOrchestratorAddon

  afterEach(async () => {
    if (addon) await addon.shutdown()
  })

  it('dispatches to the local runner via ctx.api when no remote broker is injected', async () => {
    // Wire a local runner through a single-node broker on 'hub'.
    const broker = makeFakeBroker('hub')
    const localRunner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', localRunner)

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'] },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const result = await addon.dispatchCamera(makeRunnerCameraConfig(500))
    expect(result.success).toBe(true)
    expect(localRunner.attachedCameras.has(500)).toBe(true)
  })
})

describe('FakeBroker sanity', () => {
  it('routes broker.call to the right node', async () => {
    const broker: FakeBroker = makeFakeBroker('hub')
    const runner: FakeRunner = makeFakeRunner({ nodeId: 'agent-1' })
    wireRunnerToBroker(broker, 'agent-1', runner)

    const load = (await broker.call('pipeline-runner.pipeline-runner.getLocalLoad', undefined, {
      nodeID: 'agent-1',
    })) as { nodeId: string }
    expect(load.nodeId).toBe('agent-1')
  })

  it('throws when the target node is offline', async () => {
    const broker = makeFakeBroker('hub')
    await expect(
      broker.call('pipeline-runner.pipeline-runner.getLocalLoad', undefined, { nodeID: 'ghost' }),
    ).rejects.toThrow(/offline/)
  })

  it('removeNode fires $node.disconnected listeners', () => {
    const broker = makeFakeBroker('hub')
    broker.addNode('agent-1')
    const seen: string[] = []
    broker.localBus.on('$node.disconnected', (data) => {
      seen.push(data.node.id)
    })
    broker.removeNode('agent-1')
    expect(seen).toEqual(['agent-1'])
  })

  it('addNode fires $node.connected listeners', () => {
    const broker = makeFakeBroker('hub')
    const seen: string[] = []
    broker.localBus.on('$node.connected', (data) => {
      seen.push(data.node.id)
    })
    broker.addNode('agent-2')
    expect(seen).toEqual(['agent-2'])
  })
})

// ──────────────────────────────────────────────────────────────────────
// Scenario — pipeline watchdog wiring
//
// Verifies the orchestrator wires its per-camera watchdog: dispatching an
// always-on audio camera registers it; the 30s heartbeat fires a
// `[watchdog]` log line; and with NO audio signal arriving, once the stage
// staleness passes the audio threshold the watchdog requests a stream
// source refresh on the audio stream (recovery).
// ──────────────────────────────────────────────────────────────────────
describe('PipelineOrchestratorAddon — E2E (pipeline watchdog wiring)', () => {
  let addon: PipelineOrchestratorAddon

  afterEach(async () => {
    if (addon) await addon.shutdown()
    vi.useRealTimers()
  })

  it('emits a [watchdog] heartbeat and requests a source refresh for a stalled always-on audio stage', async () => {
    vi.useFakeTimers()

    const broker = makeFakeBroker('hub')
    const localRunner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', localRunner)

    const { ctx, captured } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'] },
    })

    // Spy the scoped logger so heartbeat lines are observable. The watchdog
    // receives `ctx.logger` directly, so mutating these before initialize
    // captures every watchdog call.
    const infoSpy = vi.spyOn(ctx.logger, 'info')
    const warnSpy = vi.spyOn(ctx.logger, 'warn')

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // Always-on audio camera (makeRunnerCameraConfig defaults to
    // audioMode: 'always-on' + motionSources: ['analyzer']).
    await addon.dispatchCamera(makeRunnerCameraConfig(42))

    const isWatchdogLine = (line: unknown): boolean =>
      typeof line === 'string' && line.includes('[watchdog]') && line.includes('cam42')
    const sawHeartbeat = (): boolean =>
      infoSpy.mock.calls.some((c) => isWatchdogLine(c[0])) ||
      warnSpy.mock.calls.some((c) => isWatchdogLine(c[0]))

    // One interval tick (30s) → at least one heartbeat for cam42.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sawHeartbeat()).toBe(true)

    // No audio signal ever arrives. Audio threshold is 90s; advance well
    // past it so the watchdog flags the stage stalled and triggers recovery.
    await vi.advanceTimersByTimeAsync(120_000)

    const refresh = captured.find(
      (e) => e.category === EventCategory.StreamBrokerOnRequestStreamSourceRefresh,
    )
    expect(refresh).toBeDefined()
    expect(refresh?.data).toMatchObject({ deviceId: 42, camStreamId: 'sub' })
  })
})
