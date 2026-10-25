/**
 * dispatchPostprocess is structured-only — the Node.js onnxruntime
 * raw-tensor path was REMOVED (operator decision, 2026-08-01): every
 * engine is a Python pool and postprocessing happens in
 * `inference_pool.py`. This spec pins the three halves of that contract:
 *
 *   1. a structured payload passes through (with the classification
 *      normalization funnel applied);
 *   2. an output WITHOUT `structured` throws loudly — there is no
 *      raw-tensor branch left to silently fall back to;
 *   3. a shed output (`dropped: true`) stays an inert empty result.
 */

import type { EngineOutput, ModelCatalogEntry, StepDefinition } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { dispatchPostprocess } from '../dispatch.js'

function makeModelEntry(id: string): ModelCatalogEntry {
  return {
    id,
    name: id,
    description: '',
    formats: {},
    inputSize: { width: 64, height: 64 },
    labels: [],
  }
}

function makeStepDef(postprocessor: StepDefinition['postprocessor']): StepDefinition {
  return {
    id: `test-${postprocessor}`,
    name: `Test ${postprocessor}`,
    slot: 'detector',
    postprocessor,
    extractMode: 'full-frame',
    inputClasses: null,
    outputClasses: ['person'],
    models: [makeModelEntry('stub')],
    defaultModelId: 'stub',
    defaultConfidence: 0.5,
    labels: ['person'],
  }
}

describe('dispatchPostprocess — structured-only contract', () => {
  it('passes a structured detections payload through untouched', () => {
    const out = dispatchPostprocess(
      {
        inferenceMs: 1,
        structured: {
          kind: 'detections',
          detections: [{ class: 'person', score: 0.9, bbox: [1, 2, 3, 4] }],
        },
      },
      makeStepDef('yolo'),
    )
    expect(out.kind).toBe('detections')
    if (out.kind !== 'detections') return
    expect(out.detections).toHaveLength(1)
    expect(out.detections[0]?.class).toBe('person')
  })

  it('normalizes classifications to top-1 + alternates (the shared funnel)', () => {
    const out = dispatchPostprocess(
      {
        inferenceMs: 1,
        structured: {
          kind: 'classifications',
          classifications: [
            { class: 'cat', score: 0.8 },
            { class: 'dog', score: 0.2 },
          ],
        },
      },
      makeStepDef('softmax'),
    )
    expect(out.kind).toBe('classifications')
    if (out.kind !== 'classifications') return
    expect(out.classifications).toHaveLength(1)
    expect(out.classifications[0]?.class).toBe('cat')
    expect(out.alternates).toHaveLength(2)
  })

  it.each([
    'yolo',
    'scrfd',
    'clip',
    'ctc',
    'saliency',
  ] as const)('an output with no structured payload throws for "%s" — no silent raw-tensor fallback', (postprocessor) => {
    // The shape a nodejs-ONNX engine used to emit: no structured payload.
    const rawShaped: EngineOutput = { inferenceMs: 1 }
    expect(() => dispatchPostprocess(rawShaped, makeStepDef(postprocessor))).toThrow(
      /Python inference pool/,
    )
  })

  it('a structured payload with an unknown kind throws (malformed pool output)', () => {
    expect(() =>
      dispatchPostprocess(
        { inferenceMs: 1, structured: { kind: 'nonsense' } },
        makeStepDef('yolo'),
      ),
    ).toThrow(/unexpected kind/)
  })

  it('a shed output stays an inert empty detections result', () => {
    const shed: EngineOutput = { dropped: true, shedReason: 'worker-in-flight-cap', inferenceMs: 0 }
    expect(dispatchPostprocess(shed, makeStepDef('yolo'))).toEqual({
      kind: 'detections',
      detections: [],
    })
  })
})
