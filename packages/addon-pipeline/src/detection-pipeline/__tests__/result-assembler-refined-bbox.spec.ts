import { describe, it, expect } from 'vitest'
import { applyChildOutput, buildFrameResult } from '../pipeline/result-assembler'
import type { MutableObjectDetection } from '../pipeline/result-assembler'
import type { StepOutput } from '@camstack/types'

// Minimal refiner child step on the 'refiner' slot, postprocessor 'saliency'.
function makeRefinerStep() {
  return {
    stepId: 'segmentation',
    modelId: 'u2netp',
    definition: { slot: 'refiner', postprocessor: 'saliency' },
  } as unknown as Parameters<typeof applyChildOutput>[1]
}

function makeParent(): MutableObjectDetection {
  return {
    id: 'd1',
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    bbox: [100, 200, 200, 400], // x1,y1,x2,y2 → parentW=100, parentH=200
    ownLabels: [],
    alternateLabels: {},
    stepLatencyMs: {},
    modelIds: {},
  }
}

function makeCtx() {
  return { idGen: { next: () => 'x' }, details: [] } as unknown as Parameters<
    typeof applyChildOutput
  >[4]
}

describe('applyChildOutput — segmentation refinedBbox mapping', () => {
  it('maps mask-space maskBbox into frame coords as refinedBbox', () => {
    const parent = makeParent()
    // 100x100 mask; largest component box at (10,20) size 40x50.
    const out: StepOutput = {
      kind: 'mask',
      mask: 'AAAA',
      maskWidth: 100,
      maskHeight: 100,
      maskBbox: [10, 20, 40, 50],
    }
    applyChildOutput(parent, makeRefinerStep(), out, 1, makeCtx())
    // x1 = 100 + (10/100)*100 = 110 ; y1 = 200 + (20/100)*200 = 240
    // x2 = 100 + (50/100)*100 = 150 ; y2 = 200 + (70/100)*200 = 340
    expect(parent.refinedBbox).toEqual([110, 240, 150, 340])
    expect(parent.mask).toBe('AAAA')
  })

  it('attaches mask but no refinedBbox when maskBbox is absent', () => {
    const parent = makeParent()
    const out: StepOutput = { kind: 'mask', mask: 'AAAA', maskWidth: 100, maskHeight: 100 }
    applyChildOutput(parent, makeRefinerStep(), out, 1, makeCtx())
    expect(parent.mask).toBe('AAAA')
    expect(parent.refinedBbox).toBeUndefined()
  })
})

describe('buildFrameResult — finalize path promotes refinedBbox + mask to immutable ObjectDetection', () => {
  it('converts tuple refinedBbox to {x,y,width,height} rect and preserves root mask after mask output', () => {
    // Build a MutableObjectDetection that already has mask + refinedBbox attached
    // (as applyChildOutput would leave it after a case 'mask' output with maskBbox).
    // bbox: [100,200,200,400] → parentW=100, parentH=200
    // maskBbox: [10,20,40,50] on a 100×100 mask
    //   x1 = 100 + (10/100)*100 = 110
    //   y1 = 200 + (20/100)*200 = 240
    //   x2 = 100 + (50/100)*100 = 150  (mbx+mbw = 10+40 = 50)
    //   y2 = 200 + (70/100)*200 = 340  (mby+mbh = 20+50 = 70)
    // So refinedBbox tuple = [110, 240, 150, 340]
    // bboxTupleToRect → { x:110, y:240, width:40, height:100 }
    const mutableDetection: MutableObjectDetection = {
      id: 'd1',
      kind: 'first-level',
      macroClass: 'person',
      score: 0.9,
      bbox: [100, 200, 200, 400],
      ownLabels: [],
      alternateLabels: {},
      stepLatencyMs: {},
      modelIds: {},
      mask: 'AAAA',
      maskWidth: 100,
      maskHeight: 100,
      refinedBbox: [110, 240, 150, 340],
    }

    const frame = buildFrameResult({
      deviceId: 1,
      width: 1280,
      height: 720,
      firstLevel: [mutableDetection],
      details: [],
      stepTimings: [],
      totalMs: 10,
      engine: 'onnx+cpu',
      debug: true,
      timestamp: 1_700_000_000_000,
    })

    expect(frame.detections).toHaveLength(1)
    const det = frame.detections[0]!

    // Root refinedBbox must be promoted as a rect (bboxTupleToRect conversion)
    expect(det.refinedBbox).toEqual({ x: 110, y: 240, width: 40, height: 100 })

    // Root mask string must be present
    expect(det.mask).toBe('AAAA')
  })
})
