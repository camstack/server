/**
 * D910 — a benchmark never loads a model into the live detection pool.
 *
 * 2026-10-22, hub: `benchmark.runPipelineTest` loaded `yolov9m-320-int8` into
 * the LIVE `openvino:gpu` worker; the iGPU compiler killed it three times in
 * 15 s and camera 101 lost detection and clip embeddings until the respawn.
 *
 * Pinned against the real provider, catalog and model manager; only the pools'
 * `loadModel`, the download and the executor's `run` are faked:
 *  - a one-shot benchmark call (image, no camera) loads into the BENCHMARK
 *    pool of its device and leaves the live pool untouched;
 *  - a camera's call (`deviceId`) still loads into the live pool;
 *  - a model the benchmark could not load is not backed off on the live
 *    device afterwards;
 *  - an EXCLUSIVE device (an Edge TPU opens in one process only) is the one
 *    exception: a second pool cannot open a Coral the cameras' pool holds, so
 *    its benchmark is served by the live pool instead of failing.
 */
import type {
  FrameResult,
  IInferenceEngine,
  IScopedLogger,
  PipelineStepInput,
  PoolModelConfig,
} from '@camstack/types'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assumeKnownClusterRowIsDefaults } from './fixtures/known-cluster-row.js'
import type { EngineFactory } from '../engine/engine-factory.js'
import { PipelineModelManager, type PoolModelSource } from '../engine/pipeline-model-manager.js'
import { SharedInferencePool } from '../engine/shared-inference-pool.js'
import type { ExecutableTree } from '../pipeline/tree-builder.js'
import { PipelineExecutor } from '../pipeline/executor.js'
import { DetectionPipelineProvider } from '../provider.js'
import { getDefaultModelForFormat, getStepDefinition } from '../registry/step-definitions.js'

interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly tags: Record<string, unknown>
  readonly meta: Record<string, unknown>
}

function captureLogger(sink: LoggedLine[]): IScopedLogger {
  const record =
    (level: string) =>
    (
      message: string,
      opts?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> },
    ): void => {
      sink.push({
        level,
        message,
        meta: opts?.meta ?? {},
        tags: opts?.tags ?? {},
      })
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** The pool is told the model by path: `/models/<modelId>`. */
const SOURCE: PoolModelSource = {
  buildConfig: (_stepId, modelId): PoolModelConfig => ({
    path: `/models/${modelId}`,
    inputSize: 320,
    preprocessMode: 'letterbox',
    postprocessor: 'yolo',
    confidence: 0.5,
  }),
  resolveDecode: () => ({ nmsIouThreshold: 0.45 }),
}

interface Pool {
  readonly factory: EngineFactory
  readonly loaded: () => string[]
}

function stubEngine(): IInferenceEngine {
  return {
    runtime: 'onnx',
    device: 'cpu',
    infer: async () => ({ inferenceMs: 1 }),
    dispose: async () => undefined,
  }
}

/** A real model manager over a pool whose `loadModel` records the model and fails the ones `failing` names. */
function makePool(log: IScopedLogger, deviceKey: string, failing: ReadonlySet<string>): Pool {
  const pool = new SharedInferencePool('/nonexistent/python', 'openvino', log, {
    device: 'gpu',
  })
  const loadModel = vi.fn(async (_index: number, config: PoolModelConfig) => {
    const modelId = config.path.replace('/models/', '')
    if (failing.has(modelId))
      throw new Error(`Failed to load model: ${modelId} CL_OUT_OF_RESOURCES`)
    return { loadMs: 1 }
  })
  vi.spyOn(pool, 'loadModel').mockImplementation(loadModel)
  const manager = new PipelineModelManager(pool, SOURCE, log, { deviceKey })
  const partial: Pick<
    EngineFactory,
    | 'needsPoolUpdate'
    | 'loadAdditional'
    | 'getStepVariant'
    | 'notePlacement'
    | 'entryForPool'
    | 'isReady'
    | 'dispose'
  > = {
    isReady: () => true,
    dispose: async () => undefined,
    needsPoolUpdate: (s) => manager.needsPoolUpdate(s),
    // No co-compiled set changes here (D724): the placement is pinned in
    // engine/__tests__/coral-cocompiled-set.spec.ts.
    notePlacement: () => ({ kind: 'unchanged' }),
    entryForPool: (_stepId, entry) => entry,
    loadAdditional: (steps) => manager.loadAdditional(steps),
    // The REAL (step, model) lookup (D658): a variant this pool never loaded
    // throws here exactly as it would in production; only the engine is a stub.
    getStepVariant: (stepId, modelId) => ({
      ...manager.getVariant(stepId, modelId),
      engine: stubEngine(),
    }),
  }
  return {
    // A structural stand-in for the three members the dispatch uses — the
    // test's documented type boundary (as in model-load-rejection-names-the-camera).
    factory: partial as EngineFactory,
    loaded: () => loadModel.mock.calls.map((c) => c[1].path.replace('/models/', '')),
  }
}

interface Harness {
  readonly provider: DetectionPipelineProvider
  readonly live: Pool
  readonly bench: Pool
  readonly benchBuilt: string[]
}

function harness(benchFailing: ReadonlySet<string> = new Set()): Harness {
  const lines: LoggedLine[] = []
  const log = captureLogger(lines)
  const provider = new DetectionPipelineProvider(
    {
      readAddonStore: async () => ({}),
      writeAddonStore: async () => undefined,
    },
    '/tmp/camstack-test-models-d910',
    log,
  )
  const live = makePool(log, 'openvino:gpu', new Set())
  const bench = makePool(log, 'bench:openvino:gpu', benchFailing)
  const benchBuilt: string[] = []
  provider['engineFactory'] = makePool(log, 'onnxruntime:cpu', new Set()).factory
  provider['ensureEngineFactory'] = async () => undefined
  provider['gateDetectionsByZoneRules'] = (_deviceId: number, result: FrameResult) => result
  provider['ensureDeviceProxy'] = async () => null
  provider['resolveDeviceFactory'] = async () => live.factory
  provider['createBenchmarkFactory'] = async (deviceKey: string) => {
    benchBuilt.push(deviceKey)
    return bench.factory
  }
  provider['resolveModelEntry'] = async (addonId: string, modelId: string) =>
    getStepDefinition(addonId).models.find((m) => m.id === modelId)
  provider['downloadWithRetry'] = async () => undefined
  vi.spyOn(PipelineExecutor.prototype, 'run').mockImplementation(async (tree: ExecutableTree) => {
    void tree
    const result: FrameResult = {
      kind: 'frame',
      frameId: 'f',
      deviceId: 104,
      timestamp: 1,
      width: 16,
      height: 16,
      detections: [],
    }
    return { result, trace: null }
  })
  return { provider, live, bench, benchBuilt }
}

async function tinyJpeg(): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

const GPU_OD = getDefaultModelForFormat('object-detection', 'openvino')
const TREE: readonly PipelineStepInput[] = [
  { addonId: 'object-detection', modelId: GPU_OD, enabled: true, children: [] },
]

beforeEach(() => {
  assumeKnownClusterRowIsDefaults()
  vi.useRealTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a benchmark never loads a model into the live pool', () => {
  it('a one-shot benchmark call loads into its own pool and leaves the live one untouched', async () => {
    const h = harness()
    await h.provider.runPipeline({
      steps: TREE,
      image: await tinyJpeg(),
      deviceKey: 'openvino:gpu',
      plane: 'full',
    })
    expect(h.bench.loaded()).toEqual([GPU_OD])
    expect(h.live.loaded()).toEqual([])
    expect(h.benchBuilt).toEqual(['openvino:gpu'])
  })

  it('a second benchmark call reuses the benchmark pool: warm, same device', async () => {
    const h = harness()
    const image = await tinyJpeg()
    for (let run = 0; run < 3; run++) {
      await h.provider.runPipeline({ steps: TREE, image, deviceKey: 'openvino:gpu', plane: 'full' })
    }
    expect(h.bench.loaded()).toEqual([GPU_OD])
  })

  it('a camera call still loads into the live pool', async () => {
    const h = harness()
    await h.provider.runPipeline({
      steps: TREE,
      image: await tinyJpeg(),
      deviceId: 104,
      deviceKey: 'openvino:gpu',
      plane: 'full',
    })
    expect(h.live.loaded()).toEqual([GPU_OD])
    expect(h.bench.loaded()).toEqual([])
    expect(h.benchBuilt).toEqual([])
  })

  it('a model the benchmark could not load is not backed off on the live device', async () => {
    const h = harness(new Set([GPU_OD]))
    const image = await tinyJpeg()
    await expect(
      h.provider.runPipeline({ steps: TREE, image, deviceKey: 'openvino:gpu', plane: 'full' }),
    ).rejects.toThrow()
    // The camera asks for the same model on the same device straight after.
    await expect(
      h.provider.runPipeline({
        steps: TREE,
        image,
        deviceId: 104,
        deviceKey: 'openvino:gpu',
        plane: 'full',
      }),
    ).resolves.toMatchObject({ rootModelId: GPU_OD })
    expect(h.live.loaded()).toEqual([GPU_OD])
  })

  it('an exclusive device (Edge TPU) is benchmarked through the live pool — a second pool cannot open it', async () => {
    const h = harness()
    const coralOd = getDefaultModelForFormat('object-detection', 'tflite')
    await h.provider.runPipeline({
      steps: [{ addonId: 'object-detection', modelId: coralOd, enabled: true, children: [] }],
      image: await tinyJpeg(),
      deviceKey: 'edgetpu:usb',
      plane: 'full',
    })
    expect(h.benchBuilt).toEqual([])
    expect(h.bench.loaded()).toEqual([])
    expect(h.live.loaded()).toEqual([coralOd])
  })
})
