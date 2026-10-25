/**
 * D730 — the runner decides from the camera's whole tree whether the root
 * model's output IS a step's result: the linked-label score and class filter,
 * root child boxes, the `filledBy` announce, and the package root standing down.
 */
import {
  type FrameResult,
  plusCatalogLabelFields,
  type ModelCatalogEntry,
  type ObjectDetection,
  type PipelineStepInputOutput,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { getStepDefinition } from '../../detection-pipeline/registry/step-definitions.js'
import { deriveDetailSteps } from '../index.js'
import { withPackageLook } from '../motion-settle-governor.js'
import {
  applyPackageFill,
  applyRootSupplyAuthority,
  EMPTY_ROOT_SUPPLY_PLAN,
  newlySuppliedSteps,
  planRootSupplies,
} from '../root-supply.js'

const PLUS_LABELS = ['person', 'car', 'deer', 'dog', 'package', 'license_plate', 'face'] as const
const PLUS: ModelCatalogEntry = {
  id: 'frigate-plus',
  name: 'plus catalog',
  description: '',
  formats: {},
  inputSize: { width: 320, height: 320 },
  labels: PLUS_LABELS.map((l) => ({ id: l, name: l })),
  provider: 'frigate',
  ...plusCatalogLabelFields(PLUS_LABELS),
}
/** A plugin catalog-style root: its labels ARE the macros, so it supplies nothing. */
const PLUGIN_ROOT: ModelCatalogEntry = {
  id: 'plugin-catalog-root',
  name: 'plugin catalog',
  description: '',
  formats: {},
  inputSize: { width: 320, height: 320 },
  labels: ['person', 'vehicle', 'animal'].map((l) => ({ id: l, name: l })),
  classMap: {
    mapping: { person: 'person', vehicle: 'vehicle', animal: 'animal' },
    preserveOriginal: false,
  },
}
const resolve = (stepId: string, modelId: string): ModelCatalogEntry | undefined =>
  modelId === PLUS.id
    ? PLUS
    : modelId === PLUGIN_ROOT.id
      ? PLUGIN_ROOT
      : getStepDefinition(stepId).models.find((m) => m.id === modelId)

function tree(
  rootModelId: string | undefined,
  animalSettings: Record<string, unknown> | undefined,
  opts: { readonly packageZone?: boolean; readonly plateSettings?: Record<string, unknown> } = {},
): readonly PipelineStepInputOutput[] {
  return [
    {
      addonId: 'object-detection',
      ...(rootModelId !== undefined ? { modelId: rootModelId } : {}),
      enabled: true,
      settings: { enabledMacroClasses: ['person', 'vehicle', 'animal'] },
      children: [
        {
          addonId: 'animal-classifier',
          modelId: 'animal-classifier',
          enabled: true,
          ...(animalSettings !== undefined ? { settings: animalSettings } : {}),
        },
        { addonId: 'vehicle-classifier', enabled: true },
        {
          addonId: 'plate-detection',
          enabled: true,
          ...(opts.plateSettings !== undefined ? { settings: opts.plateSettings } : {}),
          children: [{ addonId: 'plate-ocr', enabled: true }],
        },
      ],
    },
    ...(opts.packageZone === true
      ? [{ addonId: 'package-detection', enabled: true, settings: { minConfidencePackage: 0.7 } }]
      : []),
  ]
}

describe('planRootSupplies', () => {
  it('no root ⇒ the empty plan', () => {
    expect(planRootSupplies([{ addonId: 'zone-only', enabled: true }], resolve)).toBe(
      EMPTY_ROOT_SUPPLY_PLAN,
    )
  })

  it('an unpinned root with no elected device runs the static COCO default, which supplies the classifiers', () => {
    const plan = planRootSupplies(tree(undefined, undefined), resolve)
    expect(plan.rootModelId).toBe(getStepDefinition('object-detection').defaultModelId)
    expect(plan.states.get('animal-classifier')).toMatchObject({ effective: true })
    expect(plan.states.get('vehicle-classifier')).toMatchObject({ effective: true })
  })

  it("an unpinned root is judged as the elected device's own default — the model the executor runs", () => {
    // The live hub: no root pin, cameras elected onto openvino:gpu / coreml:all.
    // The runner used to name `yolo26n` for both while the devices ran yolov9m.
    expect(planRootSupplies(tree(undefined, undefined), resolve, 'openvino:gpu').rootModelId).toBe(
      'yolov9m-320-int8',
    )
    expect(planRootSupplies(tree(undefined, undefined), resolve, 'coreml:all').rootModelId).toBe(
      'yolov9m-320',
    )
    // A pin is the pin, whatever the device.
    expect(planRootSupplies(tree(PLUS.id, undefined), resolve, 'openvino:gpu').rootModelId).toBe(
      PLUS.id,
    )
    // An unknown backend degrades to the flat default instead of throwing.
    expect(planRootSupplies(tree(undefined, undefined), resolve, 'warp:9').rootModelId).toBe(
      getStepDefinition('object-detection').defaultModelId,
    )
  })

  it('a step the camera does not run is not planned — the per-camera gate wins over the root', () => {
    const steps: readonly PipelineStepInputOutput[] = [
      { addonId: 'object-detection', modelId: PLUS.id, enabled: true, children: [] },
    ]
    const plan = planRootSupplies(steps, resolve)
    expect(plan.states.has('animal-classifier')).toBe(false)
    expect(plan.states.has('package-detection')).toBe(false)
    expect(newlySuppliedSteps(undefined, plan)).toEqual([])
    // The root's linked label stays the score-0 fallback the executor wrote.
    const input = frame([animal([LINKED_DEER])])
    expect(applyRootSupplyAuthority(input, plan)).toBe(input)
    // A step present but switched off is the same answer.
    const off = tree(PLUS.id, undefined).map((root) => ({
      ...root,
      children: root.children?.map((c) =>
        c.addonId === 'animal-classifier' ? { ...c, enabled: false } : c,
      ),
    }))
    expect(planRootSupplies(off, resolve).states.has('animal-classifier')).toBe(false)
  })

  it('the flag is the step intent: off ⇒ the classifier runs its own model', () => {
    const plan = planRootSupplies(tree(PLUS.id, { useRootModel: false }), resolve)
    expect(plan.states.get('animal-classifier')).toMatchObject({ intent: false, effective: false })
  })

  it('root switch CamStack → plus catalog → plugin catalog → back keeps the intent and the model', () => {
    const settings = { useRootModel: true }
    const roots = ['yolo26n', PLUS.id, PLUGIN_ROOT.id, 'yolo26n']
    const effective = roots.map(
      (r) =>
        planRootSupplies(tree(r, settings), resolve).states.get('animal-classifier')?.effective,
    )
    expect(effective).toEqual([true, true, false, true])
    const pluginCatalogTree = tree(PLUGIN_ROOT.id, settings)
    planRootSupplies(pluginCatalogTree, resolve)
    expect(pluginCatalogTree[0]?.children?.[0]?.modelId).toBe('animal-classifier')
  })

  it('plates: default off, effective once opted in on a root that draws them', () => {
    expect(
      planRootSupplies(tree(PLUS.id, undefined), resolve).states.get('plate-detection')?.effective,
    ).toBe(false)
    const plan = planRootSupplies(
      tree(PLUS.id, undefined, { plateSettings: { useRootModel: true } }),
      resolve,
    )
    expect(plan.states.get('plate-detection')).toMatchObject({ effective: true })
  })

  it('newlySuppliedSteps names a step only on the plan where it BECOMES supplied', () => {
    const coco = planRootSupplies(tree('yolo26n', undefined), resolve)
    const plus = planRootSupplies(tree(PLUS.id, undefined), resolve)
    const plusWithZone = planRootSupplies(tree(PLUS.id, undefined, { packageZone: true }), resolve)
    expect(newlySuppliedSteps(undefined, coco)).toEqual(['animal-classifier', 'vehicle-classifier'])
    expect(newlySuppliedSteps(coco, plus)).toEqual([])
    expect(newlySuppliedSteps(coco, plusWithZone)).toEqual(['package-detection'])
    expect(newlySuppliedSteps(plus, plus)).toEqual([])
  })
})

describe('deriveDetailSteps — filledBy + filledAs', () => {
  it('announces an effective step with the model and the kind, and only those', () => {
    const steps = tree(PLUS.id, undefined, { plateSettings: { useRootModel: true } })
    const announces = deriveDetailSteps(steps, planRootSupplies(steps, resolve))
    const byStep = new Map(announces.map((a) => [a.stepId, a]))
    expect(byStep.get('animal-classifier')).toMatchObject({
      filledBy: 'frigate-plus',
      filledAs: 'label',
    })
    expect(byStep.get('plate-detection')).toMatchObject({
      filledBy: 'frigate-plus',
      filledAs: 'crop',
    })
  })

  it('flag off ⇒ no filledBy', () => {
    const steps = tree(PLUS.id, { useRootModel: false })
    const announces = deriveDetailSteps(steps, planRootSupplies(steps, resolve))
    expect(announces.find((a) => a.stepId === 'animal-classifier')?.filledBy).toBeUndefined()
  })
})

function animal(labels: ObjectDetection['labels']): ObjectDetection {
  return {
    id: 'd1',
    kind: 'first-level',
    macroClass: 'animal',
    score: 0.83,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    labels,
  }
}

function frame(detections: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f',
    deviceId: 1,
    timestamp: 0,
    width: 640,
    height: 480,
    detections: [...detections],
  }
}

const LINKED_DEER = {
  label: 'deer',
  score: 0,
  tier: 1 as const,
  stepId: 'detector-link:animal-classifier',
  modelId: 'frigate-plus',
}

describe('applyRootSupplyAuthority', () => {
  it('effective ⇒ the root label is authoritative at the detection score', () => {
    const out = applyRootSupplyAuthority(
      frame([animal([LINKED_DEER])]),
      planRootSupplies(tree(PLUS.id, undefined), resolve),
    )
    expect(out.detections[0]?.labels[0]?.score).toBe(0.83)
  })

  it('effective + the class switched off ⇒ the label is dropped, the detection stays animal', () => {
    const out = applyRootSupplyAuthority(
      frame([animal([LINKED_DEER])]),
      planRootSupplies(tree(PLUS.id, { enabledClasses: ['dog'] }), resolve),
    )
    expect(out.detections[0]?.labels).toEqual([])
    expect(out.detections[0]?.macroClass).toBe('animal')
  })

  it('not effective ⇒ the score-0 fallback is left as written', () => {
    const input = frame([animal([LINKED_DEER])])
    const out = applyRootSupplyAuthority(
      input,
      planRootSupplies(tree(PLUS.id, { useRootModel: false }), resolve),
    )
    expect(out).toBe(input)
  })

  it('a root plate box is kept only while the plate supply is effective', () => {
    const vehicle: ObjectDetection = { ...animal([]), macroClass: 'vehicle' }
    const plate: ObjectDetection = {
      id: 'd2',
      kind: 'detail',
      macroClass: 'plate',
      score: 0.7,
      bbox: { x: 2, y: 6, width: 4, height: 1 },
      labels: [],
      parentId: 'd1',
      rootSupplied: { stepId: 'plate-detection', modelId: 'frigate-plus' },
    }
    const off = applyRootSupplyAuthority(
      frame([vehicle, plate]),
      planRootSupplies(tree(PLUS.id, undefined), resolve),
    )
    expect(off.detections.map((d) => d.id)).toEqual(['d1'])
    const on = applyRootSupplyAuthority(
      frame([vehicle, plate]),
      planRootSupplies(
        tree(PLUS.id, undefined, { plateSettings: { useRootModel: true } }),
        resolve,
      ),
    )
    expect(on.detections.map((d) => d.id)).toEqual(['d1', 'd2'])
  })
})

describe('applyPackageFill', () => {
  it('a package zone + a root that supplies package ⇒ the package root stands down', () => {
    const steps = tree(PLUS.id, undefined, { packageZone: true })
    const out = applyPackageFill(steps, planRootSupplies(steps, resolve))
    expect(out.filledByRoot).toBe(true)
    expect(out.steps.map((s) => s.addonId)).toEqual(['object-detection'])
    expect(out.steps[0]?.settings).toMatchObject({
      enabledMacroClasses: ['person', 'vehicle', 'animal', 'package'],
      minConfidencePackage: 0.7,
    })
  })

  it('a COCO root has no package ⇒ the flag is inactive and the package step runs its model', () => {
    const steps = tree('yolo26n', undefined, { packageZone: true })
    const out = applyPackageFill(steps, planRootSupplies(steps, resolve))
    expect(out).toEqual({ steps, filledByRoot: false })
  })

  it('an absent allow-list admits package on top of the schema default', () => {
    const steps: readonly PipelineStepInputOutput[] = [
      { addonId: 'object-detection', modelId: PLUS.id, enabled: true },
      { addonId: 'package-detection', enabled: true },
    ]
    const out = applyPackageFill(steps, planRootSupplies(steps, resolve))
    expect(out.steps[0]?.settings?.['enabledMacroClasses']).toEqual([
      'person',
      'vehicle',
      'animal',
      'package',
    ])
  })

  it('the package flag off ⇒ untouched', () => {
    const steps: readonly PipelineStepInputOutput[] = [
      { addonId: 'object-detection', modelId: PLUS.id, enabled: true },
      { addonId: 'package-detection', enabled: true, settings: { useRootModel: false } },
    ]
    const out = applyPackageFill(steps, planRootSupplies(steps, resolve))
    expect(out).toEqual({ steps, filledByRoot: false })
  })

  it('a root supplying package stamps every frame it ran as a package look', () => {
    expect(withPackageLook(frame([]), [], true).packageLooked).toBe(true)
    expect(withPackageLook(frame([]), [], false).packageLooked).toBeUndefined()
  })
})
