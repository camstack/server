import { describe, expect, it } from 'vitest'
import {
  type AssemblyContext,
  applyChildOutput,
  FrameIdGenerator,
  type MutableObjectDetection,
} from '../pipeline/result-assembler.js'
import type { ExecutableStep } from '../pipeline/tree-builder.js'

/** A plate detail accumulator a `plate-ocr` `text` output attaches its label to. */
function makePlateDetail(): MutableObjectDetection {
  return {
    id: 'd2',
    kind: 'detail',
    macroClass: 'plate',
    score: 0.9,
    bbox: [10, 10, 120, 40],
    parentId: 'd1',
    ownLabels: [],
    alternateLabels: {},
    stepLatencyMs: {},
    modelIds: {},
  }
}

/** Minimal plate-ocr step. Since 4g the text case also reads the step's
 *  DECLARED `labelTier` — a plate read is tier 2, the instance. */
function fakePlateOcrStep(): ExecutableStep {
  return {
    stepId: 'plate-ocr',
    modelId: 'vgg-english-g2',
    definition: { labelTier: 2 },
  } as unknown as ExecutableStep
}

function attachText(text: string, confidence: number): MutableObjectDetection {
  const plate = makePlateDetail()
  const ctx: AssemblyContext = { idGen: new FrameIdGenerator(), details: [] }
  applyChildOutput(plate, fakePlateOcrStep(), { kind: 'text', text, confidence }, 5, ctx)
  return plate
}

describe('result-assembler — plate-ocr text gate', () => {
  it('stores a recognized plate label with its confidence', () => {
    const plate = attachText('DWRO309', 0.86)
    expect(plate.ownLabels).toEqual([
      { label: 'DWRO309', score: 0.86, tier: 2, stepId: 'plate-ocr', modelId: 'vgg-english-g2' },
    ])
  })

  it('does NOT store an empty text label (the gated low-res collapse)', () => {
    // The CTC postprocessor returns empty text for the degenerate near-all-blank
    // collapse — that must never surface as a stored plate label.
    const plate = attachText('', 0.4)
    expect(plate.ownLabels).toEqual([])
  })

  it('does NOT store a whitespace-only text label', () => {
    const plate = attachText('   ', 0.4)
    expect(plate.ownLabels).toEqual([])
  })
})
