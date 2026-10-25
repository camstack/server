/**
 * Tests for the orchestrator's device-aware `getNodeInferenceDevices` cap —
 * the MERGED view that joins a node's actual inference accelerators (probed
 * live via a node-pinned `platformProbe.getCapabilities`) with the per-node
 * opt-in (`enabled`/`weight`) and the per-device default detection model.
 *
 * The fake context has no `platformProbe` namespace, so each test patches
 * `ctx.api.platformProbe` in — the addon reads `this.ctx.api` live at call
 * time. `platform-probe` is targeted by the `{ nodeId }` cap INPUT (a routing
 * selector for the singleton mount); the local node ('hub') is called with no
 * arg, so the mock defaults `input?.nodeId` to 'hub'.
 */
import { describe, it, expect, afterEach } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import { makeFakeContext, makeFakeBroker, enabledNodesFromBroker } from './e2e-helpers.js'
import {
  defaultModelIdForDevice,
  parseDeviceKey,
  mergeInferenceDevices,
  resolveInferenceDeviceEligibility,
  inferenceDeviceCaps,
  makeRootCapabilityGuard,
} from '../inference-device-model.js'
import type { AddonContext, InferenceDeviceDescriptor, PipelineSchema } from '@camstack/types'

/**
 * Minimal `PipelineSchema` carrying a single object-detection root whose models
 * declare builds for exactly `objDetFormats` — enough for the balancer's
 * root-capability guard (which reads only the object-detection model set).
 */
function catalogWithObjectDetectionFormats(objDetFormats: readonly string[]): PipelineSchema {
  return {
    availableEngines: [],
    selectedEngine: { runtime: 'python', backend: 'cpu', format: 'onnx' },
    slots: [
      {
        id: 'detector',
        label: 'Detector',
        priority: 0,
        parentSlot: null,
        addons: [
          {
            id: 'object-detection',
            name: 'Object Detection',
            slot: 'detector',
            inputClasses: [],
            outputClasses: ['person', 'vehicle', 'animal'],
            childSlots: [],
            models: [
              {
                id: 'ssd-mobilenet-v2-coco-edgetpu',
                name: 'ssd',
                formats: Object.fromEntries(
                  objDetFormats.map((f) => [f, { downloaded: false, sizeMB: 1 }]),
                ),
              },
            ],
            defaultModelId: 'ssd-mobilenet-v2-coco-edgetpu',
            defaultConfidence: 0.5,
          },
        ],
      },
    ],
  }
}

function descriptor(
  key: string,
  backend: string,
  device: string,
  format: InferenceDeviceDescriptor['format'],
  available: boolean,
): InferenceDeviceDescriptor {
  return { key, backend, device, format, runtime: 'python', score: 50, available }
}

/**
 * Patch a fake `platformProbe.getCapabilities` onto `ctx.api`. `byNode` maps a
 * nodeId → the device list that node's probe returns; a missing entry (or an
 * explicit `null`) makes the probe REJECT (an unreachable node).
 */
function patchPlatformProbe(
  ctx: AddonContext,
  byNode: Readonly<Record<string, readonly InferenceDeviceDescriptor[] | null>>,
): void {
  const query = (input?: {
    readonly nodeId?: string
  }): Promise<{ devices: readonly InferenceDeviceDescriptor[] }> => {
    const node = input?.nodeId ?? 'hub'
    const devices = byNode[node]
    if (!devices) return Promise.reject(new Error(`probe unreachable: ${node}`))
    return Promise.resolve({ devices })
  }
  const api = ctx.api as unknown as Record<string, unknown>
  api.platformProbe = { getCapabilities: { query } }
}

describe('inference-device-model — pure default model map', () => {
  it('maps each deviceKey to the executor default model id', () => {
    expect(defaultModelIdForDevice('openvino:npu')).toBe('yolov9m-320-int8')
    expect(defaultModelIdForDevice('openvino:gpu')).toBe('yolov9m-320-int8')
    expect(defaultModelIdForDevice('openvino:cpu')).toBe('yolov9m-320-int8')
    expect(defaultModelIdForDevice('edgetpu:usb')).toBe('yolov9s-320-edgetpu')
    expect(defaultModelIdForDevice('edgetpu:usb:1')).toBe('yolov9s-320-edgetpu')
    expect(defaultModelIdForDevice('coreml:all')).toBe('yolov9m-320')
    expect(defaultModelIdForDevice('cpu')).toBe('yolo26n')
    expect(defaultModelIdForDevice('cuda:gpu')).toBe('yolo26n')
    expect(defaultModelIdForDevice('mystery:thing')).toBe('yolo26n')
  })

  it('mergeInferenceDevices — accelerators opt-OUT (auto-on), CPU opt-IN (auto-off), explicit wins', () => {
    const probed: InferenceDeviceDescriptor[] = [
      descriptor('openvino:npu', 'openvino', 'npu', 'openvino', true),
      descriptor('openvino:gpu', 'openvino', 'gpu', 'openvino', true),
      descriptor('cpu', 'cpu', 'cpu', 'onnx', true),
    ]
    // gpu explicitly opted OUT; cpu explicitly opted IN; npu unconfigured.
    const merged = mergeInferenceDevices(probed, {
      'openvino:gpu': { enabled: false },
      cpu: { enabled: true },
    })
    const byKey = Object.fromEntries(merged.map((d) => [d.key, d]))
    expect(byKey['openvino:npu']!.enabled).toBe(true) // accelerator, unconfigured → auto-on
    expect(byKey['openvino:gpu']!.enabled).toBe(false) // explicit opt-out
    expect(byKey['cpu']!.enabled).toBe(true) // explicit opt-in wins over the CPU default-off
  })

  it('mergeInferenceDevices — CPU defaults DISABLED when unconfigured (fallback, not balanced)', () => {
    const merged = mergeInferenceDevices([descriptor('cpu', 'cpu', 'cpu', 'onnx', true)], {})
    expect(merged[0]!.enabled).toBe(false)
  })

  it('mergeInferenceDevices — openvino:cpu (AMD) defaults DISABLED like the cpu floor', () => {
    // AMD emits openvino:cpu so int8 IRs have a home; it is still a CPU pool
    // and must not auto-join the balancer next to onnx:webgpu.
    const merged = mergeInferenceDevices(
      [
        descriptor('onnx:webgpu', 'onnx', 'webgpu', 'onnx', true),
        descriptor('openvino:cpu', 'openvino', 'cpu', 'openvino', true),
        descriptor('cpu', 'cpu', 'cpu', 'onnx', true),
      ],
      {},
    )
    const byKey = Object.fromEntries(merged.map((d) => [d.key, d]))
    expect(byKey['onnx:webgpu']!.enabled).toBe(true)
    expect(byKey['openvino:cpu']!.enabled).toBe(false)
    expect(byKey['cpu']!.enabled).toBe(false)
  })

  it('mergeInferenceDevices — a Coral Edge TPU with no stored entry is ENABLED like any accelerator (D912)', () => {
    // D39 made it opt-in after the 2026-08-01 2.4 fps incident (an equal share
    // for a slow, weaker-model device). D912 answers that with speed-
    // proportional automatic weights and the YOLOv9 Edge TPU default.
    const merged = mergeInferenceDevices(
      [descriptor('edgetpu:usb', 'edgetpu', 'usb', 'tflite', true)],
      {},
    )
    expect(merged[0]!.enabled).toBe(true)
  })

  it('mergeInferenceDevices — every PCIe Coral unit is enabled by default too; a CPU stays off (D912)', () => {
    const merged = mergeInferenceDevices(
      [
        descriptor('edgetpu:pci', 'edgetpu', 'pci', 'tflite', true),
        descriptor('edgetpu:pci:1', 'edgetpu', 'pci:1', 'tflite', true),
        descriptor('cpu', 'cpu', 'cpu', 'onnx', true),
      ],
      {},
    )
    expect(merged.map((d) => [d.key, d.enabled])).toEqual([
      ['cpu', false],
      ['edgetpu:pci', true],
      ['edgetpu:pci:1', true],
    ])
    expect(defaultModelIdForDevice('edgetpu:pci:1')).toBe('yolov9s-320-edgetpu')
  })

  it('mergeInferenceDevices — an explicit stored enabled:false still opts the Coral OUT', () => {
    const merged = mergeInferenceDevices(
      [descriptor('edgetpu:usb', 'edgetpu', 'usb', 'tflite', true)],
      { 'edgetpu:usb': { enabled: false } },
    )
    expect(merged[0]!.enabled).toBe(false)
  })

  it('mergeInferenceDevices — an explicit stored enabled:true still opts the Coral IN', () => {
    const merged = mergeInferenceDevices(
      [descriptor('edgetpu:usb', 'edgetpu', 'usb', 'tflite', true)],
      { 'edgetpu:usb': { enabled: true } },
    )
    expect(merged[0]!.enabled).toBe(true)
  })

  it('mergeInferenceDevices — a stored enabled:false on an opt-OUT accelerator survives the merge; an absent key still takes the policy default (2026-08-01)', () => {
    // The admin UI used to PRUNE disabled rows from the wholesale
    // `setAgentInferenceDevices` write, so "switch it off" stored NOTHING for
    // an opt-OUT accelerator — and the absent key resolved back to
    // `autoDefault: true`: the toggle read OFF while the device kept taking
    // sessions. The UI now writes an explicit `enabled: false`; this test pins
    // the model half of the contract: an explicit false is durable (never
    // overridden by the default), while a key that was NEVER configured — new
    // hardware — still takes the policy default and must not arrive disabled.
    const probed: InferenceDeviceDescriptor[] = [
      descriptor('openvino:gpu', 'openvino', 'gpu', 'openvino', true),
      descriptor('openvino:npu', 'openvino', 'npu', 'openvino', true),
    ]
    const stored = { 'openvino:gpu': { enabled: false, weight: 50 } }
    const byKey = Object.fromEntries(mergeInferenceDevices(probed, stored).map((d) => [d.key, d]))
    expect(byKey['openvino:gpu']!.enabled).toBe(false) // explicit OFF is durable
    expect(byKey['openvino:gpu']!.weight).toBe(50) // config survives for re-enable
    expect(byKey['openvino:npu']!.enabled).toBe(true) // never-configured → policy default
    // …and the dispatcher's candidate set honours it: the switched-off device
    // is excluded as 'disabled', never silently re-enrolled.
    const { eligible, excluded } = resolveInferenceDeviceEligibility(probed, stored)
    expect(Object.keys(eligible)).toEqual(['openvino:npu'])
    expect(excluded).toContainEqual({ key: 'openvino:gpu', reason: 'disabled', format: 'openvino' })
  })

  it('resolveInferenceDeviceEligibility — an unconfigured Coral enters the eligible set; a stored enabled:false keeps it out (D912)', () => {
    const probed: InferenceDeviceDescriptor[] = [
      descriptor('openvino:npu', 'openvino', 'npu', 'openvino', true),
      descriptor('openvino:gpu', 'openvino', 'gpu', 'openvino', true),
      descriptor('edgetpu:usb', 'edgetpu', 'usb', 'tflite', true),
    ]
    const open = resolveInferenceDeviceEligibility(probed, {})
    expect(Object.keys(open.eligible).toSorted()).toEqual([
      'edgetpu:usb',
      'openvino:gpu',
      'openvino:npu',
    ])
    const { eligible, excluded } = resolveInferenceDeviceEligibility(probed, {
      'edgetpu:usb': { enabled: false },
    })
    expect(Object.keys(eligible).toSorted()).toEqual(['openvino:gpu', 'openvino:npu'])
    expect(excluded).toContainEqual({ key: 'edgetpu:usb', reason: 'disabled', format: 'tflite' })
  })

  it('resolveInferenceDeviceEligibility — enabled AND available only; CPU excluded by default', () => {
    const probed: InferenceDeviceDescriptor[] = [
      descriptor('openvino:npu', 'openvino', 'npu', 'openvino', true),
      descriptor('openvino:gpu', 'openvino', 'gpu', 'openvino', true),
      descriptor('cpu', 'cpu', 'cpu', 'onnx', true),
    ]
    const stored = {
      'openvino:npu': { enabled: true, weight: 2 },
      'openvino:gpu': { enabled: false }, // disabled → excluded
      'edgetpu:usb': { enabled: true }, // stored-only, not probed → unavailable → excluded
    }
    // cpu is opt-in (unconfigured → off) → excluded; only the enabled accelerator survives.
    expect(resolveInferenceDeviceEligibility(probed, stored).eligible).toEqual({
      'openvino:npu': 2,
    })
  })

  it('resolveInferenceDeviceEligibility — empty probe (unreachable) yields no eligible devices', () => {
    expect(
      resolveInferenceDeviceEligibility([], { 'openvino:npu': { enabled: true } }).eligible,
    ).toEqual({})
  })

  // A device dropped from the candidate set used to vanish SILENTLY, which is
  // indistinguishable from a device that was never probed at all — the exact
  // ambiguity that hid an enabled-but-never-chosen accelerator. Every drop must
  // now name itself and its reason.
  it('resolveInferenceDeviceEligibility — names every dropped device and WHY', () => {
    const probed: InferenceDeviceDescriptor[] = [
      descriptor('openvino:npu', 'openvino', 'npu', 'openvino', true),
      descriptor('openvino:gpu', 'openvino', 'gpu', 'openvino', true),
      descriptor('edgetpu:usb', 'edgetpu', 'usb', 'tflite', true),
      descriptor('cpu', 'cpu', 'cpu', 'onnx', true),
    ]
    const stored = {
      'openvino:npu': { enabled: true },
      'openvino:gpu': { enabled: false }, // operator opted out
      'edgetpu:usb': { enabled: true }, // enabled, available, but no tflite root
      'coreml:ane': { enabled: true }, // stored-only — the probe never saw it
    }
    const guard = makeRootCapabilityGuard(catalogWithObjectDetectionFormats(['onnx', 'openvino']))
    const { eligible, excluded } = resolveInferenceDeviceEligibility(probed, stored, guard)
    expect(eligible).toEqual({ 'openvino:npu': 1 })
    expect(excluded).toEqual([
      // cpu is opt-IN, so an unconfigured cpu reads as operator-disabled.
      { key: 'coreml:ane', reason: 'unavailable', format: 'coreml' },
      { key: 'cpu', reason: 'disabled', format: 'onnx' },
      { key: 'edgetpu:usb', reason: 'cannot-host-camera-root', format: 'tflite' },
      { key: 'openvino:gpu', reason: 'disabled', format: 'openvino' },
    ])
  })

  it('resolveInferenceDeviceEligibility — a device both disabled and unplugged reads as disabled', () => {
    // First-reason-wins: re-enabling is the action that changes anything, so
    // that is the reason reported.
    const { excluded } = resolveInferenceDeviceEligibility([], {
      'edgetpu:usb': { enabled: false },
    })
    expect(excluded).toEqual([{ key: 'edgetpu:usb', reason: 'disabled', format: 'tflite' }])
  })

  it('resolveInferenceDeviceEligibility — nothing dropped ⇒ an empty exclusion list', () => {
    const probed: InferenceDeviceDescriptor[] = [
      descriptor('openvino:npu', 'openvino', 'npu', 'openvino', true),
      descriptor('openvino:gpu', 'openvino', 'gpu', 'openvino', true),
    ]
    expect(resolveInferenceDeviceEligibility(probed, {}).excluded).toEqual([])
  })

  it('makeRootCapabilityGuard — a format runs the root iff object-detection has a build for it', () => {
    const guard = makeRootCapabilityGuard(catalogWithObjectDetectionFormats(['onnx', 'openvino']))
    expect(guard('onnx')).toBe(true)
    expect(guard('openvino')).toBe(true)
    expect(guard('tflite')).toBe(false) // no tflite build for the root → can't host a camera
  })

  it('makeRootCapabilityGuard — allows tflite once the catalog carries the Coral root model', () => {
    const guard = makeRootCapabilityGuard(
      catalogWithObjectDetectionFormats(['onnx', 'openvino', 'tflite']),
    )
    expect(guard('tflite')).toBe(true)
  })

  it('makeRootCapabilityGuard — fails OPEN when the catalog has no object-detection slot', () => {
    const guard = makeRootCapabilityGuard({
      availableEngines: [],
      selectedEngine: { runtime: 'python', backend: 'cpu', format: 'onnx' },
      slots: [],
    })
    expect(guard('tflite')).toBe(true)
    expect(guard('anything')).toBe(true)
  })

  it('resolveInferenceDeviceEligibility — the guard EXCLUDES a root-incapable device (edgetpu, no tflite root)', () => {
    const probed: InferenceDeviceDescriptor[] = [
      descriptor('openvino:npu', 'openvino', 'npu', 'openvino', true),
      descriptor('edgetpu:usb', 'edgetpu', 'usb', 'tflite', true),
    ]
    const stored = {
      'openvino:npu': { enabled: true, weight: 2 },
      'edgetpu:usb': { enabled: true },
    }
    // Catalog's object-detection root has NO tflite build → the Coral cannot host
    // a camera root and is dropped from the eligible set even though it is
    // enabled AND available.
    const guard = makeRootCapabilityGuard(catalogWithObjectDetectionFormats(['onnx', 'openvino']))
    expect(resolveInferenceDeviceEligibility(probed, stored, guard).eligible).toEqual({
      'openvino:npu': 2,
    })
    // Without the guard (cold-start / no catalog) both survive — fail-open.
    expect(resolveInferenceDeviceEligibility(probed, stored).eligible).toEqual({
      'openvino:npu': 2,
      'edgetpu:usb': 1,
    })
  })

  it('resolveInferenceDeviceEligibility — the guard KEEPS edgetpu once the catalog carries the tflite root', () => {
    const probed: InferenceDeviceDescriptor[] = [
      descriptor('openvino:npu', 'openvino', 'npu', 'openvino', true),
      descriptor('edgetpu:usb', 'edgetpu', 'usb', 'tflite', true),
    ]
    const stored = {
      'openvino:npu': { enabled: true, weight: 2 },
      'edgetpu:usb': { enabled: true },
    }
    const guard = makeRootCapabilityGuard(
      catalogWithObjectDetectionFormats(['onnx', 'openvino', 'tflite']),
    )
    expect(resolveInferenceDeviceEligibility(probed, stored, guard).eligible).toEqual({
      'openvino:npu': 2,
      'edgetpu:usb': 1,
    })
  })

  it('mergeInferenceDevices carries maxSessions through (null when absent)', () => {
    const probed: InferenceDeviceDescriptor[] = [
      descriptor('openvino:npu', 'openvino', 'npu', 'openvino', true),
      descriptor('openvino:gpu', 'openvino', 'gpu', 'openvino', true),
    ]
    const merged = mergeInferenceDevices(probed, {
      'openvino:npu': { enabled: true, maxSessions: 3 },
    })
    const byKey = Object.fromEntries(merged.map((d) => [d.key, d]))
    expect(byKey['openvino:npu']!.maxSessions).toBe(3)
    expect(byKey['openvino:gpu']!.maxSessions).toBeNull()
  })

  it('inferenceDeviceCaps returns only devices with an explicit positive cap', () => {
    expect(
      inferenceDeviceCaps({
        'openvino:npu': { enabled: true, maxSessions: 2 },
        'openvino:gpu': { enabled: true }, // no cap → unlimited → omitted
        'edgetpu:usb': { enabled: false, maxSessions: 1 },
      }),
    ).toEqual({ 'openvino:npu': 2, 'edgetpu:usb': 1 })
  })

  it('parseDeviceKey splits backend/device + derives format', () => {
    expect(parseDeviceKey('openvino:npu')).toEqual({
      backend: 'openvino',
      device: 'npu',
      format: 'openvino',
    })
    expect(parseDeviceKey('edgetpu:usb:1')).toEqual({
      backend: 'edgetpu',
      device: 'usb:1',
      format: 'tflite',
    })
    expect(parseDeviceKey('cpu')).toEqual({ backend: 'cpu', device: 'cpu', format: 'onnx' })
  })
})

describe('PipelineOrchestrator — getNodeInferenceDevices', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('merges the live probe with the opt-in — incl. a disabled-but-configured device and a stored-only (unavailable) device', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // The node actually HAS: npu + gpu + cpu (all available).
    patchPlatformProbe(ctx, {
      hub: [
        descriptor('openvino:npu', 'openvino', 'npu', 'openvino', true),
        descriptor('openvino:gpu', 'openvino', 'gpu', 'openvino', true),
        descriptor('cpu', 'cpu', 'cpu', 'onnx', true),
      ],
    })

    // Opt-in: npu enabled+weighted, gpu configured-but-DISABLED, and a
    // stored-only edgetpu key the probe does NOT return (removed/absent HW).
    await addon.setAgentInferenceDevices({
      agentNodeId: 'hub',
      inferenceDevices: {
        'openvino:npu': { enabled: true, weight: 2 },
        'openvino:gpu': { enabled: false },
        'edgetpu:usb': { enabled: true },
      },
    })

    const result = await addon.getNodeInferenceDevices({ nodeId: 'hub' })
    expect(result.reachable).toBe(true)
    const byKey = Object.fromEntries(result.devices.map((d) => [d.key, d]))

    // npu — probed available, enabled with the stored weight, v9 int8 default.
    expect(byKey['openvino:npu']).toEqual({
      key: 'openvino:npu',
      backend: 'openvino',
      device: 'npu',
      format: 'openvino',
      available: true,
      presence: 'present',
      enabled: true,
      weight: 2,
      maxSessions: null,
      defaultModelId: 'yolov9m-320-int8',
      // Enabled + available + can host the root ⇒ a camera-root candidate.
      exclusion: null,
    })
    // gpu — probed available but DISABLED in the opt-in, weight defaults to 1.
    expect(byKey['openvino:gpu']).toMatchObject({
      available: true,
      enabled: false,
      weight: 1,
      defaultModelId: 'yolov9m-320-int8',
    })
    // cpu — probed available, NOT configured → CPU is opt-IN, so it stays
    // DISABLED by default (the accelerators auto-enable; CPU is the fallback).
    expect(byKey['cpu']).toMatchObject({
      available: true,
      enabled: false,
      weight: 1,
      defaultModelId: 'yolo26n',
    })
    // edgetpu — stored-only (probe didn't return it) → surfaced as unavailable.
    expect(byKey['edgetpu:usb']).toMatchObject({
      backend: 'edgetpu',
      device: 'usb',
      format: 'tflite',
      available: false,
      // The probe ANSWERED without it: absent, not merely unavailable (D919).
      presence: 'absent',
      enabled: true,
      weight: 1,
      defaultModelId: 'yolov9s-320-edgetpu',
      exclusion: 'unavailable',
    })
    // The DISABLED gpu and the opt-IN-only cpu each name their own reason, so
    // the UI never has to deduce why a device is not in the rotation.
    expect(byKey['openvino:gpu']?.exclusion).toBe('disabled')
    expect(byKey['cpu']?.exclusion).toBe('disabled')
  })

  it('an unreachable node returns reachable:false + best-effort stored-only devices (never throws)', async () => {
    const broker = makeFakeBroker('hub')
    broker.addNode('agent-x')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // agent-x has a stored opt-in but its probe REJECTS (offline).
    await addon.setAgentInferenceDevices({
      agentNodeId: 'agent-x',
      inferenceDevices: { 'openvino:npu': { enabled: true } },
    })
    patchPlatformProbe(ctx, { hub: [], 'agent-x': null })

    const result = await addon.getNodeInferenceDevices({ nodeId: 'agent-x' })
    expect(result.reachable).toBe(false)
    expect(result.nodeId).toBe('agent-x')
    // The configured device still surfaces (available:false) so the UI shows it.
    expect(result.devices).toEqual([
      {
        key: 'openvino:npu',
        backend: 'openvino',
        device: 'npu',
        format: 'openvino',
        available: false,
        // The probe did not answer: nothing is claimed about the hardware.
        presence: 'unknown',
        enabled: true,
        weight: 1,
        maxSessions: null,
        defaultModelId: 'yolov9m-320-int8',
        // Enabled but the probe could not confirm it — the reason an operator
        // needs, and the one an `enabled:true` row cannot show by itself.
        exclusion: 'unavailable',
      },
    ])
  })

  it('an unreachable node with no stored opt-in returns an empty device list', async () => {
    const broker = makeFakeBroker('hub')
    broker.addNode('agent-y')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    patchPlatformProbe(ctx, { hub: [], 'agent-y': null })

    const result = await addon.getNodeInferenceDevices({ nodeId: 'agent-y' })
    expect(result).toEqual({ nodeId: 'agent-y', reachable: false, devices: [] })
  })
})
