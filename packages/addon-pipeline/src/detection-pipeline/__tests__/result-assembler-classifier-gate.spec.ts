import type { StepOutput } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeInferenceEngineStub } from '../../__tests__/support/inference-engine-stub.js'
import { makeClassifierStepDefinition } from '../../__tests__/support/step-definition.js'
import {
  type AssemblyContext,
  applyChildOutput,
  FrameIdGenerator,
  type MutableObjectDetection,
} from '../pipeline/result-assembler.js'
import type { ExecutableStep } from '../pipeline/tree-builder.js'

/** A minimal `animal` parent that a classifier child attaches labels to. */
function makeAnimal(id: string): MutableObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'animal',
    score: 0.9,
    bbox: [0, 0, 100, 100],
    ownLabels: [],
    alternateLabels: {},
    stepLatencyMs: {},
    modelIds: {},
  }
}

/**
 * Build a classifier `ExecutableStep`. `applyChildOutput` reads only
 * `stepId`, `modelId`, `settings`, and `definition.{slot,rejectClasses}` on the
 * classifications path — the heavy engine/children fields are unused here.
 */
function classifierStep(
  stepId: string,
  opts: {
    readonly minConfidence?: number
    readonly enabledClasses?: readonly string[]
    readonly rejectClasses?: readonly string[]
    /** The step's DECLARED label tier (4g). Absent ⇒ the label reaches
     *  persistence with no tier and is refused there — which is the point. */
    readonly labelTier?: 1 | 2
  } = {},
): ExecutableStep {
  const definition = makeClassifierStepDefinition({
    id: stepId,
    rejectClasses: opts.rejectClasses,
    labelTier: opts.labelTier,
  })
  const settings: Record<string, unknown> = {}
  if (opts.minConfidence !== undefined) settings['minConfidence'] = opts.minConfidence
  if (opts.enabledClasses !== undefined) settings['enabledClasses'] = opts.enabledClasses
  return {
    stepId,
    modelId: 'm',
    definition,
    settings,
    engine: makeInferenceEngineStub(),
    inputClasses: ['animal'],
    enabled: true,
    children: [],
  }
}

function classifications(
  entries: ReadonlyArray<{ class: string; score: number }>,
): Extract<StepOutput, { kind: 'classifications' }> {
  return { kind: 'classifications', classifications: entries }
}

function apply(parent: MutableObjectDetection, step: ExecutableStep, out: StepOutput): void {
  const ctx: AssemblyContext = { idGen: new FrameIdGenerator(), details: [] }
  applyChildOutput(parent, step, out, 5, ctx)
}

describe('classifier confidence gate — minConfidence on the top-1 winner', () => {
  it('emits the winner label when top-1 score is at/above the gate', () => {
    const animal = makeAnimal('d1')
    apply(
      animal,
      classifierStep('animal-classifier', { minConfidence: 0.5, labelTier: 1 }),
      classifications([{ class: 'dog', score: 0.82 }]),
    )
    // The tier + attribution ride WITH the text since 4g — a label that lost
    // them here would arrive at persistence with no declared tier and be refused.
    expect(animal.ownLabels).toEqual([
      { label: 'dog', score: 0.82, tier: 1, stepId: 'animal-classifier', modelId: 'm' },
    ])
  })

  it('emits NO winner label when top-1 score is below the gate', () => {
    const animal = makeAnimal('d1')
    apply(
      animal,
      classifierStep('animal-classifier', { minConfidence: 0.5 }),
      classifications([{ class: 'dog', score: 0.31 }]),
    )
    expect(animal.ownLabels).toEqual([])
    // alternates are never gated by threshold — the UI still shows the score
    expect(animal.alternateLabels['animal-classifier']).toEqual([{ label: 'dog', score: 0.31 }])
  })
})

describe('bird classifier — background reject + high threshold', () => {
  it('rejects a `background` top-1 entirely (no label, not even an alternate)', () => {
    const animal = makeAnimal('d1')
    apply(
      animal,
      classifierStep('bird-classifier', { minConfidence: 0.6, rejectClasses: ['background'] }),
      classifications([
        { class: 'background', score: 0.97 },
        { class: 'Cyanocitta cristata', score: 0.02 },
      ]),
    )
    // background never surfaces as a label
    expect(animal.ownLabels).toEqual([])
    // and it is stripped from the alternates too (only the real species remains)
    expect(animal.alternateLabels['bird-classifier']).toEqual([
      { label: 'Cyanocitta cristata', score: 0.02 },
    ])
  })

  it('rejects a real species below the 0.6 gate', () => {
    const animal = makeAnimal('d1')
    apply(
      animal,
      classifierStep('bird-classifier', { minConfidence: 0.6, rejectClasses: ['background'] }),
      classifications([{ class: 'Cyanocitta cristata', score: 0.42 }]),
    )
    expect(animal.ownLabels).toEqual([])
  })

  it('emits a confident real species above the 0.6 gate', () => {
    const animal = makeAnimal('d1')
    apply(
      animal,
      classifierStep('bird-classifier', {
        minConfidence: 0.6,
        rejectClasses: ['background'],
        labelTier: 2,
      }),
      classifications([{ class: 'Cyanocitta cristata', score: 0.88 }]),
    )
    expect(animal.ownLabels).toEqual([
      {
        label: 'Cyanocitta cristata',
        score: 0.88,
        tier: 2,
        stepId: 'bird-classifier',
        modelId: 'm',
      },
    ])
  })

  it('reject match is case-insensitive', () => {
    const animal = makeAnimal('d1')
    apply(
      animal,
      classifierStep('bird-classifier', { minConfidence: 0, rejectClasses: ['background'] }),
      classifications([{ class: 'Background', score: 0.99 }]),
    )
    expect(animal.ownLabels).toEqual([])
  })
})

describe('classifier class-filter drop is NOT silent', () => {
  // A branch that drops work silently reads as "never happened" (CLAUDE.md).
  // The 2026-08-21 sheep incident was diagnosed blind precisely because an
  // excluded-class drop left no trace: the callback is the executor's hook to
  // log it with `tags: { deviceId }`.
  it('reports a confident winner excluded by enabledClasses (detection keeps its macro class)', () => {
    const animal = makeAnimal('d1')
    const drops: unknown[] = []
    const ctx: AssemblyContext = {
      idGen: new FrameIdGenerator(),
      details: [],
      onClassifierClassDropped: (info) => drops.push(info),
    }
    applyChildOutput(
      animal,
      classifierStep('animal-classifier', {
        minConfidence: 0.5,
        enabledClasses: ['bird', 'cat', 'dog', 'squirrel', 'horse'],
      }),
      classifications([{ class: 'sheep', score: 0.75 }]),
      5,
      ctx,
    )
    // The excluded species never leaves the step — no label, no alternate —
    // and the detection stands as the macro `animal` it already was.
    expect(animal.ownLabels).toEqual([])
    expect(animal.alternateLabels['animal-classifier']).toBeUndefined()
    expect(animal.macroClass).toBe('animal')
    expect(drops).toEqual([
      {
        stepId: 'animal-classifier',
        modelId: 'm',
        droppedClass: 'sheep',
        score: 0.75,
        reason: 'class-not-enabled',
      },
    ])
  })

  it('reports a rejected class; stays silent for a winner merely under the confidence gate', () => {
    const animal = makeAnimal('d1')
    const drops: unknown[] = []
    const ctx: AssemblyContext = {
      idGen: new FrameIdGenerator(),
      details: [],
      onClassifierClassDropped: (info) => drops.push(info),
    }
    applyChildOutput(
      animal,
      classifierStep('bird-classifier', { minConfidence: 0.6, rejectClasses: ['background'] }),
      classifications([{ class: 'background', score: 0.97 }]),
      5,
      ctx,
    )
    expect(drops).toEqual([
      {
        stepId: 'bird-classifier',
        modelId: 'm',
        droppedClass: 'background',
        score: 0.97,
        reason: 'reject-class',
      },
    ])

    // Below-threshold is the NORMAL uncertain case, not dropped work — the
    // alternates still carry the score. No report.
    drops.length = 0
    applyChildOutput(
      animal,
      classifierStep('animal-classifier', { minConfidence: 0.5, enabledClasses: ['dog'] }),
      classifications([{ class: 'dog', score: 0.31 }]),
      5,
      ctx,
    )
    expect(drops).toEqual([])
  })
})

describe('classifier enabledClasses allow-list still composes with the gate', () => {
  it('drops a winner not in the allow-list, keeps an allowed one', () => {
    const animal = makeAnimal('d1')
    apply(
      animal,
      classifierStep('animal-classifier', { minConfidence: 0.2, enabledClasses: ['cat'] }),
      classifications([
        { class: 'dog', score: 0.9 },
        { class: 'cat', score: 0.05 },
      ]),
    )
    // top-1 `dog` is not allowed → no own label; `cat` is allowed but the
    // top-1 winner path only considers classifications[0]. So no ownLabel here.
    expect(animal.ownLabels).toEqual([])
    // alternates keep only the allowed class
    expect(animal.alternateLabels['animal-classifier']).toEqual([{ label: 'cat', score: 0.05 }])
  })
})
