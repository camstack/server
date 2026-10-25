/**
 * Regression tests for the orchestrator's 3-level agent-settings cap
 * surface: `getAgentSettings`, `listAgentSettings`, `setAgentAddonDefaults`,
 * `getCameraSettings`, `setCameraStepToggle`, `setCameraDisableInference`.
 *
 * The pure resolver is covered by `pipeline-resolver.spec.ts`; this
 * suite exercises the cap-handler wiring that persists and re-reads the
 * settings via `ctx.settings` plus the malformed-nodeId defensive guard
 * in `writeAgentSettings` / `listAgentSettings`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import { pipelineOrchestratorActions } from '../index.js'
import { makeFakeContext, makeFakeBroker, enabledNodesFromBroker } from './e2e-helpers.js'
import { resolveInferenceDeviceEligibility } from '../inference-device-model.js'
import type { DeviceStepConfig, InferenceDeviceDescriptor } from '@camstack/types'

function mkDescriptor(
  key: string,
  backend: string,
  device: string,
  format: InferenceDeviceDescriptor['format'],
): InferenceDeviceDescriptor {
  return { key, backend, device, format, runtime: 'python', score: 50, available: true }
}

describe('PipelineOrchestrator — agent settings cap handlers', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('getAgentSettings returns null for an unknown agent', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const result = await addon.getAgentSettings({ agentNodeId: 'missing-agent' })
    expect(result).toBeNull()
  })

  it('listAgentSettings enumerates every persisted agent', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.setAgentMaxCameras({ agentNodeId: 'hub', maxCameras: 5 })
    await addon.setAgentMaxCameras({ agentNodeId: 'dev-agent-0', maxCameras: 5 })

    const list = await addon.listAgentSettings()
    const ids = list.map((e) => e.nodeId).toSorted()
    expect(ids).toEqual(['dev-agent-0', 'hub'])
  })

  it('setAgentReachableHost re-derives topology — getIngestOwner reflects the new host immediately', async () => {
    // Regression: the handler persisted the host but never called
    // refreshNodeCapabilities, so reachableHostByNode stayed stale until an
    // unrelated topology refresh — getIngestOwner (and every new attach
    // payload's ownerReachableHost) kept the OLD host.
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.setAgentReachableHost({ agentNodeId: 'hub', reachableHost: '192.168.x.x' })
    const owner = await addon.getIngestOwner()
    expect(owner).toMatchObject({ ownerNodeId: 'hub', reachableHost: '192.168.x.x' })

    // Clearing the override must also propagate immediately.
    await addon.setAgentReachableHost({ agentNodeId: 'hub', reachableHost: null })
    const cleared = await addon.getIngestOwner()
    expect(cleared.reachableHost).toBeUndefined()
  })

  it('listAgentSettings strips ghost nodeId entries (empty / "undefined" / "null")', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // Seed one legit agent...
    await addon.setAgentMaxCameras({ agentNodeId: 'dev-agent-0', maxCameras: 5 })
    // ...then inject ghost entries directly in the store (simulating
    // legacy data persisted before the writeAgentSettings guard).
    const store = (await ctx.settings!.readAddonStore()) as Record<string, unknown>
    const map = (store.agentSettings ?? {}) as Record<string, unknown>
    map[''] = { maxCameras: null }
    map['undefined'] = { maxCameras: null }
    map['null'] = { maxCameras: null }
    await ctx.settings!.writeAddonStore({ agentSettings: map })

    const list = await addon.listAgentSettings()
    const ids = list.map((e) => e.nodeId)
    expect(ids).toContain('dev-agent-0')
    expect(ids).not.toContain('')
    expect(ids).not.toContain('undefined')
    expect(ids).not.toContain('null')
  })

  it('writeAgentSettings refuses to persist a malformed nodeId', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // Bypass the public cap and hit the internal write — simulates a
    // bug upstream where a malformed nodeId would previously land in
    // the store. The guard must swallow the write without throwing
    // (best-effort: log warn and move on). The guard lives in
    // `PipelineSettingsStore` (S4 extraction) — reach through the
    // addon's private `settingsStore` field, same test-seam pattern.
    await (
      addon as unknown as {
        settingsStore: { writeAgentSettings: (id: string, s: unknown) => Promise<void> }
      }
    ).settingsStore.writeAgentSettings('undefined', { maxCameras: null })

    const list = await addon.listAgentSettings()
    expect(list.every((e) => e.nodeId !== 'undefined')).toBe(true)
  })

  it('setCameraStepToggle persists the override + getCameraSettings reads it back', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'object-detection', enabled: true })
    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'face-detection', enabled: false })
    const cam = await addon.getCameraSettings({ deviceId: 1 })
    expect(cam?.stepToggles).toEqual({ 'object-detection': true, 'face-detection': false })

    // `null` = inherit → entry removed from the store.
    await addon.setCameraStepToggle({ deviceId: 1, addonId: 'object-detection', enabled: null })
    const cam2 = await addon.getCameraSettings({ deviceId: 1 })
    expect(cam2?.stepToggles).toEqual({ 'face-detection': false })
  })

  // `setCameraDisableInference` / `disableInference` removed in F4 —
  // the per-device "inference off" toggle is now the detection-pipeline
  // binding, managed via `device-manager.setWrapperActive`. The runtime
  // effect (empty pipeline when disabled) is covered by the
  // orchestrator-level binding tests in this suite.

  it('setAgentMaxCameras persists + getAgentSettings reads back the cap', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // Set a cap and read it back.
    await addon.setAgentMaxCameras({ agentNodeId: 'hub', maxCameras: 5 })
    const read = await addon.getAgentSettings({ agentNodeId: 'hub' })
    expect(read?.maxCameras).toBe(5)

    // Clearing to null (unlimited) — balancer treats null as unlimited.
    await addon.setAgentMaxCameras({ agentNodeId: 'hub', maxCameras: null })
    const read2 = await addon.getAgentSettings({ agentNodeId: 'hub' })
    expect(read2?.maxCameras).toBeNull()
  })

  it('setLoadBalancingShares writes node + device shares in one write and reads back (D748)', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.setAgentMaxCameras({ agentNodeId: 'hub', maxCameras: 4 })
    await addon.setLoadBalancingShares({ nodes: { hub: 60 }, devices: {} })
    const read = await addon.getAgentSettings({ agentNodeId: 'hub' })
    expect(read?.detectWeight).toBe(60)
    // Every other field of the node survives the share write.
    expect(read?.maxCameras).toBe(4)
  })

  it('setAgentMaxCameras on an unknown agent seeds a bare entry', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.setAgentMaxCameras({ agentNodeId: 'new-agent', maxCameras: 3 })
    const read = await addon.getAgentSettings({ agentNodeId: 'new-agent' })
    expect(read?.maxCameras).toBe(3)
    // No per-node model layer — inferenceDevices absent until configured.
    expect(read?.inferenceDevices).toBeUndefined()
  })

  it('setAgentInferenceDevices persists the map + eligible view is enabled∧available (AUTO opt-out)', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // Two devices enabled (one weighted), one disabled.
    await addon.setAgentInferenceDevices({
      agentNodeId: 'hub',
      inferenceDevices: {
        'openvino:npu': { enabled: true },
        'openvino:gpu': { enabled: true, weight: 3 },
        cpu: { enabled: false },
      },
    })

    // Persisted verbatim on the agent settings entry.
    const read = await addon.getAgentSettings({ agentNodeId: 'hub' })
    expect(read?.inferenceDevices).toEqual({
      'openvino:npu': { enabled: true },
      'openvino:gpu': { enabled: true, weight: 3 },
      cpu: { enabled: false },
    })

    // The dispatcher-facing eligible view (probe-aware, opt-OUT): a probe that
    // reports npu/gpu/cpu all available → only enabled∧available survive, and
    // cpu was explicitly opted out.
    const probed = [
      mkDescriptor('openvino:npu', 'openvino', 'npu', 'openvino'),
      mkDescriptor('openvino:gpu', 'openvino', 'gpu', 'openvino'),
      mkDescriptor('cpu', 'cpu', 'cpu', 'onnx'),
    ]
    const persisted = (await addon.getAgentSettings({ agentNodeId: 'hub' }))!.inferenceDevices!
    expect(resolveInferenceDeviceEligibility(probed, persisted).eligible).toEqual({
      'openvino:npu': 1,
      'openvino:gpu': 3,
    })

    // Clearing the map now means AUTO = all discovered ACCELERATORS enabled
    // (opt-out); CPU stays opt-IN (fallback), so it is NOT auto-balanced.
    await addon.setAgentInferenceDevices({ agentNodeId: 'hub', inferenceDevices: {} })
    const cleared = (await addon.getAgentSettings({ agentNodeId: 'hub' }))!.inferenceDevices ?? {}
    expect(resolveInferenceDeviceEligibility(probed, cleared).eligible).toEqual({
      'openvino:npu': 1,
      'openvino:gpu': 1,
    })
  })

  it('setAgentInferenceDevices round-trips per-(node,device) base steps (C7.2/C7.4)', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.setAgentInferenceDevices({
      agentNodeId: 'hub',
      inferenceDevices: {
        'openvino:npu': {
          enabled: true,
          steps: { 'object-detection': { modelId: 'yolov9m-320-int8', settings: { conf: 0.3 } } },
        },
        'openvino:gpu': { enabled: true, weight: 2 },
      },
    })

    // Persisted verbatim, including the per-device base steps.
    const read = await addon.getAgentSettings({ agentNodeId: 'hub' })
    expect(read?.inferenceDevices).toEqual({
      'openvino:npu': {
        enabled: true,
        steps: { 'object-detection': { modelId: 'yolov9m-320-int8', settings: { conf: 0.3 } } },
      },
      'openvino:gpu': { enabled: true, weight: 2 },
    })

    // The dispatcher-facing base reader: a device's entry (model AND its own
    // settings) is read for that device alone — a sibling's settings never
    // leak (D927; node-wide content lives in `stepSettings`).
    const store = (
      addon as unknown as {
        settingsStore: {
          buildNodeInferenceDeviceSteps: (
            n: string,
            k: string,
          ) => Promise<Record<string, DeviceStepConfig>>
        }
      }
    ).settingsStore
    expect(await store.buildNodeInferenceDeviceSteps('hub', 'openvino:npu')).toEqual({
      'object-detection': { modelId: 'yolov9m-320-int8', settings: { conf: 0.3 } },
    })
    expect(await store.buildNodeInferenceDeviceSteps('hub', 'openvino:gpu')).toEqual({})
    expect(await store.buildNodeInferenceDeviceSteps('hub', 'nonexistent')).toEqual({})

    // getNodeInferenceDevices surfaces the raw base steps on the device row.
    const view = await addon.getNodeInferenceDevices({ nodeId: 'hub' })
    const rows: readonly {
      readonly key: string
      readonly steps?: Record<string, DeviceStepConfig>
    }[] = view.devices
    const npu = rows.find((d) => d.key === 'openvino:npu')
    expect(npu?.steps).toEqual({
      'object-detection': { modelId: 'yolov9m-320-int8', settings: { conf: 0.3 } },
    })
    const gpu = rows.find((d) => d.key === 'openvino:gpu')
    expect(gpu?.steps).toBeUndefined()
  })

  it('setAgentInferenceDevices on an unknown agent seeds a bare entry', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.setAgentInferenceDevices({
      agentNodeId: 'new-agent',
      inferenceDevices: { 'edgetpu:usb': { enabled: true } },
    })
    const read = await addon.getAgentSettings({ agentNodeId: 'new-agent' })
    expect(read?.inferenceDevices).toEqual({ 'edgetpu:usb': { enabled: true } })
  })

  it('setAgentCapabilities persists flags and re-derives the enabled-node sets', async () => {
    const broker = makeFakeBroker('hub')
    broker.addNode('agent-a')
    // Fresh install: NO capability seed → hub-only default must hold.
    const { ctx } = makeFakeContext({ addonConfig: { moleculerBroker: broker } })
    addon = new PipelineOrchestratorAddon()
    const envelope = await addon.initialize(ctx)
    const dumpState = envelope?.actionHandlers?.['dumpState']
    if (!dumpState) throw new Error('expected dumpState handler')
    const dump = async () =>
      pipelineOrchestratorActions.dumpState.output.parse(await dumpState(undefined))

    // Default derivation: hub is capable of everything, agent-a of nothing.
    const before = await dump()
    expect(before.enabledNodes).toEqual(['hub'])
    expect(before.enabledDecoderNodes).toEqual(['hub'])
    expect(before.enabledAudioNodes).toEqual(['hub'])

    // Enable detect on agent-a — the derived sets widen. Decode has NO flag:
    // it follows detect (decode is co-located with its frame consumer).
    await addon.setAgentCapabilities({ agentNodeId: 'agent-a', detect: true })
    const persisted = await addon.getAgentSettings({ agentNodeId: 'agent-a' })
    expect(persisted?.detect).toBe(true)
    const after = await dump()
    expect(after.enabledNodes).toEqual(['agent-a', 'hub'])
    expect(after.enabledDecoderNodes).toEqual(['agent-a', 'hub'])
    // audio untouched → still hub-only.
    expect(after.enabledAudioNodes).toEqual(['hub'])

    // Disabling the hub's detect flag removes it from BOTH derived sets
    // (detect ⇒ decode — the sets are identical by construction).
    await addon.setAgentCapabilities({ agentNodeId: 'hub', detect: false })
    const afterHubOff = await dump()
    expect(afterHubOff.enabledNodes).toEqual(['agent-a'])
    expect(afterHubOff.enabledDecoderNodes).toEqual(['agent-a'])

    // A `null` patch resets a flag to the node default (agent-a → non-hub → off).
    await addon.setAgentCapabilities({ agentNodeId: 'agent-a', detect: null })
    const afterReset = await dump()
    expect(afterReset.enabledNodes).toEqual([])
    expect(afterReset.enabledDecoderNodes).toEqual([])
  })

  it('setAgentDecodeLimits persists a per-node decode budget and worker cap, and null clears each', async () => {
    // One cluster number for a 64 GB hub and a 16 GB Mac alike is the wrong
    // size on both; the node's own limits win over the cluster setting.
    const broker = makeFakeBroker('hub')
    broker.addNode('agent-a')
    const { ctx } = makeFakeContext({ addonConfig: { moleculerBroker: broker } })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)
    await addon.setAgentDecodeLimits({
      agentNodeId: 'agent-a',
      decodeBudgetMb: 6000,
      maxLiveDecodeWorkers: 5,
    })
    const set = await addon.getAgentSettings({ agentNodeId: 'agent-a' })
    expect(set?.decodeBudgetMb).toBe(6000)
    expect(set?.maxLiveDecodeWorkers).toBe(5)
    // An omitted key leaves the other alone; null clears.
    await addon.setAgentDecodeLimits({ agentNodeId: 'agent-a', maxLiveDecodeWorkers: null })
    const cleared = await addon.getAgentSettings({ agentNodeId: 'agent-a' })
    expect(cleared?.decodeBudgetMb).toBe(6000)
    expect(cleared?.maxLiveDecodeWorkers).toBeUndefined()
  })

  it('a stored legacy decode flag is IGNORED by derivation and stripped on the next capability write', async () => {
    const broker = makeFakeBroker('hub')
    broker.addNode('agent-a')
    // Legacy store: agent-a is detect-enabled but carries decode:false — the
    // old silent no-frame-source trap. Derivation must ignore it.
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        agentSettings: {
          'agent-a': { maxCameras: null, detect: true, decode: false },
        },
      },
    })
    addon = new PipelineOrchestratorAddon()
    const envelope = await addon.initialize(ctx)
    const dumpState = envelope?.actionHandlers?.['dumpState']
    if (!dumpState) throw new Error('expected dumpState handler')
    const dump = async () =>
      pipelineOrchestratorActions.dumpState.output.parse(await dumpState(undefined))

    // detect ⇒ decode: agent-a is decoder-eligible DESPITE decode:false.
    const before = await dump()
    expect(before.enabledNodes).toEqual(['agent-a', 'hub'])
    expect(before.enabledDecoderNodes).toEqual(['agent-a', 'hub'])

    // Any capability write strips the stale legacy flag from the store.
    await addon.setAgentCapabilities({ agentNodeId: 'agent-a', audio: true })
    const persisted = await addon.getAgentSettings({ agentNodeId: 'agent-a' })
    expect(persisted?.detect).toBe(true)
    expect(persisted?.decode).toBeUndefined()
  })

  it('setAgentCapabilities persists the ingest flag and re-derives enabledIngestNodes', async () => {
    const broker = makeFakeBroker('hub')
    broker.addNode('agent-a')
    // Fresh install: NO capability seed → hub-only default must hold.
    const { ctx } = makeFakeContext({ addonConfig: { moleculerBroker: broker } })
    addon = new PipelineOrchestratorAddon()
    const envelope = await addon.initialize(ctx)
    const dumpState = envelope?.actionHandlers?.['dumpState']
    if (!dumpState) throw new Error('expected dumpState handler')
    const dump = async () =>
      pipelineOrchestratorActions.dumpState.output.parse(await dumpState(undefined))

    // Default derivation: hub is ingest-capable by default, agent-a is not.
    const before = await dump()
    expect(before.enabledIngestNodes).toEqual(['hub'])

    // Enable ingest on agent-a — the derived set widens.
    await addon.setAgentCapabilities({ agentNodeId: 'agent-a', ingest: true })
    const persisted = await addon.getAgentSettings({ agentNodeId: 'agent-a' })
    expect(persisted?.ingest).toBe(true)
    const after = await dump()
    expect(after.enabledIngestNodes).toEqual(['agent-a', 'hub'])

    // Explicitly disabling the hub's ingest flag removes it (no hard-coded hub inclusion).
    await addon.setAgentCapabilities({ agentNodeId: 'hub', ingest: false })
    const afterHubOff = await dump()
    expect(afterHubOff.enabledIngestNodes).toEqual(['agent-a'])

    // A `null` patch resets a flag to the node default (agent-a → non-hub → off).
    await addon.setAgentCapabilities({ agentNodeId: 'agent-a', ingest: null })
    const afterReset = await dump()
    expect(afterReset.enabledIngestNodes).toEqual([])
  })
})
