/**
 * `FrameResult.packageLooked` follows the governor's decision THROUGH
 * `runInference` (fix round 1, review H4): the stamp must be computed from the
 * steps actually dispatched to the executor, not from a list that was never
 * the dispatch. With `withPackageLook(result, [])` the unit test stayed green
 * and every frame read "nobody looked".
 */
import type {
  FrameInput,
  FrameResult,
  PipelineStepInput,
  RunnerCameraConfig,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRunnerCameraConfig } from '../../__tests__/support/runner-camera-config.js'
import PipelineRunnerAddon from '../index.js'

/**
 * TEST TYPE BOUNDARY: `onInitialize` and `runInference` are private to the
 * addon; this is the same internals view the D657 dispatch spec uses to drive
 * one dispatch without a broker.
 */
interface AddonInternals {
  onInitialize(): Promise<unknown>
  runInference(deviceId: number, frame: FrameInput): Promise<FrameResult | null>
}
function asInternals(addon: PipelineRunnerAddon): AddonInternals {
  return addon as unknown as AddonInternals
}

const RESULT: FrameResult = {
  kind: 'frame',
  frameId: 'f',
  deviceId: 101,
  timestamp: 0,
  width: 640,
  height: 480,
  detections: [],
}

const FRAME: FrameInput = {
  data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  width: 640,
  height: 480,
  format: 'jpeg',
  timestamp: 1000,
}

const TREE: readonly PipelineStepInput[] = [
  { addonId: 'object-detection', enabled: true, children: [] },
  { addonId: 'package-detection', enabled: true, children: [] },
]

function makeCtx() {
  const runPipeline = vi.fn().mockResolvedValue(RESULT)
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
        runFrame: { mutate: vi.fn().mockResolvedValue(RESULT) },
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
  return { ctx, runPipeline }
}

const CONFIG: RunnerCameraConfig = makeRunnerCameraConfig({
  deviceId: 101,
  motionCooldownMs: 10_000,
  steps: TREE,
})

describe('packageLooked through runInference', () => {
  let addon: PipelineRunnerAddon

  beforeEach(() => {
    addon = new PipelineRunnerAddon()
  })

  afterEach(async () => {
    await addon.shutdown().catch(() => {})
  })

  it('stamps the frame the governor dispatched the package step on, and not the next one', async () => {
    const { ctx, runPipeline } = makeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    await addon.attachCamera(CONFIG)

    // First frame: the safety poll is due — the step is dispatched.
    const first = await asInternals(addon).runInference(101, FRAME)
    const firstSteps: readonly PipelineStepInput[] = runPipeline.mock.calls[0]?.[0]?.steps ?? []
    expect(firstSteps.map((s) => s.addonId)).toContain('package-detection')
    expect(first?.packageLooked).toBe(true)

    // Immediately after: the governor gates the step off — nobody looked.
    const second = await asInternals(addon).runInference(101, FRAME)
    const secondSteps: readonly PipelineStepInput[] = runPipeline.mock.calls[1]?.[0]?.steps ?? []
    expect(secondSteps.map((s) => s.addonId)).not.toContain('package-detection')
    expect(second?.packageLooked).toBeUndefined()
  })
})
