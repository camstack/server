/**
 * `package-detection` must expose a per-camera confidence surface.
 *
 * The step shipped with `getConfigSchema(): []`. Its 0.5 floor lived only in
 * `definition.defaultConfidence`, which is forwarded to the Python pool and is
 * reachable from NO operator surface — the catalog carries `configSchema` to
 * the admin-ui, so an empty schema renders no form at all. On 2026-08-07 camera
 * 101 reported a DOORMAT as a package at 0.5669 (the model's own benchmark had
 * already noted a doormat near-FP at 0.49, which is why the floor was set to
 * 0.50 — a 0.01 margin). There was no way to raise it short of editing source.
 *
 * The key is NOT free: the executor reads
 * `minConfidence${capitalize(macroClass)}` off the ROOT step's settings
 * (`macroFilterVerdict`), and this detector's detections carry
 * `macroClass: 'package'` (its model emits `class: 'package'` and the step
 * declares no `classMap`, so `toMutableRootDetection` copies it verbatim). A
 * schema declaring any other key would render a slider that filters nothing —
 * which is the exact failure `packageDropClassFilter` already has. The first
 * test derives the expected key from the step's own `outputClasses` so a rename
 * on either side fails here rather than in production.
 *
 * The ENABLE switch is deliberately still absent: `package-detection` is
 * zone-driven (`applyPackageZoneActivation`), and a second enablement authority
 * beside the zone rule is the bug this repo has already shipped twice.
 */
import { describe, it, expect, vi } from 'vitest'
import sharp from 'sharp'
import type {
  ConfigField,
  ConfigSliderField,
  EngineOutput,
  IInferenceEngine,
  InferenceInput,
  PipelineDefaultStep,
} from '@camstack/types'

import { getStep } from '../registry/step-definitions.js'
import { buildExecutableTree } from '../pipeline/tree-builder.js'
import { resolvePoolConfidenceFloor } from '../engine/engine-factory.js'
import { PipelineExecutor } from '../pipeline/executor.js'
import type { ExecutableStep, ExecutableTree } from '../pipeline/tree-builder.js'

const PACKAGE_STEP_ID = 'package-detection'
const FRAME = 200

/** The observed false positive: a doormat, 0.0669 above the shipped floor. */
const DOORMAT_SCORE = 0.5669

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function sliders(fields: readonly ConfigField[]): readonly ConfigSliderField[] {
  return fields.filter((f): f is ConfigSliderField => 'type' in f && f.type === 'slider')
}

const stubEngine = {
  run: async (): Promise<Record<string, unknown>> => ({}),
  dispose: async (): Promise<void> => {},
} as unknown as IInferenceEngine

function makeDefaultStep(settings?: Record<string, unknown>): PipelineDefaultStep {
  return {
    addonId: PACKAGE_STEP_ID,
    addonName: PACKAGE_STEP_ID,
    slot: 'detector',
    inputClasses: [],
    outputClasses: ['package'],
    enabled: true,
    modelId: 'yolov8n-package',
    children: [],
    ...(settings ? { settings } : {}),
  }
}

async function frameJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: FRAME,
      height: FRAME,
      channels: 3,
      background: { r: 8, g: 8, b: 8 },
    },
  })
    .jpeg()
    .toBuffer()
}

/**
 * Run the REAL package-detection definition through the REAL tree-builder
 * hydration, with a stub engine returning one `package` box at `score`.
 * Returns the surviving detections plus the discard trail.
 */
async function runPackageDetector(
  score: number,
  operatorSettings?: Record<string, unknown>,
): Promise<{
  readonly kept: readonly string[]
  readonly discardReasons: readonly string[]
}> {
  const hydrated = buildExecutableTree([makeDefaultStep(operatorSettings)], (_stepId, modelId) => ({
    engine: stubEngine,
    modelId,
  }))
  const built = hydrated.roots[0]!
  const engine: IInferenceEngine = {
    runtime: 'onnx',
    device: 'cpu',
    infer: vi.fn(
      async (_input: InferenceInput): Promise<EngineOutput> => ({
        inferenceMs: 1,
        structured: {
          kind: 'detections',
          detections: [{ class: 'package', score, bbox: [20, 20, 60, 60] }],
        },
      }),
    ),
    dispose: async () => {},
  }
  const root: ExecutableStep = { ...built, engine }
  const tree: ExecutableTree = { roots: [root] }
  const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })
  const { result } = await executor.run(
    tree,
    { kind: 'jpeg', data: await frameJpeg() },
    vi.fn(frameJpeg),
    FRAME,
    FRAME,
    101,
    { plane: 'frame' },
  )
  return {
    kept: result.detections.map((d) => d.macroClass),
    discardReasons: (result.discarded ?? []).map((d) => d.reason),
  }
}

describe('package-detection — per-camera confidence surface', () => {
  const step = getStep(PACKAGE_STEP_ID)

  it('declares a confidence slider keyed to the macro class the executor filters on', () => {
    const schema = step.getConfigSchema()
    // Derived, not spelled out: `macroFilterVerdict` builds the key from the
    // detection's macroClass, which for this detector is its single output
    // class. Rename either side and this fails.
    const expectedKey = `minConfidence${capitalize(step.definition.outputClasses[0]!)}`
    const slider = sliders(schema).find((f) => f.key === expectedKey)
    expect(slider, `expected a slider keyed ${expectedKey}`).toBeDefined()
    expect(slider!.min).toBe(0)
    expect(slider!.max).toBe(1)
    // The operator's floor is unchanged by this work — only reachable.
    expect(slider!.default).toBe(step.definition.defaultConfidence)
  })

  it('does NOT add an enable switch — enablement stays zone-driven', () => {
    const keys = step.getConfigSchema().map((f) => ('key' in f ? f.key : ''))
    expect(keys).not.toContain('enabled')
    expect(keys.some((k) => /^enable/i.test(k))).toBe(false)
  })

  it('hydrates the floor into the executable step so the gate has a baseline', () => {
    const tree = buildExecutableTree([makeDefaultStep()], (_stepId, modelId) => ({
      engine: stubEngine,
      modelId,
    }))
    expect(tree.roots[0]!.settings?.['minConfidencePackage']).toBe(0.5)
  })

  it('keeps the doormat at the shipped default (nothing changes without the operator)', async () => {
    const { kept } = await runPackageDetector(DOORMAT_SCORE)
    expect(kept).toEqual(['package'])
  })

  it('an operator raising the slider discards the doormat as below-threshold', async () => {
    const { kept, discardReasons } = await runPackageDetector(DOORMAT_SCORE, {
      minConfidencePackage: 0.6,
    })
    expect(kept).toEqual([])
    expect(discardReasons).toEqual(['below-threshold'])
  })

  it('a slider set BELOW the old pool floor is not a silent no-op', () => {
    // The pool-side floor pre-empts the executor's slider: while it stayed at
    // `defaultConfidence` (0.5) every sub-0.5 slider position was dead, exactly
    // the foot-gun already fixed for object-detection. Lowering a package
    // slider must be able to widen the detector, or the surface lies below
    // its default.
    expect(resolvePoolConfidenceFloor(PACKAGE_STEP_ID, 0.5)).toBeLessThan(0.5)
    // Steps with NO downstream per-macro re-filter keep their own floor.
    expect(resolvePoolConfidenceFloor('face-detection', 0.3)).toBe(0.3)
  })
})
