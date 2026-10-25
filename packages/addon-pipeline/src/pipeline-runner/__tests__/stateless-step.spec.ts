/**
 * `runStatelessStep` — one enrichment step, caller-supplied pixels, NO camera
 * session.
 *
 * The two properties these tests exist to hold:
 *
 * 1. **The crop is cut by the same function the live detail plane uses.** The
 *    whole reason this path exists is that a rebuild must land in the same
 *    feature space as live traffic ([D52]); a second cutter here would restore
 *    the defect while looking like the fix.
 * 2. **A pinned model is run or REFUSED, never substituted.**
 *    `resolveModelForFormat` silently swaps a model with no build for the
 *    node's format for that format's default. Across a fleet pass that fills
 *    one index from several encoders, with nothing in the data to show it. So
 *    the servability check must happen BEFORE dispatch and must be able to say
 *    no.
 */

import type {
  DetailCropConvention,
  FrameResult,
  ModelCatalogEntry,
  ModelFormat,
  ObjectDetection,
  StepDefinition,
} from '@camstack/types'
import {
  DEFAULT_DETAIL_CROP_CONVENTION,
  deriveDetailCropRect,
  REMOVED_MODEL_IDS,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { modelServability, runStatelessStep, type StatelessStepDeps } from '../stateless-step.js'

const SOURCE_DEVICE_ID = 102
const NODE_ID = 'dev-agent-0'

function makeModel(id: string, formats: readonly ModelFormat[]): ModelCatalogEntry {
  const builds: ModelCatalogEntry['formats'] = {}
  for (const format of formats) {
    builds[format] = { url: `https://example/${id}.${format}`, sizeMB: 1 }
  }
  return {
    id,
    name: id,
    description: id,
    formats: builds,
    inputSize: { width: 256, height: 256 },
    labels: [{ id: 'embedding', name: 'CLIP Embedding' }],
  }
}

/** A `clip-embedding`-shaped catalog entry with a controllable format matrix. */
function makeStepDefinition(
  formatsByModel: Readonly<Record<string, readonly ModelFormat[]>>,
): StepDefinition {
  return {
    id: 'clip-embedding',
    name: 'CLIP Embedding',
    slot: 'classifier',
    postprocessor: 'clip',
    extractMode: 'crop-roi',
    inputClasses: ['person', 'vehicle', 'animal'],
    outputClasses: ['embedding'],
    defaultModelId: 'mobileclip-s1',
    defaultConfidence: 0.25,
    models: Object.entries(formatsByModel).map(([id, formats]) => makeModel(id, formats)),
  }
}

async function quadrantJpeg(width: number, height: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  const raw = Buffer.alloc(width * height * 3, 0)
  for (let y = 0; y < height / 2; y++) {
    for (let x = 0; x < width / 2; x++) {
      raw[(y * width + x) * 3] = 255
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg()
    .toBuffer()
}

function makeDetection(overrides: Partial<ObjectDetection> = {}): ObjectDetection {
  return {
    id: 'd1',
    kind: 'first-level',
    macroClass: 'person',
    score: 1,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    labels: [],
    embedding: [1, 0, 0],
    ...overrides,
  }
}

function makeFrameResult(
  detections: readonly ObjectDetection[],
  /** `null` = a result with no root stamp at all. */
  rootModelId: string | null = 'mobileclip-s1',
): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f1',
    deviceId: SOURCE_DEVICE_ID,
    timestamp: 0,
    width: 100,
    height: 100,
    detections,
    ...(rootModelId !== null ? { rootModelId } : {}),
  }
}

interface HarnessOverrides {
  readonly definition?: StepDefinition | null
  readonly format?: ModelFormat | null
  readonly convention?: DetailCropConvention
  readonly runPipeline?: StatelessStepDeps['runPipeline']
}

interface Harness {
  readonly deps: StatelessStepDeps
  readonly warn: ReturnType<typeof vi.fn<StatelessStepDeps['logger']['warn']>>
  readonly runPipeline: ReturnType<typeof vi.fn<StatelessStepDeps['runPipeline']>>
}

function makeDeps(overrides: HarnessOverrides = {}): Harness {
  const warn = vi.fn<StatelessStepDeps['logger']['warn']>()
  const runPipeline = vi.fn<StatelessStepDeps['runPipeline']>(
    overrides.runPipeline ?? (async () => makeFrameResult([makeDetection()])),
  )
  const definition =
    overrides.definition === undefined
      ? makeStepDefinition({ 'mobileclip-s1': ['onnx', 'openvino'] })
      : overrides.definition
  return {
    warn,
    runPipeline,
    deps: {
      nodeId: NODE_ID,
      lookupStep: () => definition,
      executionFormat: async () => (overrides.format === undefined ? 'onnx' : overrides.format),
      resolveCropConvention: () => overrides.convention ?? DEFAULT_DETAIL_CROP_CONVENTION,
      runPipeline,
      logger: { warn },
    },
  }
}

async function baseInput(): Promise<{
  stepId: string
  modelId: string
  frameJpeg: string
  bbox: { x: number; y: number; w: number; h: number }
  className: string
  sourceDeviceId: number
}> {
  const frame = await quadrantJpeg(640, 360)
  return {
    stepId: 'clip-embedding',
    modelId: 'mobileclip-s1',
    frameJpeg: frame.toString('base64'),
    // 100,100 → 150,180 in a 640x360 frame, expressed normalised.
    bbox: { x: 100 / 640, y: 100 / 360, w: 50 / 640, h: 80 / 360 },
    className: 'person',
    sourceDeviceId: SOURCE_DEVICE_ID,
  }
}

describe('modelServability', () => {
  it('a catalog model WITH a build for the format is servable', () => {
    const def = makeStepDefinition({ 'mobileclip-s1': ['onnx'] })
    expect(modelServability(def, 'mobileclip-s1', 'onnx').kind).toBe('catalog-build')
  })

  it('a catalog model WITHOUT a build for the format is not — and names what the catalog does ship', () => {
    const def = makeStepDefinition({
      'mobileclip-s1': ['onnx'],
      'mobileclip-s0': ['tflite'],
    })
    const verdict = modelServability(def, 'mobileclip-s1', 'tflite')
    expect(verdict.kind).toBe('no-build')
    if (verdict.kind === 'no-build') expect(verdict.availableFormats).toEqual(['onnx'])
  })

  it('a model the catalog does not know is servable — nothing can substitute it', () => {
    // `resolveModelForFormat` returns an unknown id unchanged, so a custom
    // model cannot be silently swapped. Refusing it would strand an operator
    // who deliberately pinned one.
    const def = makeStepDefinition({ 'mobileclip-s1': ['onnx'] })
    expect(modelServability(def, 'my-own-clip', 'onnx').kind).toBe('custom-model')
  })

  it('a model DELETED from the catalog is a custom model — there is no retired verdict any more', () => {
    const def: StepDefinition = {
      ...makeStepDefinition({ 'yunet-2023mar': ['onnx'] }),
      id: 'face-detection',
    }
    expect(modelServability(def, 'scrypted-yolov9t-face', 'onnx').kind).toBe('custom-model')
    expect(modelServability(def, 'scrfd-2.5g', 'onnx').kind).toBe('custom-model')
  })
})

describe('runStatelessStep', () => {
  it('(a) runs with NO attachment involved and returns the pinned model back', async () => {
    const { deps, runPipeline } = makeDeps()
    const result = await runStatelessStep(deps, await baseInput())

    expect(result.kind).toBe('ran')
    if (result.kind !== 'ran') return
    expect(result.nodeId).toBe(NODE_ID)
    expect(result.modelId).toBe('mobileclip-s1')
    expect(result.details).toHaveLength(1)
    expect(result.details[0]?.stepId).toBe('clip-embedding')
    expect(result.details[0]?.embedding).toBeDefined()
    expect(runPipeline).toHaveBeenCalledTimes(1)
  })

  it('(b) forces the PINNED model onto the step it dispatches', async () => {
    // The node's own per-device step config is irrelevant here: a pass that
    // lets each node pick its own model writes several feature spaces.
    const { deps, runPipeline } = makeDeps()
    await runStatelessStep(deps, {
      ...(await baseInput()),
      modelId: 'mobileclip-s1',
    })

    const steps = runPipeline.mock.calls[0]![0]
    expect(steps).toHaveLength(1)
    expect(steps[0]!.addonId).toBe('clip-embedding')
    expect(steps[0]!.modelId).toBe('mobileclip-s1')
    expect(steps[0]!.enabled).toBe(true)
    // No jump: there is no attach roster to jump within.
    expect(steps[0]!.jumpDeviceKey).toBeUndefined()
  })

  it('(b2) a bulk pass pinned to a REMOVED model is never reset to the default (D725 vs D54)', async () => {
    // D725 resets a STORED pin to a deleted model. A bulk pass pins its model
    // for the whole run; that pin is never rewritten — it runs verbatim and,
    // where the node holds no such model, fails by name. Never substituted.
    const removed = REMOVED_MODEL_IDS['clip-embedding']?.[0]
    expect(removed).toBeDefined()
    if (removed === undefined) return
    const { deps, runPipeline } = makeDeps({
      definition: { ...makeStepDefinition({ 'siglip2-b16-224': ['onnx'] }), id: 'clip-embedding' },
      runPipeline: async () => {
        throw new Error(`model "${removed}" is not installed on this node`)
      },
    })
    const result = await runStatelessStep(deps, { ...(await baseInput()), modelId: removed })

    expect(runPipeline.mock.calls[0]![0][0]!.modelId).toBe(removed)
    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.reason).toBe('execution-failed')
    expect(result.detail).toContain(removed)
  })

  it('(c) REFUSES a model with no build for this node format, and never dispatches', async () => {
    // The load-bearing refusal. Dispatching would substitute the format
    // default with one info line and produce a vector from another encoder.
    const { deps, runPipeline, warn } = makeDeps({
      definition: makeStepDefinition({
        'mobileclip-s1': ['onnx'],
        'mobileclip-s0': ['tflite'],
      }),
      format: 'tflite',
    })
    const result = await runStatelessStep(deps, await baseInput())

    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.reason).toBe('model-not-servable')
    expect(result.detail).toContain('mobileclip-s1')
    expect(result.detail).toContain('tflite')
    expect(runPipeline).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![1]?.tags?.deviceId).toBe(SOURCE_DEVICE_ID)
  })

  it('(d) REFUSES an unknown step id rather than guessing', async () => {
    const { deps, runPipeline } = makeDeps({ definition: null })
    const result = await runStatelessStep(deps, await baseInput())

    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.reason).toBe('unknown-step')
    expect(runPipeline).not.toHaveBeenCalled()
  })

  it('(e) REFUSES when the node cannot state the format it would dispatch on', async () => {
    // An unknown format cannot be checked against, and an unchecked pin is a
    // silent substitution waiting to happen.
    const { deps, runPipeline } = makeDeps({ format: null })
    const result = await runStatelessStep(deps, await baseInput())

    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.reason).toBe('model-not-servable')
    expect(runPipeline).not.toHaveBeenCalled()
  })

  it('(f) cuts the crop with the SAME derivation, and the same convention, as the live path', async () => {
    // Deliberately neither the default nor the rebuild's historical 0.2: a
    // second constant anywhere on this path would fail these numbers.
    const convention: DetailCropConvention = {
      paddingRatio: 0.37,
      square: false,
    }
    const { deps, runPipeline } = makeDeps({ convention })
    const input = await baseInput()

    await runStatelessStep(deps, input)

    // The bbox travels NORMALISED; the runner denormalises against the frame it
    // decoded and hands the pixel rect to the one shared derivation.
    const expected = deriveDetailCropRect({ x: 100, y: 100, w: 50, h: 80 }, 640, 360, convention)
    const sharp = (await import('sharp')).default
    const meta = await sharp(runPipeline.mock.calls[0]![1]).metadata()
    expect(meta.width).toBe(Math.round(expected.w))
    expect(meta.height).toBe(Math.round(expected.h))
  })

  it('(g) the crop is IDENTICAL to the one a live frame handle would ask for', async () => {
    // Same box, same frame dimensions, same convention → the same rectangle.
    // This is the property that keeps rebuilt vectors comparable with live ones.
    const convention: DetailCropConvention = {
      paddingRatio: 0.25,
      square: true,
    }
    const { deps, runPipeline } = makeDeps({ convention })
    const frame = await quadrantJpeg(640, 360)

    await runStatelessStep(deps, {
      stepId: 'clip-embedding',
      modelId: 'mobileclip-s1',
      frameJpeg: frame.toString('base64'),
      bbox: { x: 300 / 640, y: 120 / 360, w: 60 / 640, h: 140 / 360 },
      className: 'animal',
      sourceDeviceId: SOURCE_DEVICE_ID,
    })

    const live = deriveDetailCropRect({ x: 300, y: 120, w: 60, h: 140 }, 640, 360, convention)
    const sharp = (await import('sharp')).default
    const meta = await sharp(runPipeline.mock.calls[0]![1]).metadata()
    expect(meta.width).toBe(Math.round(live.w))
    expect(meta.height).toBe(Math.round(live.h))
  })

  it('(h) REFUSES an undecodable frame, loudly and tagged', async () => {
    const { deps, warn } = makeDeps()
    const result = await runStatelessStep(deps, {
      ...(await baseInput()),
      frameJpeg: Buffer.from('not a jpeg').toString('base64'),
    })

    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.reason).toBe('unreadable-frame')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![1]?.tags?.deviceId).toBe(SOURCE_DEVICE_ID)
  })

  it('(i) REFUSES a degenerate bbox before touching pixels', async () => {
    const { deps, runPipeline } = makeDeps()
    const result = await runStatelessStep(deps, {
      ...(await baseInput()),
      bbox: { x: 0.5, y: 0.5, w: 0, h: 0.2 },
    })

    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.reason).toBe('unreadable-frame')
    expect(runPipeline).not.toHaveBeenCalled()
  })

  it('(j) an execution that throws is a REFUSAL with its own reason, not a crash', async () => {
    const { deps, warn } = makeDeps({
      runPipeline: async () => {
        throw new Error('pool is not initialized')
      },
    })
    const result = await runStatelessStep(deps, await baseInput())

    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.reason).toBe('execution-failed')
    expect(result.detail).toContain('pool is not initialized')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('(k) a run that produces no detections is NOT silently successful', async () => {
    // It still `ran` — the distinction between "the step produced nothing" and
    // "the node refused" belongs to the caller's counters, and it can only make
    // it if `ran` is honest about an empty result.
    const { deps } = makeDeps({ runPipeline: async () => makeFrameResult([]) })
    const result = await runStatelessStep(deps, await baseInput())

    expect(result.kind).toBe('ran')
    if (result.kind !== 'ran') return
    expect(result.details).toEqual([])
  })

  it('(l) every refusal carries the node id, so a fleet pass can name the node that said no', async () => {
    const { deps } = makeDeps({ definition: null })
    const result = await runStatelessStep(deps, await baseInput())
    expect(result.nodeId).toBe(NODE_ID)
  })
})

describe('runStatelessStep reports the model that RAN, never the pin (D658)', () => {
  it('a node whose executor ran another model REFUSES by name — never `ran` under the pin (D54)', async () => {
    const { deps } = makeDeps({
      runPipeline: async () => makeFrameResult([makeDetection()], 'siglip2-b16-224'),
    })
    const result = await runStatelessStep(deps, {
      ...(await baseInput()),
      modelId: 'mobileclip-s1',
    })
    expect(result.kind).toBe('refused')
    expect(result.kind === 'refused' ? result.reason : null).toBe('model-not-servable')
    expect(result.kind === 'refused' ? result.detail : '').toMatch(/ran "siglip2-b16-224"/)
  })

  it('a result that names no model is refused by name', async () => {
    const { deps } = makeDeps({
      runPipeline: async () => makeFrameResult([makeDetection()], null),
    })
    const result = await runStatelessStep(deps, await baseInput())
    expect(result.kind).toBe('refused')
    expect(result.kind === 'refused' ? result.reason : null).toBe('execution-failed')
    expect(result.kind === 'refused' ? result.detail : '').toMatch(/names no model/)
  })
})
