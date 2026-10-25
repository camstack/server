/**
 * D657 — a step loads on the pool that runs it, and a step that cannot load
 * costs that step only.
 *
 * 2026-09-27, hub: the Coral (`edgetpu:usb`) was elected for "sala da pranzo"
 * and "hall". Its frame-plane dispatch loaded `[object-detection/ssd-…,
 * face-detection/yunet-2023mar]` as ONE set: face-detection had been kept on the
 * Coral because a LEGACY face stub ships a tflite build, and it resolved to
 * `yunet-2023mar`, which ships none. The set failed, the failure was charged to
 * every model in it, and the root SSD was backed off with it — `runInference
 * failed` on every frame, while the runner had already jumped the face step to
 * `openvino:gpu`.
 *
 * Pinned here, against the real provider, catalog, resolution and model
 * manager; only the pools' `loadModel`, the model download and the executor's
 * `run` are faked:
 *  - the Coral pool loads the root only; the face subtree loads on the GPU
 *    pool when the detail plane dispatches it there, and both calls succeed;
 *  - a step whose model has no build for the pool's format is dropped from
 *    its dispatch by name, the root runs, and the root is never backed off.
 */
import type {
  FrameResult,
  IInferenceEngine,
  IScopedLogger,
  ModelCatalogEntry,
  PipelineDefaultStep,
  PipelineStepInput,
  PoolModelConfig,
} from '@camstack/types'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assumeKnownClusterRowIsDefaults } from './fixtures/known-cluster-row.js'
import type { EngineFactory } from '../engine/engine-factory.js'
import { PipelineModelManager, type PoolModelSource } from '../engine/pipeline-model-manager.js'
import { SharedInferencePool } from '../engine/shared-inference-pool.js'
import type { ExecutableStep, ExecutableTree } from '../pipeline/tree-builder.js'
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
    'needsPoolUpdate' | 'loadAdditional' | 'getStepVariant' | 'notePlacement' | 'entryForPool'
  > = {
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
  readonly lines: LoggedLine[]
  readonly pools: Readonly<Record<string, Pool>>
  readonly trees: ExecutableTree[]
  /** Model ids every pool refuses to load. */
  readonly failing: Set<string>
}

function harness(): Harness {
  const lines: LoggedLine[] = []
  const log = captureLogger(lines)
  const provider = new DetectionPipelineProvider(
    {
      readAddonStore: async () => ({}),
      writeAddonStore: async () => undefined,
    },
    '/tmp/camstack-test-models-d657',
    log,
  )
  const failing = new Set<string>()
  const pools: Record<string, Pool> = {
    'edgetpu:usb': makePool(log, 'edgetpu:usb', failing),
    'openvino:gpu': makePool(log, 'openvino:gpu', failing),
    // The node's own engine: the provider boots on the ONNX floor (onnx/cpu).
    default: makePool(log, 'onnxruntime:cpu', failing),
  }
  provider['engineFactory'] = pools['default']!.factory
  provider['ensureEngineFactory'] = async () => undefined
  provider['gateDetectionsByZoneRules'] = (_deviceId: number, result: FrameResult) => result
  provider['ensureDeviceProxy'] = async () => null
  // A call with no camera is a benchmark and loads into a pool of its own
  // (D910): here it is the same fake as the device's, so these specs keep
  // pinning the load policy and not the pool it lands in.
  provider['createBenchmarkFactory'] = async (deviceKey: string) => {
    const pool = pools[deviceKey]
    if (pool === undefined) throw new Error(`no pool for ${deviceKey}`)
    return pool.factory
  }
  provider['resolveDeviceFactory'] = async (deviceKey: string) => {
    const pool = pools[deviceKey]
    if (pool === undefined) throw new Error(`no pool for ${deviceKey}`)
    return pool.factory
  }
  // The REAL catalog entry, so a model with no build for the pool's format
  // fails exactly as it did live; the network is the only thing faked.
  provider['resolveModelEntry'] = async (addonId: string, modelId: string) =>
    getStepDefinition(addonId).models.find((m) => m.id === modelId)
  provider['downloadWithRetry'] = async () => undefined
  const trees: ExecutableTree[] = []
  vi.spyOn(PipelineExecutor.prototype, 'run').mockImplementation(async (tree) => {
    trees.push(tree)
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
  return { provider, lines, pools, trees, failing }
}

async function tinyJpeg(): Promise<Uint8Array> {
  const buf = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

/** Every step id in an executable tree. */
function treeIds(tree: ExecutableTree): string[] {
  const walk = (nodes: readonly ExecutableStep[]): string[] =>
    nodes.flatMap((n) => [n.stepId, ...walk(n.children)])
  return walk(tree.roots)
}

const SSD = getDefaultModelForFormat('object-detection', 'tflite')

const FACE_SUBTREE: PipelineStepInput = {
  addonId: 'face-detection',
  enabled: true,
  children: [{ addonId: 'face-embedding', enabled: true, children: [] }],
}

/** The camera tree exactly as the attach sends it for a Coral-elected session. */
const CORAL_TREE: readonly PipelineStepInput[] = [
  { addonId: 'object-detection', enabled: true, children: [FACE_SUBTREE] },
]

beforeEach(() => {
  // The cluster row is answered (D658): these specs are about WHERE a step loads.
  assumeKnownClusterRowIsDefaults()
  vi.useRealTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a jumped step loads on its TARGET pool, never on the elected one', () => {
  it('Coral-elected: the Coral loads the SSD only, the GPU loads the face models, and both dispatches run', async () => {
    const h = harness()
    const image = await tinyJpeg()

    // The frame plane, as a runner WITHOUT the D657 roster filter still sends
    // it (the provider's own prune is the backstop): the whole tree.
    await expect(
      h.provider.runPipeline({
        steps: CORAL_TREE,
        image,
        deviceId: 104,
        deviceKey: 'edgetpu:usb',
        plane: 'frame',
      }),
    ).resolves.toMatchObject({ rootModelId: SSD })
    expect(h.pools['edgetpu:usb']!.loaded()).toEqual([SSD])

    // The detail plane: the runner jumped the face subtree to the GPU with the
    // GPU's provisioning (here: the openvino format defaults).
    await expect(
      h.provider.runPipeline({
        steps: [FACE_SUBTREE],
        image,
        deviceId: 104,
        deviceKey: 'openvino:gpu',
        plane: 'full',
      }),
    ).resolves.toBeDefined()
    expect(h.pools['openvino:gpu']!.loaded().toSorted()).toEqual(
      [
        getDefaultModelForFormat('face-detection', 'openvino'),
        getDefaultModelForFormat('face-embedding', 'openvino'),
      ].toSorted(),
    )
    // Nothing face-shaped ever reached the Coral.
    expect(h.pools['edgetpu:usb']!.loaded()).toEqual([SSD])
    expect(h.lines.filter((l) => l.level === 'error')).toEqual([])
    expect(h.lines.filter((l) => l.message === 'model load for dispatch failed')).toEqual([])
  })
})

describe('a step that cannot load costs that step only', () => {
  const GPU_OD = getDefaultModelForFormat('object-detection', 'openvino')
  const GPU_FACE = getDefaultModelForFormat('face-detection', 'openvino')
  const TREE: readonly PipelineStepInput[] = [
    {
      addonId: 'object-detection',
      modelId: GPU_OD,
      enabled: true,
      children: [{ addonId: 'face-detection', enabled: true, children: [] }],
    },
  ]

  it('the root runs without the step, the step is named, and the root is never backed off', async () => {
    const h = harness()
    h.failing.add(GPU_FACE)
    const image = await tinyJpeg()
    const run = (): Promise<FrameResult> =>
      h.provider.runPipeline({
        steps: TREE,
        image,
        deviceId: 104,
        deviceKey: 'openvino:gpu',
        plane: 'full',
      })

    await expect(run()).resolves.toMatchObject({ rootModelId: GPU_OD })
    // The executor ran the tree WITHOUT the step that did not load.
    expect(treeIds(h.trees[0]!)).toEqual(['object-detection'])
    const lost = h.lines.filter((l) => l.message === 'model load for dispatch failed')
    expect(lost).toHaveLength(1)
    expect(lost[0]!.tags).toEqual({ deviceId: 104 })
    expect(lost[0]!.meta).toMatchObject({
      deviceKey: 'openvino:gpu',
      model: `face-detection/${GPU_FACE}`,
      outcome: 'step-dropped',
    })

    // Ten more frames: the root keeps running, the failed model is not
    // re-issued, and the camera's line is not repeated (backed off by name).
    for (let frame = 0; frame < 10; frame++) {
      await expect(run()).resolves.toMatchObject({ rootModelId: GPU_OD })
    }
    expect(h.pools['openvino:gpu']!.loaded().filter((m) => m === GPU_FACE)).toHaveLength(1)
    expect(h.lines.filter((l) => l.message === 'model load for dispatch failed')).toHaveLength(1)
    expect(h.lines.filter((l) => l.message === 'Benchmark: models to load')).toHaveLength(1)

    // D653's negative cache is per model: the root was never charged.
    const governor = h.provider['loadGovernor']
    const pool = h.pools['openvino:gpu']!.factory
    expect(governor.check(pool, 'openvino:gpu', [`object-detection/${GPU_OD}`]).kind).toBe('go')
    expect(governor.check(pool, 'openvino:gpu', [`face-detection/${GPU_FACE}`]).kind).toBe(
      'backoff',
    )
  })

  it('a whole-set load (the benchmark batch) charges an artifact failure to the model that failed, not to the root', async () => {
    // The incident's set, handed to the Coral pool directly: the SSD and a face
    // model with no tflite build.
    const h = harness()
    const pool = h.pools['edgetpu:usb']!.factory
    const set: readonly PipelineDefaultStep[] = [
      {
        addonId: 'object-detection',
        addonName: 'Object Detection',
        slot: 'detector',
        inputClasses: [],
        outputClasses: ['person'],
        enabled: true,
        modelId: SSD,
        children: [
          {
            // A step whose model ships no tflite build (YuNet has one since
            // its Coral build, D710; the vehicle classifier waits for D711).
            addonId: 'vehicle-classifier',
            addonName: 'Vehicle Classifier',
            slot: 'classifier',
            inputClasses: ['vehicle'],
            outputClasses: ['vehicle-type'],
            enabled: true,
            modelId: 'vehicle-type-v1',
            children: [],
          },
        ],
      },
    ]
    await expect(
      h.provider['ensureModelsForSteps'](set, pool, 'tflite', {
        deviceId: 104,
        deviceKey: 'edgetpu:usb',
      }),
    ).rejects.toThrow(/has no tflite format build/)
    const governor = h.provider['loadGovernor']
    expect(governor.check(pool, 'edgetpu:usb', [`object-detection/${SSD}`]).kind).toBe('go')
    expect(governor.check(pool, 'edgetpu:usb', ['vehicle-classifier/vehicle-type-v1']).kind).toBe(
      'backoff',
    )
  })

  it('a live dispatch whose ROOT cannot load still fails, with the root named', async () => {
    const h = harness()
    h.failing.add(GPU_FACE)
    await expect(
      h.provider.runPipeline({
        steps: [{ addonId: 'face-detection', enabled: true, children: [] }],
        image: await tinyJpeg(),
        deviceId: 104,
        deviceKey: 'openvino:gpu',
        plane: 'full',
      }),
    ).rejects.toThrow(GPU_FACE)
    const lost = h.lines.filter((l) => l.message === 'model load for dispatch failed')
    expect(lost[0]?.meta).toMatchObject({ outcome: 'root-lost' })
  })
})

describe('fix round 1 — every call that is not a live camera dispatch is all-or-nothing', () => {
  const GPU_OD = getDefaultModelForFormat('object-detection', 'openvino')
  const GPU_FACE = getDefaultModelForFormat('face-detection', 'openvino')
  const PINNED_GPU_TREE: readonly PipelineStepInput[] = [
    {
      addonId: 'object-detection',
      modelId: GPU_OD,
      enabled: true,
      children: [
        {
          addonId: 'face-detection',
          modelId: GPU_FACE,
          enabled: true,
          children: [],
        },
      ],
    },
  ]

  it('a REPLAY whose child fails to load THROWS, naming the step (D56)', async () => {
    const h = harness()
    h.failing.add(GPU_FACE)
    await expect(
      h.provider.runPipeline({
        steps: PINNED_GPU_TREE,
        image: await tinyJpeg(),
        deviceId: 104,
        deviceKey: 'openvino:gpu',
        plane: 'full',
        replay: true,
      }),
    ).rejects.toThrow(`face-detection/${GPU_FACE}`)
    expect(h.trees).toHaveLength(0)
  })

  it('a single-shot BENCHMARK (no camera) whose child fails to load THROWS, naming the step', async () => {
    const h = harness()
    h.failing.add(GPU_FACE)
    await expect(
      h.provider.runPipeline({
        steps: PINNED_GPU_TREE,
        image: await tinyJpeg(),
        deviceKey: 'openvino:gpu',
        plane: 'full',
      }),
    ).rejects.toThrow(
      /pipeline steps failed to load — the call runs all of them or none: face-detection\//,
    )
    expect(h.trees).toHaveLength(0)
  })

  it('the SAME tree on a live camera dispatch runs the root without the step', async () => {
    const h = harness()
    h.failing.add(GPU_FACE)
    await expect(
      h.provider.runPipeline({
        steps: PINNED_GPU_TREE,
        image: await tinyJpeg(),
        deviceId: 104,
        deviceKey: 'openvino:gpu',
        plane: 'full',
      }),
    ).resolves.toMatchObject({ rootModelId: GPU_OD })
    expect(treeIds(h.trees[0]!)).toEqual(['object-detection'])
  })
})

describe('fix round 1 — a failed step loads none of its children', () => {
  it('face-detection fails on the GPU: face-embedding is never sent to the pool', async () => {
    const h = harness()
    const face = getDefaultModelForFormat('face-detection', 'openvino')
    h.failing.add(face)
    await expect(
      h.provider.runPipeline({
        steps: [
          {
            addonId: 'object-detection',
            enabled: true,
            children: [FACE_SUBTREE],
          },
        ],
        image: await tinyJpeg(),
        deviceId: 104,
        deviceKey: 'openvino:gpu',
        plane: 'full',
      }),
    ).resolves.toBeDefined()
    const loaded = h.pools['openvino:gpu']!.loaded()
    expect(loaded).toContain(face)
    expect(loaded).not.toContain(getDefaultModelForFormat('face-embedding', 'openvino'))
    expect(treeIds(h.trees[0]!)).toEqual(['object-detection'])
  })
})

describe('fix round 1 — Coral + capped GPU/NPU: the no-candidate detail dispatch never fails the root', () => {
  it('a detail subtree the runner could place nowhere, sent at the Coral, runs on the node engine', async () => {
    // placeDetailStep answered `no-candidate` (the GPU and NPU are at their
    // cap), so the runner sends the detail dispatch at the elected Coral. The
    // one placement rule says the Coral cannot run the vehicle classifier (no
    // tflite build), so the call falls back to the node's own engine instead
    // of loading it on the Coral. (This used face-detection until YuNet's
    // Coral build, D710.)
    const h = harness()
    const onlyVehicle: readonly PipelineStepInput[] = [
      { addonId: 'vehicle-classifier', enabled: true, children: [] },
    ]
    await expect(
      h.provider.runPipeline({
        steps: onlyVehicle,
        image: await tinyJpeg(),
        deviceId: 104,
        deviceKey: 'edgetpu:usb',
        plane: 'full',
      }),
    ).resolves.toBeDefined()
    expect(h.pools['edgetpu:usb']!.loaded()).toEqual([])
    expect(h.pools['default']!.loaded()).toEqual([
      getDefaultModelForFormat('vehicle-classifier', 'onnx'),
    ])
    expect(
      h.lines.find((l) => l.message.includes('falling back to the node-local default engine')),
    ).toBeDefined()
  })
})

describe('fix round 1 — a failed step is dropped by INSTANCE, not by addon id', () => {
  it('two face-detection steps under one root: only the one whose model failed leaves', async () => {
    const h = harness()
    // The catalog has ONE face detector now, so the surviving sibling is an
    // operator-registered custom model with an openvino build.
    const sibling: ModelCatalogEntry = {
      id: 'my-openvino-face',
      name: 'My face',
      description: 'operator-registered face detector',
      inputSize: { width: 320, height: 320 },
      labels: [{ id: 'face', name: 'Face' }],
      preprocessMode: 'letterbox',
      formats: {
        openvino: { url: 'camstack-local://my-openvino-face.xml', sizeMB: 1 },
      },
    }
    h.provider['customModels']['byStep'] = new Map([['face-detection', [sibling]]])
    h.provider['customModels']['readAtMs'] = Date.now()
    h.provider['resolveModelEntry'] = async (addonId: string, modelId: string) =>
      modelId === sibling.id
        ? sibling
        : getStepDefinition(addonId).models.find((m) => m.id === modelId)
    h.provider['ensureStepModelArtifact'] = async () => undefined
    const od = getDefaultModelForFormat('object-detection', 'openvino')
    h.failing.add('yunet-2023mar')
    await expect(
      h.provider.runPipeline({
        steps: [
          {
            addonId: 'object-detection',
            modelId: od,
            enabled: true,
            children: [
              {
                addonId: 'face-detection',
                modelId: 'yunet-2023mar',
                enabled: true,
                children: [],
              },
              {
                addonId: 'face-detection',
                modelId: sibling.id,
                enabled: true,
                children: [],
              },
            ],
          },
        ],
        image: await tinyJpeg(),
        deviceId: 104,
        deviceKey: 'openvino:gpu',
        plane: 'full',
      }),
    ).resolves.toBeDefined()
    expect(treeIds(h.trees[0]!)).toEqual(['object-detection', 'face-detection'])
    expect(h.trees[0]!.roots[0]!.children[0]!.modelId).toBe(sibling.id)
  })
})

describe('round 2 — a small-subject recovery pass is tagged with its camera', () => {
  it('the recovery call shape (childless detector, image, frame plane, the camera id) logs a failed load with tags.deviceId', async () => {
    const h = harness()
    const od = getDefaultModelForFormat('object-detection', 'openvino')
    h.failing.add(od)
    await expect(
      h.provider.runPipeline({
        steps: [{ addonId: 'object-detection', modelId: od, enabled: true }],
        image: await tinyJpeg(),
        deviceId: 101,
        deviceKey: 'openvino:gpu',
        plane: 'frame',
      }),
    ).rejects.toThrow(od)
    const lost = h.lines.filter((l) => l.message === 'model load for dispatch failed')
    expect(lost).toHaveLength(1)
    expect(lost[0]!.tags).toEqual({ deviceId: 101 })
    expect(lost[0]!.meta).toMatchObject({ outcome: 'root-lost' })
  })
})

describe('round 2 — the gates judge the catalog MERGED with custom models', () => {
  const CUSTOM_FACE: ModelCatalogEntry = {
    id: 'my-coral-face',
    name: 'My Coral face',
    description: 'operator-registered face detector with an EdgeTPU build',
    inputSize: { width: 320, height: 320 },
    labels: [{ id: 'face', name: 'Face' }],
    preprocessMode: 'letterbox',
    postprocessor: 'ssd',
    formats: {
      tflite: { url: 'camstack-local://my-coral-face.tflite', sizeMB: 5 },
    },
  }

  it('a custom face model with a tflite build, pinned on a Coral, runs on the Coral', async () => {
    const h = harness()
    h.provider['customModels']['byStep'] = new Map([['face-detection', [CUSTOM_FACE]]])
    h.provider['customModels']['readAtMs'] = Date.now()
    h.provider['resolveModelEntry'] = async (addonId: string, modelId: string) =>
      modelId === CUSTOM_FACE.id
        ? CUSTOM_FACE
        : getStepDefinition(addonId).models.find((m) => m.id === modelId)
    h.provider['ensureStepModelArtifact'] = async () => undefined
    await expect(
      h.provider.runPipeline({
        steps: [{ addonId: 'face-detection', modelId: CUSTOM_FACE.id, enabled: true }],
        image: await tinyJpeg(),
        deviceId: 104,
        deviceKey: 'edgetpu:usb',
        plane: 'full',
      }),
    ).resolves.toBeDefined()
    // Not bounced to the node engine: it loaded on the Coral.
    expect(h.pools['edgetpu:usb']!.loaded()).toEqual([CUSTOM_FACE.id])
    expect(h.pools['default']!.loaded()).toEqual([])
  })
})
