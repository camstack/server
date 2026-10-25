/**
 * D741 — a species / vehicle type the ROOT detector supplies is gated by a
 * floor on the detection's score, per root model.
 *
 * With every catalog detector, `dog` / `cat` / `bus` come from the root's own
 * class (D736) at the detection's score, and no step threshold applied to them:
 * only the macro floor. Measured 2026-10-07, a 320 root names the right species
 * ~74% of the time at the macro floor and ~89% from 0.75. So the step's
 * `minConfidence` slider governs the supplied label too — model-bound to the
 * ROOT model, defaulting to that root's measured floor. Below it the label is
 * dropped and the detection keeps its macro class; the detection itself is
 * never dropped. The Coral SSD names species wrongly 3 times in 4: its floor
 * is "never".
 */
import {
  type FrameResult,
  modelBindingKey,
  type ModelCatalogEntry,
  type ObjectDetection,
  type PipelineStepInputOutput,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { getStepDefinition } from '../../detection-pipeline/registry/step-definitions.js'
import { applyRootSupplyAuthority, planRootSupplies } from '../root-supply.js'

const V9 = 'yolov9m-320-int8'
const SSD = 'ssd-mobilenet-v2-coco-edgetpu'
const UNMEASURED = 'yolo26l'

const resolve = (stepId: string, modelId: string): ModelCatalogEntry | undefined =>
  getStepDefinition(stepId).models.find((m) => m.id === modelId)

function tree(
  rootModelId: string,
  animalSettings?: Record<string, unknown>,
): readonly PipelineStepInputOutput[] {
  return [
    {
      addonId: 'object-detection',
      modelId: rootModelId,
      enabled: true,
      children: [
        {
          addonId: 'animal-classifier',
          modelId: 'animal-classifier',
          enabled: true,
          ...(animalSettings !== undefined ? { settings: animalSettings } : {}),
        },
      ],
    },
  ]
}

function dog(score: number, rootModelId: string): ObjectDetection {
  return {
    id: 'd1',
    kind: 'first-level',
    macroClass: 'animal',
    score,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    labels: [
      {
        label: 'dog',
        score: 0,
        tier: 1,
        stepId: 'detector-link:animal-classifier',
        modelId: rootModelId,
      },
    ],
  }
}

function frame(detection: ObjectDetection): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f',
    deviceId: 1,
    timestamp: 0,
    width: 640,
    height: 480,
    detections: [detection],
  }
}

function speciesOf(
  rootModelId: string,
  score: number,
  settings?: Record<string, unknown>,
): readonly string[] {
  const out = applyRootSupplyAuthority(
    frame(dog(score, rootModelId)),
    planRootSupplies(tree(rootModelId, settings), resolve),
  )
  const d = out.detections[0]
  if (d === undefined) throw new Error('the detection itself was dropped')
  expect(d.macroClass).toBe('animal')
  return d.labels.map((l) => l.label)
}

describe('root-supplied species floor', () => {
  it('above the root model’s floor the species is the root’s', () => {
    expect(speciesOf(V9, 0.8)).toEqual(['dog'])
  })

  it('below it the species is dropped and the detection stays "animal"', () => {
    expect(speciesOf(V9, 0.6)).toEqual([])
  })

  it('a root with no measured floor keeps today’s behaviour: the macro floor only', () => {
    expect(speciesOf(UNMEASURED, 0.3)).toEqual(['dog'])
  })

  it('the Coral SSD never supplies a species', () => {
    expect(speciesOf(SSD, 0.99)).toEqual([])
  })

  it('the step slider, bound to the ROOT model, overrides the root’s floor', () => {
    const settings = { minConfidence: 0.5, [modelBindingKey('minConfidence')]: V9 }
    expect(speciesOf(V9, 0.6, settings)).toEqual(['dog'])
  })

  it('a value bound to the classifier’s own model does not govern the root’s label', () => {
    const settings = { minConfidence: 0.5, [modelBindingKey('minConfidence')]: 'animal-classifier' }
    expect(speciesOf(V9, 0.6, settings)).toEqual([])
  })
})
