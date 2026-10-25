/**
 * D650 — `resolveAttachPipeline`, the one owner of an attach's steps, on a
 * Coral + GPU node whose DEFAULT engine format is tflite. Before it existed the
 * standing path resolved on that default format before election: faces were
 * dropped even for a camera the balancer then put on the GPU.
 */
import type { RunnerCameraConfig } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type AttachPipeline,
  type AttachPipelineOutcome,
  resolveAttachPipeline,
  resolveAttachPipelineIfCatalogCached,
  withAttachPipeline,
} from '../attach-pipeline.js'
import {
  CORAL,
  CORAL_GPU_ELIGIBLE,
  CORAL_GPU_SEGMENTATION_CATALOG,
  GPU,
  NODE,
  makeRealStore,
  seedCoralGpuNode,
} from './attach-pipeline-fixtures.js'

const DEVICE_ID = 77

/** The pipeline of a resolved outcome; a refusal fails the test. */
function attached(outcome: AttachPipelineOutcome): AttachPipeline {
  if (outcome.kind !== 'resolved') throw new Error(`expected a pipeline, got ${outcome.kind}`)
  return outcome.pipeline
}

describe('resolveAttachPipeline (D650)', () => {
  it('GPU elected on a tflite-default node: face kept, provisioned from the GPU base', async () => {
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)

    const p = attached(
      await resolveAttachPipeline(
        {
          deviceId: DEVICE_ID,
          nodeId: NODE,
          deviceKey: GPU,
          eligible: CORAL_GPU_ELIGIBLE,
          caps: {},
        },
        store,
      ),
    )

    expect(p.deviceKey).toBe(GPU)
    const root = p.steps.find((s) => s.addonId === 'object-detection')
    const face = (root?.children ?? []).find((c) => c.addonId === 'face-detection')
    expect(face?.modelId).toBe('scrfd-10g')
  })

  it('Coral elected: face kept through the roster, and the GPU entry carries its provisioning', async () => {
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)

    const p = attached(
      await resolveAttachPipeline(
        {
          deviceId: DEVICE_ID,
          nodeId: NODE,
          deviceKey: CORAL,
          eligible: CORAL_GPU_ELIGIBLE,
          caps: {},
        },
        store,
      ),
    )

    const root = p.steps.find((s) => s.addonId === 'object-detection')
    expect(root?.modelId).toBe('ssd-edgetpu')
    expect((root?.children ?? []).map((c) => c.addonId)).toEqual(['face-detection'])
    const cpu = (p.inferenceDevices ?? []).find((d) => d.deviceKey === GPU)
    expect(cpu?.steps).toBeDefined()
    expect(cpu?.steps?.['face-detection']).toEqual({ modelId: 'scrfd-10g' })
  })

  it('Coral elected with segmentation ON and no tflite build: attaches with its root, logs the segmentation skip', async () => {
    // Round 4. Segmentation is an opt-in ROOT the Coral cannot run. Round 3
    // counted it among `droppedRoots` and refused the whole camera — pending
    // as `root-unrunnable` forever, because the election guard checks only
    // object-detection and would elect the Coral again every round. On main
    // the step was simply skipped, and that is what must happen.
    const { store, warns } = makeRealStore(CORAL_GPU_SEGMENTATION_CATALOG)
    await seedCoralGpuNode(store)
    await store.writeCameraSettings(DEVICE_ID, { stepToggles: { segmentation: true } })

    const outcome = await resolveAttachPipeline(
      {
        deviceId: DEVICE_ID,
        nodeId: NODE,
        deviceKey: CORAL,
        eligible: CORAL_GPU_ELIGIBLE,
        caps: {},
      },
      store,
    )

    const p = attached(outcome)
    expect(p.steps.map((s) => s.addonId)).toEqual(['object-detection'])
    const skip = warns().find((w) =>
      w.startsWith('pipeline steps gated on but not provisioned on this node — skipped'),
    )
    expect(skip).toContain('segmentation:root-not-runnable-on-elected-device')
  })

  it('refuses ONLY for the camera root: an elected device with no object-detection build', async () => {
    const { store } = makeRealStore(CORAL_GPU_SEGMENTATION_CATALOG)
    await seedCoralGpuNode(store)
    // `coreml:ane` — a format the root ships no build for; the roster could
    // run it, but a root is never jumped.
    const outcome = await resolveAttachPipeline(
      {
        deviceId: DEVICE_ID,
        nodeId: NODE,
        deviceKey: 'coreml:ane',
        eligible: { ...CORAL_GPU_ELIGIBLE, 'coreml:ane': 1 },
        caps: {},
      },
      store,
    )
    expect(outcome).toEqual({
      kind: 'root-refused',
      nodeId: NODE,
      deviceKey: 'coreml:ane',
      droppedRoots: ['object-detection'],
    })
  })

  it('the cached entry point on its own: a cold cache is catalog-unavailable, the next call resolves', async () => {
    // Pre-ship review M2: the resolve-side cache gate, not masked by the
    // election gate that sits in front of it on the placement path.
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)
    const input = {
      deviceId: DEVICE_ID,
      nodeId: NODE,
      deviceKey: CORAL,
      eligible: CORAL_GPU_ELIGIBLE,
      caps: {},
    }
    const cold = await resolveAttachPipelineIfCatalogCached(input, store)
    expect(cold).toEqual({ kind: 'catalog-unavailable', nodeId: NODE })
    // The cold read started ONE background refresh; once it lands, the same
    // call resolves without ever having waited.
    await vi.waitFor(async () => {
      expect((await resolveAttachPipelineIfCatalogCached(input, store)).kind).toBe('resolved')
    })
  })

  it('provisions from ONE read of each settings blob, whatever the roster size', async () => {
    const { store, blobReads } = makeRealStore()
    await seedCoralGpuNode(store)
    // A THREE-device roster: the per-device reads it replaced cost 2 + 2×3 = 8.
    const input = {
      deviceId: DEVICE_ID,
      nodeId: NODE,
      deviceKey: CORAL,
      eligible: { ...CORAL_GPU_ELIGIBLE, 'openvino:npu': 1 },
      caps: {},
    }
    await resolveAttachPipeline(input, store) // warm the catalog cache
    // What the structure resolve alone costs, with the same arguments…
    const r0 = blobReads()
    await store.resolvePipelineForDevice(DEVICE_ID, NODE, CORAL, [GPU, 'openvino:npu'])
    const structureReads = blobReads() - r0
    // …and what the whole attach costs: provisioning adds exactly the 2 blobs.
    const r1 = blobReads()
    await resolveAttachPipeline(input, store)
    expect(blobReads() - r1 - structureReads).toBe(2)
  })

  it("a camera's settings travel with a manually jumped step — there is no per-device camera layer (D927)", async () => {
    const { store } = makeRealStore()
    await store.writeAgentSettings(NODE, {
      maxCameras: null,
      inferenceDevices: {
        [CORAL]: { enabled: true, steps: { 'face-detection': { jumpDeviceKey: GPU } } },
        [GPU]: { enabled: true },
      },
    })
    await store.writeCameraStepSettings(DEVICE_ID, 'face-detection', { minFaceSize: 50 })
    const outcome = await resolveAttachPipeline(
      {
        deviceId: DEVICE_ID,
        nodeId: NODE,
        deviceKey: CORAL,
        eligible: CORAL_GPU_ELIGIBLE,
        caps: {},
      },
      store,
    )
    expect(outcome.kind).toBe('resolved')
    if (outcome.kind !== 'resolved') return
    const gpu = outcome.pipeline.inferenceDevices?.find((d) => d.deviceKey === GPU)
    expect(gpu?.steps?.['face-detection']?.settings).toMatchObject({ minFaceSize: 50 })
  })
})

describe('withAttachPipeline', () => {
  it('a stale deviceKey / roster / provisioned tree never survives the spread', () => {
    const stale: RunnerCameraConfig = {
      deviceId: DEVICE_ID,
      deviceKey: 'openvino:npu',
      inferenceDevices: [{ deviceKey: 'openvino:npu', weight: 1, maxSessions: null }],
      steps: [{ addonId: 'object-detection', enabled: true, modelId: 'stale-pin' }],
      audio: { enabled: true },
      motionCooldownMs: 1,
      motionFps: 1,
      detectionFps: 1,
      motionStreamId: 's',
      detectionStreamId: 's',
      motionSources: [],
      pipelineEnabled: true,
      zones: [],
      detectionMode: 'always-on',
      audioMode: 'disabled',
      onboardMotionDrivesAnalyzer: true,
      preRollInferenceEnabled: false,
      preRollInferenceFrames: 0,
      occupancyRecheckEnabled: false,
      occupancyRecheckSec: 0,
      occupancyRecheckFrames: 0,
    }
    const next = withAttachPipeline(stale, {
      steps: [{ addonId: 'object-detection', enabled: true }],
      audio: null,
    })
    expect(next.deviceKey).toBeUndefined()
    expect(next.inferenceDevices).toBeUndefined()
    expect(next.steps).toEqual([{ addonId: 'object-detection', enabled: true }])
    expect(next.audio).toBeNull()
    expect(next.motionStreamId).toBe('s')
  })
})
