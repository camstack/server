/**
 * D658 — the embedding's model stamp is the model that RAN.
 *
 * 2026-09-27, 09:38: the operator flipped `clusterModel:clip-embedding` from
 * `mobileclip-s1` to `siglip2-b16-224`. Every runner read the row within a
 * minute and every node loaded SigLIP2 (`Step variant loaded … poolIndex=9/10`).
 * For twenty minutes post-analysis then refused EVERY vector:
 * `modelId=siglip2-b16-224 dim=512 expected=768` — 178 of them, not one stored.
 *
 * The runner asked for SigLIP2 and stamped SigLIP2, and ran MobileCLIP. The
 * pool keeps several variants of a step warm and ONE of them is "active": the
 * first one loaded after boot. `buildExecutableTree` fetched each step's engine
 * by STEP id alone, which answers the active variant — so the tree carried the
 * requested id as its `modelId` (which the result assembler stamps) and the
 * active variant's handle as its `engine` (which produced the vector). Nothing
 * compared the two.
 *
 * These specs drive the REAL provider (`runPipeline`, the one entry the detail
 * subtree and the stateless rebuild step both call) over the REAL model manager
 * and executor; only the pool's `loadModel` and its handles are faked, each
 * handle answering a vector as long as its model's dimension.
 */
import type {
  EngineOutput,
  IInferenceEngine,
  IScopedLogger,
  PipelineStepInput,
  PoolModelConfig,
} from '@camstack/types'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClusterModelSource } from '../../shared/cluster-model-source.js'
import { EngineFactory } from '../engine/engine-factory.js'
import { PipelineModelManager, type PoolModelSource } from '../engine/pipeline-model-manager.js'
import { SharedInferencePool } from '../engine/shared-inference-pool.js'
import { DetectionPipelineProvider } from '../provider.js'

const MOBILECLIP = 'mobileclip-s1'
const SIGLIP = 'siglip2-b16-224'
const DIM: Readonly<Record<string, number>> = { [MOBILECLIP]: 512, [SIGLIP]: 768 }

interface Line {
  readonly message: string
  readonly tags: Record<string, unknown>
  readonly meta: Record<string, unknown>
}

function recordingLogger(sink: Line[]): IScopedLogger {
  const record = (
    message: string,
    opts?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
  ): void => {
    sink.push({ message, tags: opts?.tags ?? {}, meta: opts?.meta ?? {} })
  }
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: record,
    warn: record,
    error: record,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** The pool config names the model in its path — the only thing a handle can know. */
const SOURCE: PoolModelSource = {
  buildConfig: (_stepId, modelId): PoolModelConfig => ({
    path: `/data/models/openvino/camstack-${modelId}.xml`,
    inputSize: 224,
    preprocessMode: 'resize',
    postprocessor: 'clip',
    confidence: 0,
  }),
  resolveDecode: () => ({ nmsIouThreshold: 0.45 }),
}

function modelOfPath(path: string): string {
  const hit = Object.keys(DIM).find((id) => path.includes(id))
  if (hit === undefined) throw new Error(`no model in ${path}`)
  return hit
}

/** A handle that answers a unit vector as long as the model loaded at its index. */
function handleFor(modelId: string): IInferenceEngine {
  const dim = DIM[modelId] ?? 0
  const vec = Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0))
  return {
    runtime: 'onnx',
    device: 'cpu',
    infer: async (): Promise<EngineOutput> => ({
      inferenceMs: 1,
      structured: { kind: 'embedding', embedding: vec, embeddingNorm: vec },
    }),
    dispose: async () => undefined,
  }
}

interface Harness {
  readonly provider: DetectionPipelineProvider
  /** Set the cluster row the runner reads next (TTL 0: every dispatch re-reads). */
  flip(modelId: string): Promise<void>
  /** The owner answers `owner-not-ready` (its boot window). */
  ownerNotReady(): Promise<void>
  readonly loaded: string[]
  readonly lines: Line[]
}

function harness(): Harness {
  const lines: Line[] = []
  const log = recordingLogger(lines)
  const provider = new DetectionPipelineProvider(
    { readAddonStore: async () => ({}), writeAddonStore: async () => undefined },
    '/tmp/camstack-test-models',
    log,
  )
  // Both CLIP models ship openvino builds (neither ships onnx): an openvino node.
  provider['currentEngine'] = {
    runtime: 'python',
    backend: 'openvino',
    format: 'openvino',
    device: 'cpu',
  }
  const pool = new SharedInferencePool('/nonexistent/python', 'openvino', log, { device: 'cpu' })
  const byIndex = new Map<number, string>()
  const loaded: string[] = []
  vi.spyOn(pool, 'loadModel').mockImplementation(async (index: number, config) => {
    const modelId = modelOfPath(config.path)
    byIndex.set(index, modelId)
    loaded.push(modelId)
    return { loadMs: 1 }
  })
  vi.spyOn(pool, 'getHandle').mockImplementation((index: number) =>
    handleFor(byIndex.get(index) ?? 'none'),
  )
  const manager = new PipelineModelManager(pool, SOURCE, log, { deviceKey: 'openvino:cpu' })
  const factory = new EngineFactory({
    engine: provider['currentEngine'],
    modelsDir: '/tmp/camstack-test-models',
    logger: log,
    pythonPath: '',
  })
  factory['poolManager'] = manager
  provider['engineFactory'] = factory
  provider['ensureEngineFactory'] = async () => undefined
  provider['downloadNeededModels'] = async () => undefined
  provider['resolveModelEntry'] = async () => undefined

  const rows = new ClusterModelSource({ logger: log, ttlMs: 0 })
  Reflect.set(provider, 'clusterModels', rows)
  const ownerNotReady = async (): Promise<void> => {
    await rows.refresh({
      addonSettings: { getGlobalSettings: { query: async () => null } },
      pipelineOrchestrator: {
        getClusterModelChoice: {
          query: async () => ({ kind: 'unreadable', reason: 'owner-not-ready' }),
        },
      },
    })
  }
  const flip = async (modelId: string): Promise<void> => {
    await rows.refresh({
      addonSettings: { getGlobalSettings: { query: async () => null } },
      pipelineOrchestrator: {
        getClusterModelChoice: {
          query: async ({ stepId }) =>
            stepId === 'clip-embedding'
              ? { kind: 'stored', modelId }
              : { kind: 'absent', defaultModelId: 'auraface-r100' },
        },
      },
    })
  }
  return { provider, flip, ownerNotReady, loaded, lines }
}

async function cropJpeg(): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 9, g: 9, b: 9 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

/**
 * The detail subtree's call for a tracked crop: the clip step as a ROOT on the
 * crop. The step carries whatever the attach provisioned — here the OLD model,
 * exactly what a session attached before the flip sends.
 */
const ATTACHED_WITH_MOBILECLIP: readonly PipelineStepInput[] = [
  { addonId: 'clip-embedding', modelId: MOBILECLIP, enabled: true },
]

interface Stamp {
  readonly modelId: string | undefined
  readonly dim: number | undefined
}

async function embedOnce(h: Harness, deviceId = 101): Promise<Stamp> {
  const result = await h.provider.runPipeline({
    steps: ATTACHED_WITH_MOBILECLIP,
    image: await cropJpeg(),
    deviceId,
    plane: 'full',
  })
  const d = result.detections.find((x) => x.embedding !== undefined)
  return { modelId: d?.embeddingModelId, dim: d?.embedding?.length }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the stamp is the model that ran (D658)', () => {
  it('a session on MobileCLIP stamps MobileCLIP with a 512-d vector until the row changes', async () => {
    const h = harness()
    await h.flip(MOBILECLIP)
    expect(await embedOnce(h)).toEqual({ modelId: MOBILECLIP, dim: 512 })
    expect(await embedOnce(h)).toEqual({ modelId: MOBILECLIP, dim: 512 })
  })

  it('after the flip reaches the runner, the SAME attached session runs and stamps SigLIP2 at 768-d', async () => {
    const h = harness()
    await h.flip(MOBILECLIP)
    await embedOnce(h)
    // MobileCLIP was loaded first, so it is the pool's ACTIVE clip variant —
    // the incident's exact shape. The attach still says MobileCLIP.
    await h.flip(SIGLIP)
    expect(await embedOnce(h)).toEqual({ modelId: SIGLIP, dim: 768 })
    expect(h.loaded).toEqual([MOBILECLIP, SIGLIP])
  })

  it('the stamp equals the executed model across a row change mid-session, both ways', async () => {
    const h = harness()
    const seen: Stamp[] = []
    for (const row of [MOBILECLIP, SIGLIP, SIGLIP, MOBILECLIP, SIGLIP]) {
      await h.flip(row)
      seen.push(await embedOnce(h))
    }
    for (const s of seen) {
      expect(s.dim).toBe(DIM[s.modelId ?? ''])
    }
    expect(seen.map((s) => s.modelId)).toEqual([MOBILECLIP, SIGLIP, SIGLIP, MOBILECLIP, SIGLIP])
  })
})

describe('a variant is fetched by (step, model) or not at all (D658)', () => {
  it('asking for a model the pool does not hold refuses — it never answers the active variant', async () => {
    const h = harness()
    await h.flip(MOBILECLIP)
    await embedOnce(h)
    const factory = h.provider['engineFactory']
    expect(factory).not.toBeNull()
    expect(() => factory?.getStepVariant('clip-embedding', SIGLIP)).toThrow(
      /no warm variant for model "siglip2-b16-224"/,
    )
    expect(factory?.getStepVariant('clip-embedding', MOBILECLIP).modelId).toBe(MOBILECLIP)
  })
})

describe('a camera says when it starts running the new model (D658)', () => {
  const REPROVISIONED =
    'cluster-scoped step re-provisioned for this camera — now runs the new model'

  it('one line per camera, tagged, at the first dispatch that RUNS the new model — never per frame', async () => {
    const h = harness()
    await h.flip(MOBILECLIP)
    await embedOnce(h, 101)
    await embedOnce(h, 102)
    expect(h.lines.filter((l) => l.message === REPROVISIONED)).toEqual([])
    await h.flip(SIGLIP)
    for (let i = 0; i < 5; i++) {
      await embedOnce(h, 101)
      await embedOnce(h, 102)
    }
    const lines = h.lines.filter((l) => l.message === REPROVISIONED)
    expect(lines.map((l) => [l.tags, l.meta])).toEqual([
      [{ deviceId: 101 }, { stepId: 'clip-embedding', from: MOBILECLIP, to: SIGLIP }],
      [{ deviceId: 102 }, { stepId: 'clip-embedding', from: MOBILECLIP, to: SIGLIP }],
    ])
  })
})

describe('the owner boot window runs NO cluster model (D658)', () => {
  it('before the owner answers, the clip step is refused by name and no default is loaded', async () => {
    const h = harness()
    await h.ownerNotReady()
    const stamp = await embedOnce(h).catch((err: unknown) => ({ threw: String(err) }))
    expect(stamp).not.toHaveProperty('dim', 512)
    expect(h.loaded).toEqual([])
    const refused = h.lines.filter((l) =>
      l.message.startsWith('cluster-scoped step refused for this camera'),
    )
    expect(refused).toHaveLength(1)
    expect(refused[0]!.tags).toEqual({ deviceId: 101 })
    expect(refused[0]!.meta).toMatchObject({ stepId: 'clip-embedding', reason: 'owner-not-ready' })
    // Once the owner answers, the FIRST variant loaded is the operator's choice.
    await h.flip(SIGLIP)
    expect(await embedOnce(h)).toEqual({ modelId: SIGLIP, dim: 768 })
    expect(h.loaded).toEqual([SIGLIP])
  })
})

describe('the pool fast paths name their model too (D658)', () => {
  it('getPoolIndex answers exactly (step, model) — the active variant is never a stand-in', async () => {
    const h = harness()
    await h.flip(MOBILECLIP)
    await embedOnce(h)
    const manager = h.provider['engineFactory']?.['poolManager']
    expect(manager?.getPoolIndex('clip-embedding', SIGLIP)).toBeNull()
    expect(manager?.getPoolIndex('clip-embedding', MOBILECLIP)).not.toBeNull()
  })

  it('inferCached without a model is refused by name (a server closure that strips the field)', async () => {
    const h = harness()
    // Documented type boundary: this is the WIRE payload an older schema left
    // after stripping `modelId` — exactly the shape the type says cannot arrive.
    const stripped = { stepId: 'clip-embedding', frameId: 1 }
    await expect(
      h.provider.inferCached(stripped as Parameters<typeof h.provider.inferCached>[0]),
    ).rejects.toThrow(/no modelId/)
  })
})

describe('an all-or-nothing call never runs without an unanswered cluster step (D658 × D657)', () => {
  it('a call with no camera (benchmark / ramp) naming the clip step fails by name in the boot window', async () => {
    const h = harness()
    await h.ownerNotReady()
    await expect(
      h.provider.runPipeline({
        steps: ATTACHED_WITH_MOBILECLIP,
        image: await cropJpeg(),
        plane: 'full',
      }),
    ).rejects.toThrow(/cluster-model-unknown: .*clip-embedding/)
    expect(h.loaded).toEqual([])
  })
})
