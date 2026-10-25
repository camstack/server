/**
 * D737 — a YOLO26-seg root supplies the `segmentation` step: the step is not
 * dispatched, and the root's masks reach every consumer in the step's shape.
 */
import type {
  FrameResult,
  ModelCatalogEntry,
  ObjectDetection,
  PipelineStepInputOutput,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { getStepDefinition } from '../../detection-pipeline/registry/step-definitions.js'
import { deriveDetailSteps } from '../index.js'
import {
  applyMaskFill,
  applyRootMasks,
  largestMaskComponent,
  SEGMENTATION_STEP_ID,
} from '../root-mask-supply.js'
import { planRootSupplies } from '../root-supply.js'

const resolve = (stepId: string, modelId: string): ModelCatalogEntry | undefined =>
  getStepDefinition(stepId).models.find((m) => m.id === modelId)

function tree(
  rootModelId: string,
  segmentation: { readonly enabled: boolean; readonly settings?: Record<string, unknown> } | null,
): readonly PipelineStepInputOutput[] {
  return [
    {
      addonId: 'object-detection',
      modelId: rootModelId,
      enabled: true,
      children: [
        { addonId: 'face-detection', enabled: true },
        ...(segmentation !== null
          ? [
              {
                addonId: SEGMENTATION_STEP_ID,
                modelId: 'u2netp',
                enabled: segmentation.enabled,
                ...(segmentation.settings !== undefined ? { settings: segmentation.settings } : {}),
              },
            ]
          : []),
      ],
    },
  ]
}

function childIds(steps: readonly PipelineStepInputOutput[]): readonly string[] {
  return (steps[0]?.children ?? []).map((c) => c.addonId)
}

/** A 4×3 mask: a 2×2 blob in the top-left and one stray pixel bottom-right. */
const MASK_BYTES = Uint8Array.from([
  255,
  255,
  0,
  0, //
  255,
  255,
  0,
  0, //
  0,
  0,
  0,
  255,
])
const MASK = Buffer.from(MASK_BYTES).toString('base64')

function frame(det: Partial<ObjectDetection>): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f1',
    deviceId: 7,
    timestamp: 1,
    width: 640,
    height: 360,
    detections: [
      {
        id: 'd1',
        kind: 'first-level',
        macroClass: 'person',
        score: 0.9,
        bbox: { x: 100, y: 50, width: 40, height: 30 },
        labels: [],
        ...det,
      },
    ],
  }
}

describe('applyMaskFill — the step stands down only under an effective seg root', () => {
  it('seg root + flag on (default): segmentation is not dispatched', () => {
    const steps = tree('yolo26n-seg', { enabled: true })
    const fill = applyMaskFill(steps, planRootSupplies(steps, resolve))
    expect(fill.filledByRoot).toBe(true)
    expect(fill.segmentationDispatched).toBe(false)
    expect(childIds(fill.steps)).toEqual(['face-detection'])
    // Never mutates the attach tree.
    expect(childIds(steps)).toEqual(['face-detection', SEGMENTATION_STEP_ID])
  })

  it('plain root: the step runs its own model, untouched', () => {
    const steps = tree('yolo26n', { enabled: true })
    const fill = applyMaskFill(steps, planRootSupplies(steps, resolve))
    expect(fill).toEqual({ steps, filledByRoot: false, segmentationDispatched: true })
  })

  it('seg root, flag unchecked: the step runs its own model', () => {
    const steps = tree('yolo26n-seg', { enabled: true, settings: { useRootModel: false } })
    const fill = applyMaskFill(steps, planRootSupplies(steps, resolve))
    expect(fill.filledByRoot).toBe(false)
    expect(fill.segmentationDispatched).toBe(true)
    expect(fill.steps).toBe(steps)
  })

  it('segmentation switched off: nothing to fill, nothing dispatched', () => {
    const steps = tree('yolo26n-seg', { enabled: false })
    const fill = applyMaskFill(steps, planRootSupplies(steps, resolve))
    expect(fill).toEqual({ steps, filledByRoot: false, segmentationDispatched: false })
  })

  it('the frame-plane step is never announced to the detail plane', () => {
    const steps = tree('yolo26n-seg', { enabled: true })
    const announces = deriveDetailSteps(steps, planRootSupplies(steps, resolve))
    expect(announces.map((a) => a.stepId)).not.toContain(SEGMENTATION_STEP_ID)
  })
})

describe('applyRootMasks — the root mask in the step’s own shape', () => {
  const filled = { steps: [], filledByRoot: true, segmentationDispatched: false }
  const notInForce = { steps: [], filledByRoot: false, segmentationDispatched: false }
  const stepRan = { steps: [], filledByRoot: false, segmentationDispatched: true }

  it('filled: keeps the mask and derives refinedBbox from its largest component', () => {
    const out = applyRootMasks(frame({ mask: MASK, maskWidth: 4, maskHeight: 3 }), filled)
    const d = out.detections[0]
    expect(d?.mask).toBe(MASK)
    expect([d?.maskWidth, d?.maskHeight]).toEqual([4, 3])
    // 2×2 of a 4×3 mask over a 40×30 box at (100,50) → 20×20 at (100,50).
    expect(d?.refinedBbox).toEqual({ x: 100, y: 50, width: 20, height: 20 })
    expect(d?.bbox).toEqual({ x: 100, y: 50, width: 40, height: 30 })
  })

  it('not in force and the step did not run: a seg root’s masks are removed', () => {
    const input = frame({
      mask: MASK,
      maskWidth: 4,
      maskHeight: 3,
      debug: { mask: MASK, maskWidth: 4, maskHeight: 3, extractMode: 'full-frame' },
    })
    const d = applyRootMasks(input, notInForce).detections[0]
    expect(d?.mask).toBeUndefined()
    expect(d?.maskWidth).toBeUndefined()
    expect(d?.debug).toEqual({ extractMode: 'full-frame' })
  })

  it('the step ran its own model: its masks pass untouched', () => {
    const input = frame({ mask: MASK, maskWidth: 4, maskHeight: 3 })
    expect(applyRootMasks(input, stepRan)).toBe(input)
  })

  it('a plain root (no masks) is returned as is', () => {
    const input = frame({})
    expect(applyRootMasks(input, filled)).toBe(input)
    expect(applyRootMasks(input, notInForce)).toBe(input)
  })
})

describe('largestMaskComponent', () => {
  it('is 4-connected and picks the biggest blob', () => {
    expect(largestMaskComponent(MASK_BYTES, 4, 3)).toEqual([0, 0, 2, 2])
    // Diagonal pixels are separate components.
    expect(largestMaskComponent(Uint8Array.from([255, 0, 0, 255]), 2, 2)).toEqual([0, 0, 1, 1])
  })

  it('no foreground, or a size the bytes do not cover, is null', () => {
    expect(largestMaskComponent(new Uint8Array(6), 3, 2)).toBeNull()
    expect(largestMaskComponent(new Uint8Array(3), 3, 2)).toBeNull()
  })
})
