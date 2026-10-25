/**
 * D737 — a YOLO26-seg root supplies the `segmentation` step's masks, on top of
 * everything the plain COCO detector supplies; effective only while the
 * current root's decode emits masks.
 */
import { describe, expect, it } from 'vitest'
import { RootStepSupplySchema } from '../../types/models.js'
import {
  deriveMaskSupplies,
  describeRootSupplies,
  isRootSuppliableStepId,
  readUseRootModel,
  resolveRootSupply,
  rootSuppliesOf,
  supplyFor,
} from '../root-model-supply.js'
import { COCO_80_LABELS, COCO_TO_MACRO } from '../coco-classmap.js'

const IN_640 = { width: 640, height: 640 }
const STEP_DEFAULTS = { labels: COCO_80_LABELS.map((l) => l.id), classMap: COCO_TO_MACRO }

/** A built-in COCO root: no labels of its own, the step's decode. */
const PLAIN_ROOT = { labels: [], inputSize: IN_640 }
/** The same COCO root built with the instance-segmentation head. */
const SEG_ROOT = { labels: [], inputSize: IN_640, postprocessor: 'yolo-seg' as const }

describe('a seg root declares masks', () => {
  it('only a decode that emits masks declares the segmentation step', () => {
    expect(deriveMaskSupplies('yolo-seg')).toEqual([{ kind: 'mask', stepId: 'segmentation' }])
    expect(deriveMaskSupplies('yolo')).toEqual([])
    expect(deriveMaskSupplies('ssd')).toEqual([])
    expect(deriveMaskSupplies(undefined)).toEqual([])
  })

  it('declares masks PLUS everything the plain COCO detector declares', () => {
    const plain = rootSuppliesOf(PLAIN_ROOT, STEP_DEFAULTS)
    const seg = rootSuppliesOf(SEG_ROOT, STEP_DEFAULTS)
    expect(supplyFor(plain, 'segmentation')).toBeUndefined()
    expect(supplyFor(seg, 'segmentation')).toEqual({ kind: 'mask', stepId: 'segmentation' })
    expect(seg.filter((s) => s.kind !== 'mask')).toEqual(plain)
    expect(describeRootSupplies(plain)).toBe('animals 6/8 · vehicles 5/8')
    expect(describeRootSupplies(seg)).toBe('animals 6/8 · vehicles 5/8 · masks')
  })

  it('a stored label declaration still gains the mask its decode emits', () => {
    const stored = rootSuppliesOf(PLAIN_ROOT, STEP_DEFAULTS)
    const seg = rootSuppliesOf({ ...SEG_ROOT, suppliesSteps: stored }, STEP_DEFAULTS)
    expect(supplyFor(seg, 'segmentation')?.kind).toBe('mask')
    expect(seg.filter((s) => s.kind === 'mask')).toHaveLength(1)
  })

  it('the mask supply is a valid wire shape (the cap schema carries it)', () => {
    expect(RootStepSupplySchema.parse({ kind: 'mask', stepId: 'segmentation' })).toEqual({
      kind: 'mask',
      stepId: 'segmentation',
    })
    expect(() => RootStepSupplySchema.parse({ kind: 'mask', stepId: 'face-detection' })).toThrow()
  })
})

describe('segmentation takes its masks from the root only while the root emits them', () => {
  it('is a suppliable step whose flag defaults ON', () => {
    expect(isRootSuppliableStepId('segmentation')).toBe(true)
    expect(readUseRootModel('segmentation', undefined)).toBe(true)
    expect(readUseRootModel('segmentation', { useRootModel: false })).toBe(false)
  })

  it('switching plain → seg → plain flips effective/inactive with no write', () => {
    const settings = {} // the default intent, nothing stored
    const onPlain = resolveRootSupply(
      'segmentation',
      settings,
      rootSuppliesOf(PLAIN_ROOT, STEP_DEFAULTS),
    )
    const onSeg = resolveRootSupply(
      'segmentation',
      settings,
      rootSuppliesOf(SEG_ROOT, STEP_DEFAULTS),
    )
    expect(onPlain).toMatchObject({
      effective: false,
      inactive: true,
      inactiveReason: 'root-does-not-declare',
    })
    expect(onSeg).toMatchObject({ effective: true, inactive: false })
    expect(onSeg.inactiveReason).toBeUndefined()
    // Back to the plain root: the same stored settings, inactive again.
    expect(
      resolveRootSupply('segmentation', settings, rootSuppliesOf(PLAIN_ROOT, STEP_DEFAULTS))
        .effective,
    ).toBe(false)
  })

  it('an operator who unchecks the flag keeps the step on its own model under a seg root', () => {
    const state = resolveRootSupply(
      'segmentation',
      { useRootModel: false, modelId: 'u2netp' },
      rootSuppliesOf(SEG_ROOT, STEP_DEFAULTS),
    )
    expect(state).toMatchObject({ intent: false, effective: false, inactive: false })
    expect(state.supply?.kind).toBe('mask')
  })
})
