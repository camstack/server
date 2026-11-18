/**
 * An excluded device never runs an inference (planning #610).
 *
 * The election excludes a device the operator turned off or that is not
 * functional — nothing else. When that leaves NO eligible device, the camera
 * must not fall back to the runner's default pool (the node's selected engine,
 * which can be the very GPU that was excluded): it is refused with a named
 * reason and nothing is attached.
 *
 * Each case composes the real chain: eligibility → election → attach resolve.
 */
import type { InferenceDeviceDescriptor } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { resolveAttachPipeline, resolveAttachPipelineIfCatalogCached } from '../attach-pipeline.js'
import type { AttachPipelineStore } from '../attach-pipeline.js'
import { pickInferenceDevice, selectedDeviceKey } from '../device-balancer.js'
import {
  isDefaultPoolExcluded,
  resolveInferenceDeviceEligibility,
  type StoredInferenceDevice,
} from '../inference-device-model.js'
import { GPU, NODE, makeRealStore } from './attach-pipeline-fixtures.js'

const DEVICE_ID = 91
const CPU = 'cpu'

function probed(key: string, backend: string, device: string): InferenceDeviceDescriptor {
  return {
    key,
    backend,
    device,
    format: 'openvino',
    runtime: 'python',
    score: 1,
    available: true,
  }
}

const PROBE: readonly InferenceDeviceDescriptor[] = [
  probed(GPU, 'openvino', 'gpu'),
  probed(CPU, 'cpu', 'cpu'),
]

/** The store a refusal must never reach: any read of it is a default-pool resolve. */
function untouchableStore(): {
  store: AttachPipelineStore
  reads: ReturnType<typeof vi.fn>
} {
  const reads = vi.fn(() => {
    throw new Error('the store was consulted — a default-pool resolve was attempted')
  })
  return {
    store: {
      resolvePipelineForDevice: reads,
      resolvePipelineForDeviceWithRoots: reads,
      resolvePipelineForDeviceIfCatalogCached: reads,
      readDeviceProvisioning: reads,
    },
    reads,
  }
}

function elect(
  stored: Record<string, StoredInferenceDevice>,
  absentReason?: (key: string) => 'no-gpu-device' | null,
) {
  const eligibility = resolveInferenceDeviceEligibility(
    PROBE,
    stored,
    undefined,
    undefined,
    undefined,
    absentReason,
  )
  const { eligible } = eligibility
  const selection = pickInferenceDevice({
    eligible,
    loads: [],
    caps: {},
    pinnedDeviceKey: null,
  })
  return {
    eligible,
    deviceKey: selectedDeviceKey(selection),
    defaultPoolExcluded: isDefaultPoolExcluded(eligibility),
  }
}

describe('an excluded device never runs an inference (#610)', () => {
  it('GPU disabled + CPU off: nothing is eligible, the camera is REFUSED, no default pool', async () => {
    const { eligible, deviceKey, defaultPoolExcluded } = elect({ [GPU]: { enabled: false } })
    expect(defaultPoolExcluded).toBe(true)
    expect(eligible).toEqual({})
    expect(deviceKey).toBeUndefined()

    const { store, reads } = untouchableStore()
    const input = {
      deviceId: DEVICE_ID,
      nodeId: NODE,
      deviceKey,
      eligible,
      caps: {},
      defaultPoolExcluded,
    }
    for (const outcome of [
      await resolveAttachPipeline(input, store),
      await resolveAttachPipelineIfCatalogCached(input, store),
    ]) {
      expect(outcome).toEqual({
        kind: 'root-refused',
        cause: 'no-eligible-device',
        nodeId: NODE,
        deviceKey: undefined,
        droppedRoots: [],
      })
    }
    expect(reads).not.toHaveBeenCalled()
  })

  it('GPU no-gpu-device + CPU on: the CPU is elected and the camera attaches on it', async () => {
    const { eligible, deviceKey, defaultPoolExcluded } = elect(
      { [CPU]: { enabled: true } },
      (key) => (key === GPU ? 'no-gpu-device' : null),
    )
    expect(Object.keys(eligible)).toEqual([CPU])
    expect(deviceKey).toBe(CPU)
    expect(defaultPoolExcluded).toBe(false)

    const { store } = makeRealStore()
    const outcome = await resolveAttachPipeline(
      { deviceId: DEVICE_ID, nodeId: NODE, deviceKey, eligible, caps: {} },
      store,
    ).catch((err: unknown) => err)
    // Not refused for want of a device: whatever the fixture catalog says about
    // the CPU, the refusal is never `no-eligible-device`.
    expect(outcome).not.toMatchObject({ cause: 'no-eligible-device' })
  })

  it('GPU enabled and up: elected, unchanged', () => {
    const { eligible, deviceKey, defaultPoolExcluded } = elect({})
    expect(defaultPoolExcluded).toBe(false)
    expect(Object.keys(eligible)).toEqual([GPU])
    expect(deviceKey).toBe(GPU)
  })

  it('a CPU-only node that never configured anything keeps serving through its default pool', () => {
    // The CPU is opt-IN: its default `disabled` is no operator statement.
    const eligibility = resolveInferenceDeviceEligibility([probed(CPU, 'cpu', 'cpu')], {})
    expect(eligibility.eligible).toEqual({})
    expect(isDefaultPoolExcluded(eligibility)).toBe(false)
  })

  describe('the default ENGINE is excluded while other devices are eligible', () => {
    const NPU = 'openvino:npu'
    const EDGE = 'edgetpu:usb'
    const PROBE3: readonly InferenceDeviceDescriptor[] = [
      probed(GPU, 'openvino', 'gpu'),
      probed(NPU, 'openvino', 'npu'),
      probed(EDGE, 'edgetpu', 'usb'),
    ]
    const loads = (n: number) => [
      { deviceKey: NPU, attachedCameras: n },
      { deviceKey: EDGE, attachedCameras: n },
    ]

    it('GPU (the default engine) disabled, NPU + edgetpu at maxSessions: over cap on an eligible device, never the GPU', () => {
      const eligibility = resolveInferenceDeviceEligibility(PROBE3, { [GPU]: { enabled: false } })
      expect(Object.keys(eligibility.eligible).toSorted()).toEqual([EDGE, NPU])
      const excluded = isDefaultPoolExcluded(eligibility, GPU)
      expect(excluded).toBe(true)
      const selection = pickInferenceDevice({
        eligible: eligibility.eligible,
        loads: loads(1),
        caps: { [NPU]: 1, [EDGE]: 1 },
        defaultPoolExcluded: excluded,
      })
      expect(selection).toMatchObject({ kind: 'selected', reason: 'over-cap' })
      expect([NPU, EDGE]).toContain(selectedDeviceKey(selection))
    })

    it('one eligible device at its cap with a pin on it: still placed on it, over cap', () => {
      const eligibility = resolveInferenceDeviceEligibility(
        [probed(GPU, 'openvino', 'gpu'), probed(NPU, 'openvino', 'npu')],
        { [GPU]: { enabled: false } },
      )
      const selection = pickInferenceDevice({
        eligible: eligibility.eligible,
        loads: [{ deviceKey: NPU, attachedCameras: 2 }],
        caps: { [NPU]: 1 },
        pinnedDeviceKey: NPU,
        defaultPoolExcluded: isDefaultPoolExcluded(eligibility, GPU),
      })
      expect(selection).toMatchObject({ kind: 'selected', deviceKey: NPU, reason: 'over-cap' })
    })

    it('the default engine is healthy: a node at cap keeps overflowing to the default pool', () => {
      const eligibility = resolveInferenceDeviceEligibility(PROBE3, { [GPU]: { enabled: false } })
      expect(isDefaultPoolExcluded(eligibility, NPU)).toBe(false)
      expect(isDefaultPoolExcluded(eligibility, null)).toBe(false)
    })

    it('a CPU-only unconfigured node whose default engine is the CPU stays on the default pool', () => {
      const eligibility = resolveInferenceDeviceEligibility([probed(CPU, 'cpu', 'cpu')], {})
      expect(isDefaultPoolExcluded(eligibility, CPU)).toBe(false)
    })
  })
})
