/**
 * `runPipeline({ replay: true })` — the camera's own root structure over
 * STORED pixels, pinned (D56, D646).
 *
 * A replay sends a recorded JPEG (`image`), not a live frame, so without this
 * flag it took the benchmark branch: no camera zone gate, and a silent model
 * substitution when the node could not serve the requested model. With it:
 *  - the model is served exactly or the call refuses BEFORE any pool is built;
 *  - a `deviceKey` the capability gate would fall back from is refused;
 *  - the camera's detection-stage zone gate runs, as it does live;
 *  - nothing is emitted on the camera's live trace stream.
 * And every frame result names the root model that produced it.
 */
import type {
  FrameResult,
  IEventBus,
  IInferenceEngine,
  IScopedLogger,
  PipelineRunInput,
  PipelineStepInput,
  SystemEvent,
} from '@camstack/types'
import { EventCategory } from '@camstack/types'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineFactory } from '../engine/engine-factory.js'
import { deviceKeyOf } from '../engine/resolve-device-engine.js'
import { PipelineExecutor } from '../pipeline/executor.js'
import { DetectionPipelineProvider } from '../provider.js'
import { getDefaultModelForFormat, getStepDefinition } from '../registry/step-definitions.js'

function stubLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Harness {
  readonly provider: DetectionPipelineProvider
  readonly events: SystemEvent[]
  readonly ensureEngineCalls: { count: number }
  readonly gatedFor: number[]
}

function harness(): Harness {
  const events: SystemEvent[] = []
  const bus: IEventBus = {
    emit: (e: SystemEvent) => {
      events.push(e)
    },
    subscribe: () => () => undefined,
    getRecent: () => [],
  }
  const provider = new DetectionPipelineProvider(
    { readAddonStore: async () => ({}), writeAddonStore: async () => undefined },
    '/tmp/camstack-test-models',
    stubLogger(),
    bus,
  )
  const ensureEngineCalls = { count: 0 }
  // A real factory object that never spawns Python: its model reads are
  // stubbed below, so the call reaches the executor with no pool behind it.
  provider['ensureEngineFactory'] = async () => {
    ensureEngineCalls.count += 1
    provider['engineFactory'] = new EngineFactory({
      engine: provider['currentEngine'],
      modelsDir: '/tmp/camstack-test-models',
      logger: stubLogger(),
      pythonPath: '',
    })
  }
  const gatedFor: number[] = []
  provider['ensureDeviceProxy'] = async () => null
  provider['gateDetectionsByZoneRules'] = (deviceId: number, result: FrameResult) => {
    gatedFor.push(deviceId)
    return { ...result, detections: [] }
  }
  return { provider, events, ensureEngineCalls, gatedFor }
}

function stubEngine(): IInferenceEngine {
  return {
    runtime: 'onnx',
    device: 'cpu',
    infer: async () => ({ inferenceMs: 1 }),
    dispose: async () => undefined,
  }
}

function executorReturns(detections: FrameResult['detections']): void {
  vi.spyOn(EngineFactory.prototype, 'needsPoolUpdate').mockReturnValue(false)
  vi.spyOn(EngineFactory.prototype, 'getStepVariant').mockImplementation((_stepId, modelId) => ({
    engine: stubEngine(),
    modelId,
    poolIndex: 0,
  }))
  vi.spyOn(PipelineExecutor.prototype, 'run').mockResolvedValue({
    result: {
      kind: 'frame',
      frameId: 'f',
      deviceId: 101,
      timestamp: 1,
      width: 16,
      height: 16,
      detections,
    },
    trace: null,
  })
}

async function tinyJpeg(): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

/** An OpenVINO-only model: the onnx node (the default before init) cannot serve it. */
function openvinoOnlyModel(): string {
  const def = getStepDefinition('object-detection')
  const entry = def.models.find((m) => m.formats['openvino'] && !m.formats['onnx'])
  if (entry === undefined) throw new Error('catalog has no openvino-only detector to test with')
  return entry.id
}

const ONNX_DEFAULT = (): string => getDefaultModelForFormat('object-detection', 'onnx')

function steps(modelId: string): readonly PipelineStepInput[] {
  return [{ addonId: 'object-detection', modelId, enabled: true }]
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runPipeline replay — the model is pinned (D56)', () => {
  it('refuses a model the node would substitute, before any pool is built', async () => {
    const h = harness()
    const input: PipelineRunInput = {
      steps: steps(openvinoOnlyModel()),
      image: await tinyJpeg(),
      deviceId: 101,
      plane: 'frame',
      replay: true,
    }
    await expect(h.provider.runPipeline(input)).rejects.toThrow(/model-not-servable/)
    expect(h.ensureEngineCalls.count).toBe(0)
  })

  it('the SAME call without `replay` still substitutes — the live behaviour is untouched', async () => {
    const h = harness()
    executorReturns([])
    const input: PipelineRunInput = {
      steps: steps(openvinoOnlyModel()),
      image: await tinyJpeg(),
      deviceId: 101,
      plane: 'frame',
    }
    const result = await h.provider.runPipeline(input)
    expect(result.rootModelId).toBe(ONNX_DEFAULT())
  })

  it('refuses a device pool that cannot serve the pinned model, before any pool is built', async () => {
    // The onnx default on a Coral: either the capability gate would fall the
    // call back off `edgetpu:usb` (device-not-servable) or the tflite pool
    // would run its own format default (model-not-servable). Which one depends
    // on the catalog of the day; that it REFUSES does not. The pure verdicts
    // are pinned one by one in `model-pin.spec.ts`.
    const h = harness()
    const input: PipelineRunInput = {
      steps: steps(ONNX_DEFAULT()),
      image: await tinyJpeg(),
      deviceId: 101,
      plane: 'frame',
      deviceKey: 'edgetpu:usb',
      replay: true,
    }
    await expect(h.provider.runPipeline(input)).rejects.toThrow(/(device|model)-not-servable/)
    expect(h.ensureEngineCalls.count).toBe(0)
  })
})

describe('runPipeline replay — the camera structure applies (D646)', () => {
  it('runs the camera zone gate on a recorded JPEG, and stamps the root model', async () => {
    const h = harness()
    executorReturns([])
    const result = await h.provider.runPipeline({
      steps: steps(ONNX_DEFAULT()),
      image: await tinyJpeg(),
      deviceId: 101,
      plane: 'frame',
      replay: true,
    })
    expect(h.gatedFor).toEqual([101])
    expect(result.rootModelId).toBe(ONNX_DEFAULT())
    // …and the inference DEVICE it ran on, beside the model: a stored track
    // keeps where it opened and closed (a session can hop device, D916).
    expect(result.rootDeviceKey).toBe(deviceKeyOf(h.provider['currentEngine']))
    expect(result.rootDeviceKey?.length ?? 0).toBeGreaterThan(0)
  })

  it('a plain benchmark image run (no replay) is NOT zone-gated — unchanged', async () => {
    const h = harness()
    executorReturns([])
    await h.provider.runPipeline({
      steps: steps(ONNX_DEFAULT()),
      image: await tinyJpeg(),
      deviceId: 101,
      plane: 'frame',
    })
    expect(h.gatedFor).toEqual([])
  })

  it('emits nothing on the camera live trace stream', async () => {
    const h = harness()
    executorReturns([])
    await h.provider.runPipeline({
      steps: steps(ONNX_DEFAULT()),
      image: await tinyJpeg(),
      deviceId: 101,
      plane: 'frame',
      replay: true,
    })
    expect(h.events.filter((e) => e.category === EventCategory.PipelineTrace)).toEqual([])
  })

  it('fans no pipeline.progress out on the bus — a replay runs a frame after another, like a camera (D290)', async () => {
    const h = harness()
    executorReturns([])
    await h.provider.runPipeline({
      steps: steps(ONNX_DEFAULT()),
      image: await tinyJpeg(),
      deviceId: 101,
      plane: 'frame',
      replay: true,
    })
    expect(h.events.filter((e) => e.category === EventCategory.PipelineProgress)).toEqual([])
  })

  it('tells the executor it is a replay, and a plain run that it is live (log channel)', async () => {
    const h = harness()
    executorReturns([])
    const run = vi.mocked(PipelineExecutor.prototype.run)
    const base = {
      steps: steps(ONNX_DEFAULT()),
      image: await tinyJpeg(),
      deviceId: 101,
      plane: 'frame',
    } as const
    await h.provider.runPipeline({ ...base, replay: true })
    await h.provider.runPipeline(base)
    expect(run.mock.calls.map((c) => c[6]?.occasion)).toEqual(['replay', 'live'])
  })
})

describe('runPipeline stamps the root identity it RAN (D925)', () => {
  it('names the root step and the device pool beside the root model', async () => {
    const h = harness()
    executorReturns([])
    const result = await h.provider.runPipeline({
      steps: steps(ONNX_DEFAULT()),
      image: await tinyJpeg(),
      deviceId: 101,
      plane: 'frame',
    })
    expect(result.rootModelId).toBe(ONNX_DEFAULT())
    expect(result.rootStepId).toBe('object-detection')
    // No `deviceKey` asked ⇒ the node's own engine, named, never anonymous.
    const engine = h.provider['currentEngine']
    expect(result.rootDeviceKey).toBe(
      engine.device ? `${engine.backend}:${engine.device}` : engine.backend,
    )
  })
})
