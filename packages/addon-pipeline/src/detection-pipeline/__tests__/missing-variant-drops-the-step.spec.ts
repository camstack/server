/**
 * D658 round 1 — a child whose `(step, model)` variant is not warm at
 * tree-build time is dropped WITH ITS SUBTREE, said once per camera, and the
 * root and every other step still run. The by-(step, model) lookup throws on a
 * missing pair (it never answers another variant), and before this rule one
 * such throw cost the whole dispatch — the root's detections included.
 */
import type {
  FrameResult,
  IInferenceEngine,
  IScopedLogger,
  PipelineDefaultStep,
  PipelineStepInput,
} from '@camstack/types'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StepVariantHandle } from '../engine/pipeline-model-manager.js'
import { EngineFactory } from '../engine/engine-factory.js'
import { PipelineExecutor } from '../pipeline/executor.js'
import { buildExecutableTree, type MissingVariantHandler } from '../pipeline/tree-builder.js'
import { DetectionPipelineProvider } from '../provider.js'

const stubEngine: IInferenceEngine = {
  runtime: 'onnx',
  device: 'cpu',
  infer: async () => ({ inferenceMs: 1 }),
  dispose: async () => undefined,
}

function step(
  addonId: string,
  modelId: string,
  children: PipelineDefaultStep[] = [],
): PipelineDefaultStep {
  return {
    addonId,
    addonName: addonId,
    slot: 'detector',
    inputClasses: [],
    outputClasses: [],
    enabled: true,
    modelId,
    children,
  }
}

const lookupWithout =
  (missing: string) =>
  (stepId: string, modelId: string): StepVariantHandle => {
    if (stepId === missing)
      throw new Error(`Step "${stepId}" has no warm variant for model "${modelId}"`)
    return { engine: stubEngine, modelId, poolIndex: 0 }
  }

const TREE = (): PipelineDefaultStep[] => [
  step('object-detection', 'yolo26n', [
    step('face-detection', 'yunet-2023mar', [step('face-embedding', 'auraface-r100')]),
    step('clip-embedding', 'mobileclip-s1'),
  ]),
]

describe('buildExecutableTree — a missing child variant drops that subtree only', () => {
  it('keeps the root and the sibling, drops the child and its descendants, and says which', () => {
    const drops: Parameters<MissingVariantHandler>[0][] = []
    const tree = buildExecutableTree(TREE(), lookupWithout('face-detection'), undefined, (d) =>
      drops.push(d),
    )
    expect(tree.roots.map((r) => r.stepId)).toEqual(['object-detection'])
    expect(tree.roots[0]!.children.map((c) => c.stepId)).toEqual(['clip-embedding'])
    expect(drops).toEqual([
      expect.objectContaining({
        stepId: 'face-detection',
        modelId: 'yunet-2023mar',
        parentStepId: 'object-detection',
        droppedSubtree: ['face-detection', 'face-embedding'],
      }),
    ])
  })

  it('a missing ROOT variant still throws — there is no frame without it', () => {
    expect(() =>
      buildExecutableTree(TREE(), lookupWithout('object-detection'), undefined, () => undefined),
    ).toThrow(/no warm variant/)
  })
})

function captureLogger(
  sink: Array<{ message: string; tags: unknown; meta: unknown }>,
): IScopedLogger {
  const record = (message: string, opts?: { tags?: unknown; meta?: unknown }): void => {
    sink.push({ message, tags: opts?.tags, meta: opts?.meta })
  }
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: record,
    error: record,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

afterEach(() => {
  vi.restoreAllMocks()
})

interface ProviderHarness {
  readonly provider: DetectionPipelineProvider
  readonly lines: Array<{ message: string; tags: unknown; meta: unknown }>
  readonly executed: string[][]
  readonly image: Uint8Array
}

async function providerHarness(): Promise<ProviderHarness> {
  const lines: Array<{ message: string; tags: unknown; meta: unknown }> = []
  const provider = new DetectionPipelineProvider(
    { readAddonStore: async () => ({}), writeAddonStore: async () => undefined },
    '/tmp/camstack-test-models',
    captureLogger(lines),
  )
  provider['ensureEngineFactory'] = async () => {
    provider['engineFactory'] ??= new EngineFactory({
      engine: provider['currentEngine'],
      modelsDir: '/tmp/camstack-test-models',
      logger: captureLogger([]),
      pythonPath: '',
    })
  }
  // A call with no camera is a benchmark and loads into a pool of its own (D910).
  provider['createBenchmarkFactory'] = async () =>
    new EngineFactory({
      engine: provider['currentEngine'],
      modelsDir: '/tmp/camstack-test-models',
      logger: captureLogger([]),
      pythonPath: '',
    })
  const executed: string[][] = []
  vi.spyOn(PipelineExecutor.prototype, 'run').mockImplementation(async (tree) => {
    executed.push(tree.roots.flatMap((r) => [r.stepId, ...r.children.map((c) => c.stepId)]))
    const result: FrameResult = {
      kind: 'frame',
      frameId: 'f',
      deviceId: 101,
      timestamp: 1,
      width: 16,
      height: 16,
      detections: [],
    }
    return { result, trace: null }
  })
  const image = new Uint8Array(
    await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer(),
  )
  return { provider, lines, executed, image }
}

const ROOT_WITH_CLASSIFIER: readonly PipelineStepInput[] = [
  {
    addonId: 'object-detection',
    enabled: true,
    children: [{ addonId: 'vehicle-classifier', enabled: true }],
  },
]

/** Every per-camera line about a step's model loss — ONE family (D657 + D658). */
const lossLines = (h: ProviderHarness, stepId: string) =>
  h.lines.filter(
    (l) =>
      l.message === 'model load for dispatch failed' &&
      JSON.stringify(l.meta).includes(`"${stepId}/`),
  )

describe("runPipeline — a missing child variant is a dropped step, in D657's vocabulary (D658)", () => {
  it('runs the root, drops the child, and tells the camera ONCE across frames', async () => {
    const h = await providerHarness()
    vi.spyOn(EngineFactory.prototype, 'needsPoolUpdate').mockReturnValue(false)
    vi.spyOn(EngineFactory.prototype, 'getStepVariant').mockImplementation((stepId, modelId) =>
      lookupWithout('vehicle-classifier')(stepId, modelId),
    )
    for (let i = 0; i < 3; i++) {
      await h.provider.runPipeline({
        steps: ROOT_WITH_CLASSIFIER,
        image: h.image,
        deviceId: 101,
        plane: 'full',
      })
    }
    expect(h.executed).toEqual([['object-detection'], ['object-detection'], ['object-detection']])
    const lines = lossLines(h, 'vehicle-classifier')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.tags).toEqual({ deviceId: 101 })
    expect(lines[0]!.meta).toMatchObject({ state: 'not-warm', outcome: 'step-dropped' })
  })

  it('an all-or-nothing call (no camera) fails by name instead of running a smaller tree', async () => {
    const h = await providerHarness()
    vi.spyOn(EngineFactory.prototype, 'needsPoolUpdate').mockReturnValue(false)
    vi.spyOn(EngineFactory.prototype, 'getStepVariant').mockImplementation((stepId, modelId) =>
      lookupWithout('vehicle-classifier')(stepId, modelId),
    )
    await expect(
      h.provider.runPipeline({ steps: ROOT_WITH_CLASSIFIER, image: h.image, plane: 'full' }),
    ).rejects.toThrow(/runs all of them or none: vehicle-classifier\//)
    expect(h.executed).toEqual([])
  })

  it('a step whose LOAD failed (D657) is said once — never again as a missing variant', async () => {
    const h = await providerHarness()
    vi.spyOn(EngineFactory.prototype, 'needsPoolUpdate').mockImplementation(
      (s) => s.addonId === 'vehicle-classifier',
    )
    h.provider['downloadNeededModels'] = async (needed: readonly PipelineDefaultStep[]) => {
      if (needed.some((s) => s.addonId === 'vehicle-classifier')) {
        throw new Error('no build for this format')
      }
    }
    const lookup = vi
      .spyOn(EngineFactory.prototype, 'getStepVariant')
      .mockImplementation((stepId, modelId) => lookupWithout('vehicle-classifier')(stepId, modelId))
    await h.provider.runPipeline({
      steps: ROOT_WITH_CLASSIFIER,
      image: h.image,
      deviceId: 101,
      plane: 'full',
    })
    expect(h.executed).toEqual([['object-detection']])
    expect(lookup.mock.calls.map((c) => c[0])).toEqual(['object-detection'])
    const lines = lossLines(h, 'vehicle-classifier')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.meta).toMatchObject({ outcome: 'step-dropped' })
    expect(lines[0]!.meta).not.toMatchObject({ state: 'not-warm' })
  })
})

describe('the frame names the root that RAN — read from the tree, not the request (D658 × D657)', () => {
  it('object-detection fails to load, package-detection survives: the result is stamped with the survivor', async () => {
    const h = await providerHarness()
    vi.spyOn(EngineFactory.prototype, 'needsPoolUpdate').mockImplementation(
      (s) => s.addonId === 'object-detection',
    )
    h.provider['downloadNeededModels'] = async (needed: readonly PipelineDefaultStep[]) => {
      if (needed.some((s) => s.addonId === 'object-detection')) throw new Error('compile failed')
    }
    const lookup = vi
      .spyOn(EngineFactory.prototype, 'getStepVariant')
      .mockImplementation((stepId, modelId) => lookupWithout('object-detection')(stepId, modelId))
    const result = await h.provider.runPipeline({
      steps: [
        { addonId: 'object-detection', enabled: true },
        { addonId: 'package-detection', enabled: true },
      ],
      image: h.image,
      deviceId: 101,
      plane: 'full',
    })
    expect(h.executed).toEqual([['package-detection']])
    const packageModel = lookup.mock.calls.find((c) => c[0] === 'package-detection')?.[1]
    expect(packageModel).toBeDefined()
    expect(result.rootModelId).toBe(packageModel)
  })
})
