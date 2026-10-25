/**
 * The cluster rule at the ONE place every dispatch's model is finally resolved.
 *
 * `resolveInputSteps` is the last thing that runs before a step reaches a pool,
 * for every plane and every caller. If the rule is not enforced here it is not
 * enforced: the live detail plane is the OTHER writer into `identity_samples`
 * and `vec_object_clip` — the re-embed passes are the one people think of, but
 * a live dispatch on a node whose format lacks the chosen encoder is what fills
 * the index the rest of the time.
 *
 * These tests run against the REAL catalog, not a fabricated one, because the
 * property being asserted is about `face-embedding` and `clip-embedding`
 * specifically — a stub catalog would pass whatever the stub declared.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_CLUSTER_STEP_MODELS } from '@camstack/types'
import { resolveInputSteps } from '../step-resolution.js'
import { getStepDefinition } from '../registry/step-definitions.js'

/** A format every catalog model in these tests actually ships. */
const ONNX = 'onnx' as const

const faceTree = [
  {
    addonId: 'object-detection',
    enabled: true,
    children: [
      {
        addonId: 'face-detection',
        enabled: true,
        children: [{ addonId: 'face-embedding', enabled: true, children: [] }],
      },
    ],
  },
]

const faceEmbeddingOf = (steps: readonly { addonId: string; children?: readonly unknown[] }[]) => {
  const det = steps.find((s) => s.addonId === 'object-detection')
  const face = (det?.children as typeof steps | undefined)?.find(
    (s) => s.addonId === 'face-detection',
  )
  return (
    face?.children as
      | Array<{ addonId: string; modelId: string; settings?: Readonly<Record<string, unknown>> }>
      | undefined
  )?.find((s) => s.addonId === 'face-embedding')
}

describe('resolveInputSteps — cluster-scoped steps', () => {
  it('without a cluster row, behaviour is exactly what it was (no regression on deploy)', () => {
    const before = resolveInputSteps(faceTree, ONNX)
    const after = resolveInputSteps(faceTree, ONNX, undefined, DEFAULT_CLUSTER_STEP_MODELS)
    expect(faceEmbeddingOf(after.steps)?.modelId).toBe(faceEmbeddingOf(before.steps)?.modelId)
    expect(faceEmbeddingOf(before.steps)?.modelId).toBe('auraface-r100')
    expect(after.diagnostics.clusterRefusals).toEqual([])
  })

  it('the cluster row OVERRIDES a stale per-node pin on a cluster-scoped step', () => {
    const pinnedStale = [
      {
        addonId: 'object-detection',
        enabled: true,
        children: [
          {
            addonId: 'face-detection',
            enabled: true,
            children: [
              { addonId: 'face-embedding', enabled: true, modelId: 'arcface-r100', children: [] },
            ],
          },
        ],
      },
    ]
    const auraface = getStepDefinition('face-embedding').models.find(
      (m) => m.id === 'auraface-r100',
    )
    expect(
      auraface,
      'the catalog must still ship auraface for this test to mean anything',
    ).toBeDefined()

    const out = resolveInputSteps(pinnedStale, ONNX, undefined, {
      ...DEFAULT_CLUSTER_STEP_MODELS,
      'face-embedding': 'auraface-r100',
    })
    expect(faceEmbeddingOf(out.steps)?.modelId).toBe('auraface-r100')
    // …and it is NOT reported as a substitution: a substitution is a degradation
    // the operator did not ask for; this is the operator's own choice arriving.
    expect(out.diagnostics.substitutions).toEqual([])
  })

  it('leaves NODE-scoped steps entirely alone', () => {
    const out = resolveInputSteps(
      [{ addonId: 'object-detection', enabled: true, modelId: 'yolo26s', children: [] }],
      ONNX,
      undefined,
      DEFAULT_CLUSTER_STEP_MODELS,
    )
    expect(out.steps[0]?.modelId).toBe('yolo26s')
  })

  it('REPORTS a refusal — and KEEPS the step — when the cluster model has no build for this format', () => {
    // `edgetpu` ships tflite. No face embedder in the catalog has a tflite
    // build, so this is the real fleet condition at a Coral.
    const out = resolveInputSteps(faceTree, 'tflite', undefined, DEFAULT_CLUSTER_STEP_MODELS)
    expect(out.diagnostics.clusterRefusals).toEqual([
      {
        stepId: 'face-embedding',
        modelId: 'auraface-r100',
        format: 'tflite',
        formatsShipped: expect.arrayContaining(['onnx']),
      },
    ])
    // The step SURVIVES, carrying the pinned id. Dropping it here would take
    // away the rescue `resolveStepsForDispatch`'s node-local engine fallback and
    // the detail-plane device jump already provide — both of which key off
    // exactly this condition — and would stop producing faces on every
    // mixed-accelerator node. `dispatch-capability-gate.spec.ts` is the test
    // that caught it.
    expect(faceEmbeddingOf(out.steps)?.modelId).toBe('auraface-r100')
  })

  it('does NOT substitute the format default for a refused cluster step', () => {
    const out = resolveInputSteps(faceTree, 'tflite', undefined, DEFAULT_CLUSTER_STEP_MODELS)
    expect(out.diagnostics.substitutions.map((s) => s.addonId)).not.toContain('face-embedding')
  })

  it('the cluster row OVERRIDES leftover per-device admission knobs', () => {
    const leftover = [
      {
        addonId: 'object-detection',
        enabled: true,
        children: [
          {
            addonId: 'face-detection',
            enabled: true,
            children: [
              {
                addonId: 'face-embedding',
                enabled: true,
                settings: { minLandmarkFaceSize: 8 },
                children: [],
              },
            ],
          },
        ],
      },
    ]
    const out = resolveInputSteps(leftover, ONNX, undefined, DEFAULT_CLUSTER_STEP_MODELS, {
      'face-embedding': { minLandmarkFaceSize: 32 },
    })
    expect(faceEmbeddingOf(out.steps)?.settings).toEqual({ minLandmarkFaceSize: 32 })
  })

  it('applies the same rule to clip-embedding — one mechanism, both indexes', () => {
    const clipTree = [
      {
        addonId: 'object-detection',
        enabled: true,
        children: [{ addonId: 'clip-embedding', enabled: true, children: [] }],
      },
    ]
    const out = resolveInputSteps(clipTree, ONNX, undefined, {
      ...DEFAULT_CLUSTER_STEP_MODELS,
      'clip-embedding': 'mobileclip-s2',
    })
    const clip = out.steps[0]?.children?.find((c) => c.addonId === 'clip-embedding')
    expect(clip?.modelId).toBe('mobileclip-s2')
  })
})
