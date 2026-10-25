/**
 * D657 — the elected pool loads only what runs on it.
 *
 * 2026-09-27, hub: sessions elected onto the Coral (`edgetpu:usb`) sent their
 * whole tree on the frame plane. The face subtree rode along only to pre-warm
 * the pool; it resolved to `scrfd-2.5g` for tflite (no such build), the load
 * of the whole set failed, and the root SSD was backed off with it —
 * `runInference failed` on every frame, while the runner had already jumped
 * the face step to `openvino:gpu`.
 *
 * The frame-plane dispatch now carries a detail subtree only when the same
 * placement the detail plane takes (`placeDetailStep`) keeps it on the
 * elected device.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeRunnerCameraConfig } from '../../__tests__/support/runner-camera-config.js'
import PipelineRunnerAddon from '../index.js'
import type {
  RunnerCameraConfig,
  RunnerInferenceDevice,
  FrameInput,
  FrameResult,
  PipelineStepInput,
} from '@camstack/types'

interface AddonInternals {
  onInitialize(): Promise<unknown>
  runInference(deviceId: number, frame: FrameInput): Promise<FrameResult | null>
  perDeviceAttachedCounts(): Map<string, number>
}

function asInternals(addon: PipelineRunnerAddon): AddonInternals {
  return addon as unknown as AddonInternals
}

function makeFrameInput(): FrameInput {
  return {
    data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    width: 640,
    height: 480,
    format: 'jpeg',
    timestamp: 1000,
  }
}

function makePipelineResult(): FrameResult {
  return {
    kind: 'frame',
    frameId: 'test-frame',
    deviceId: 1,
    timestamp: 0,
    width: 640,
    height: 480,
    detections: [],
    debug: { totalInferenceMs: 10 },
  }
}

function makeFakeCtx() {
  const runFrame = vi.fn().mockResolvedValue(makePipelineResult())
  const runPipeline = vi.fn().mockResolvedValue(makePipelineResult())
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this
    }),
    withTags: vi.fn(function (this: unknown) {
      return this
    }),
  }
  const ctx = {
    id: 'pipeline-runner',
    logger,
    kernel: { localNodeId: 'hub' },
    eventBus: { emit: vi.fn(), subscribe: () => () => {}, getRecent: () => [] },
    api: {
      pipelineExecutor: {
        runFrame: { mutate: runFrame },
        runPipeline: { mutate: runPipeline },
      },
      streamBroker: {},
    },
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      writeAddonStore: vi.fn(async () => undefined),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
  }
  return { ctx, runFrame, runPipeline, logger }
}

function makeConfig(patch: Partial<RunnerCameraConfig> = {}): RunnerCameraConfig {
  return makeRunnerCameraConfig({
    deviceId: 42,
    motionCooldownMs: 10_000,
    motionSources: ['onboard'],
    ...patch,
  })
}

const FACE_SUBTREE: PipelineStepInput = {
  addonId: 'face-detection',
  enabled: true,
  children: [{ addonId: 'face-embedding', enabled: true, children: [] }],
}

const TREE: readonly PipelineStepInput[] = [
  { addonId: 'object-detection', enabled: true, children: [FACE_SUBTREE] },
]

/** The hub's roster on 2026-09-27: the Coral and the two OpenVINO devices. */
const ROSTER: readonly RunnerInferenceDevice[] = [
  { deviceKey: 'edgetpu:usb', weight: 1, maxSessions: null },
  { deviceKey: 'openvino:gpu', weight: 1, maxSessions: null, steps: {} },
  { deviceKey: 'openvino:npu', weight: 1, maxSessions: null, steps: {} },
]

function childIds(steps: readonly PipelineStepInput[]): string[] {
  return steps.flatMap((s) => (s.children ?? []).map((c) => c.addonId))
}

describe('the elected pool loads only what runs on it (D657)', () => {
  let addon: PipelineRunnerAddon

  beforeEach(() => {
    addon = new PipelineRunnerAddon()
  })

  afterEach(async () => {
    await addon.shutdown().catch(() => {
      /* ignore */
    })
  })

  async function dispatchOnce(patch: Partial<RunnerCameraConfig>): Promise<{
    steps: readonly PipelineStepInput[]
    logger: ReturnType<typeof makeFakeCtx>['logger']
  }> {
    const { ctx, runPipeline, logger } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    await addon.attachCamera(makeConfig({ deviceId: 104, steps: TREE, ...patch }))
    await asInternals(addon).runInference(104, makeFrameInput())
    expect(runPipeline).toHaveBeenCalledTimes(1)
    const input = runPipeline.mock.calls[0]![0] as { steps: readonly PipelineStepInput[] }
    return { steps: input.steps, logger }
  }

  it('a Coral-elected camera does not send the face subtree the runner jumps to openvino', async () => {
    const { steps, logger } = await dispatchOnce({
      deviceKey: 'edgetpu:usb',
      inferenceDevices: [...ROSTER],
    })
    expect(steps.map((s) => s.addonId)).toEqual(['object-detection'])
    expect(childIds(steps)).toEqual([])
    const said = logger.info.mock.calls.filter(
      (c) => c[0] === 'detail steps not loaded on the elected pool — they run elsewhere',
    )
    expect(said).toHaveLength(1)
    expect(said[0]![1]).toMatchObject({
      tags: { deviceId: 104 },
      meta: { electedDeviceKey: 'edgetpu:usb', steps: ['face-detection'] },
    })
  })

  it('a GPU-elected camera keeps the face subtree: it runs there, so it pre-warms there', async () => {
    const { steps } = await dispatchOnce({
      deviceKey: 'openvino:gpu',
      inferenceDevices: [...ROSTER],
    })
    expect(childIds(steps)).toEqual(['face-detection'])
  })

  it('a manual jumpDeviceKey is honoured too: the step is not pre-warmed on the device it leaves', async () => {
    const { steps } = await dispatchOnce({
      deviceKey: 'openvino:gpu',
      inferenceDevices: [...ROSTER],
      steps: [
        {
          addonId: 'object-detection',
          enabled: true,
          children: [{ ...FACE_SUBTREE, jumpDeviceKey: 'openvino:npu' }],
        },
      ],
    })
    expect(childIds(steps)).toEqual([])
  })

  it('a camera with no roster sends its tree as before', async () => {
    const { steps } = await dispatchOnce({ deviceKey: 'edgetpu:usb' })
    expect(childIds(steps)).toEqual(['face-detection'])
  })

  it('Coral + GPU/NPU at their cap: the face subtree has no candidate, is left out, and the root runs', async () => {
    const { ctx, runPipeline } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    const capped: RunnerInferenceDevice[] = ROSTER.map((d) =>
      d.deviceKey === 'edgetpu:usb' ? { ...d } : { ...d, maxSessions: 1 },
    )
    await addon.attachCamera(
      makeConfig({
        deviceId: 700,
        steps: TREE,
        deviceKey: 'openvino:gpu',
        inferenceDevices: capped,
      }),
    )
    await addon.attachCamera(
      makeConfig({
        deviceId: 701,
        steps: TREE,
        deviceKey: 'openvino:npu',
        inferenceDevices: capped,
      }),
    )
    await addon.attachCamera(
      makeConfig({
        deviceId: 104,
        steps: TREE,
        deviceKey: 'edgetpu:usb',
        inferenceDevices: capped,
      }),
    )
    await asInternals(addon).runInference(104, makeFrameInput())
    const input = runPipeline.mock.calls.at(-1)![0] as { steps: readonly PipelineStepInput[] }
    expect(input.steps.map((s) => s.addonId)).toEqual(['object-detection'])
    expect(childIds(input.steps)).toEqual([])
  })

  it('a roster of one: no placement and no per-frame count of attached cameras', async () => {
    const { ctx } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    await addon.attachCamera(
      makeConfig({
        deviceId: 104,
        steps: TREE,
        deviceKey: 'edgetpu:usb',
        inferenceDevices: [ROSTER[0]!],
      }),
    )
    const counts = vi.spyOn(asInternals(addon), 'perDeviceAttachedCounts')
    await asInternals(addon).runInference(104, makeFrameInput())
    expect(counts).not.toHaveBeenCalled()
  })

  it('says so again on every state change: Coral → GPU → Coral logs twice', async () => {
    const { ctx, logger } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    for (const deviceKey of ['edgetpu:usb', 'openvino:gpu', 'edgetpu:usb']) {
      await addon.attachCamera(
        makeConfig({ deviceId: 104, steps: TREE, deviceKey, inferenceDevices: [...ROSTER] }),
      )
      await asInternals(addon).runInference(104, makeFrameInput())
      await asInternals(addon).runInference(104, makeFrameInput())
    }
    const said = logger.info.mock.calls.filter(
      (c) => c[0] === 'detail steps not loaded on the elected pool — they run elsewhere',
    )
    expect(said).toHaveLength(2)
  })

  it('a custom face model with a tflite build, pinned for the Coral, stays on the Coral (merged catalog)', async () => {
    const { ctx, runPipeline } = makeFakeCtx()
    const custom = {
      stepId: 'face-detection',
      entry: {
        id: 'my-coral-face',
        name: 'My Coral face',
        description: 'operator-registered',
        inputSize: { width: 320, height: 320 },
        labels: [{ id: 'face', name: 'Face' }],
        preprocessMode: 'letterbox' as const,
        postprocessor: 'ssd' as const,
        formats: { tflite: { url: 'camstack-local://my-coral-face.tflite', sizeMB: 5 } },
      },
    }
    const api = {
      ...ctx.api,
      addons: { listCapabilityProviders: { query: vi.fn(async () => [{ isActive: true }]) } },
      customModelRegistry: { listModels: { query: vi.fn(async () => [custom]) } },
    }
    Object.defineProperty(addon, 'ctx', { value: { ...ctx, api }, configurable: true })
    await asInternals(addon).onInitialize()
    await addon.attachCamera(
      makeConfig({
        deviceId: 104,
        deviceKey: 'edgetpu:usb',
        inferenceDevices: [...ROSTER],
        steps: [
          {
            addonId: 'object-detection',
            enabled: true,
            children: [
              { addonId: 'face-detection', modelId: 'my-coral-face', enabled: true, children: [] },
            ],
          },
        ],
      }),
    )
    await asInternals(addon).runInference(104, makeFrameInput())
    const input = runPipeline.mock.calls.at(-1)![0] as { steps: readonly PipelineStepInput[] }
    expect(childIds(input.steps)).toEqual(['face-detection'])
  })
})
