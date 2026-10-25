/**
 * Every plus catalog entry carries a classMap derived from its labelmap. Without it
 * the entry inherited `COCO_TO_MACRO` and a plus catalog `deer` / `package` was
 * dropped by the executor as an unmapped class.
 */
import { describe, expect, it } from 'vitest'
import { PLUS_CATALOG_TO_MACRO, PLUS_CATALOG_UNMAPPED_LABELS } from '@camstack/types'
import { buildPlusCatalogCatalogDescriptor } from '../plus-catalog/plus-catalog-catalog.js'
import {
  buildPlusCatalogDescriptor,
  PLUS_CATALOG_BASE_LABELS,
} from '../plus-catalog/plus-catalog-import.js'
import { plusInfoToDescriptor } from '../plus-catalog/plus-catalog-api.js'
import { buildRegistrationDescriptor } from '../plus-catalog/registration.js'
import { describeRootSupplies, type ModelCatalogEntry } from '@camstack/types'
import { rowSupplies, toModelRows } from '../ui/model-studio-ui.js'

const PLUS_LABELS = ['person', 'car', 'deer', 'package', 'face'] as const

describe('plus catalog label coverage', () => {
  it('decides every documented plus catalog base label: mapped, or unmapped with a reason', () => {
    const undecided = PLUS_CATALOG_BASE_LABELS.filter(
      (l) =>
        PLUS_CATALOG_TO_MACRO[l] === undefined && PLUS_CATALOG_UNMAPPED_LABELS[l] === undefined,
    )
    expect(undecided).toEqual([])
  })
})

describe('plus catalog builders write a classMap', () => {
  it('plusInfoToDescriptor: a plus catalog deer maps to animal, package to package', () => {
    const d = plusInfoToDescriptor(
      {
        id: 'abc',
        type: 'yolov9',
        width: 320,
        height: 320,
        labelMap: Object.fromEntries(PLUS_LABELS.map((l, i) => [String(i), l])),
      },
      { modelId: 'plus', name: 'Plus', filename: 'plus.onnx', sizeMB: 10 },
    )
    expect(d.entry.classMap?.mapping.deer).toBe('animal')
    expect(d.entry.classMap?.mapping.package).toBe('package')
    expect(d.entry.classMap?.mapping.face).toBeUndefined()
  })

  it('buildPlusCatalogDescriptor and the preset registration carry the same map', () => {
    const legacy = buildPlusCatalogDescriptor({
      type: 'yolonas',
      modelId: 'm',
      name: 'M',
      stepId: 'object-detection',
      filename: 'm.onnx',
      sizeMB: 1,
      inputWidth: 320,
      inputHeight: 320,
      labels: PLUS_LABELS,
    })
    const unified = buildRegistrationDescriptor({
      type: 'yolonas',
      modelId: 'm',
      name: 'M',
      stepId: 'object-detection',
      format: 'onnx',
      source: { kind: 'upload', filename: 'm.onnx', sizeMB: 1 },
      inputWidth: 320,
      inputHeight: 320,
      labels: PLUS_LABELS,
    })
    expect(legacy.entry.classMap?.mapping.deer).toBe('animal')
    expect(unified.entry.classMap).toEqual(legacy.entry.classMap)
  })

  it('a custom registration carries no classMap (the step map applies)', () => {
    const d = buildRegistrationDescriptor({
      type: 'custom',
      modelId: 'c',
      name: 'C',
      stepId: 'object-detection',
      format: 'onnx',
      source: { kind: 'url', url: 'https://x/c.onnx', sizeMB: 1 },
      inputWidth: 320,
      inputHeight: 320,
      labels: ['deer'],
    })
    expect(d.entry.classMap).toBeUndefined()
  })

  it('the public COCO catalog entry keeps COCO behaviour', () => {
    const d = buildPlusCatalogCatalogDescriptor('frigate-mobiledet-edgetpu')
    expect(d.entry.classMap?.mapping.car).toBe('vehicle')
    expect(d.entry.classMap?.mapping['traffic light']).toBeUndefined()
  })
})

/**
 * The real labelmap of the plus catalog base EdgeTPU (Coral, mobiledet 2026.1)
 * model on the operator's hub — 41 labels, `face` and `license_plate`
 * included, no `truck`, no `sheep`.
 */
const PLUS_CORAL_2026_1 = [
  'person',
  'dhl',
  'deer',
  'dog',
  'horse',
  'package',
  'waste_bin',
  'an_post',
  'bird',
  'robot_lawnmower',
  'raccoon',
  'boat',
  'fox',
  'umbrella',
  'bear',
  'cat',
  'license_plate',
  'purolator',
  'bbq_grill',
  'cow',
  'face',
  'usps',
  'ups',
  'amazon',
  'postnl',
  'fedex',
  'bicycle',
  'squirrel',
  'nzpost',
  'car',
  'motorcycle',
  'postnord',
  'gls',
  'dpd',
  'goat',
  'rabbit',
  'kangaroo',
  'skunk',
  'canada_post',
  'royal_mail',
  'school_bus',
] as const

const EVERY_KIND = 'animals 7/8 · vehicles 4/8 · packages · plates · faces'

function declared(entry: ModelCatalogEntry): string {
  return describeRootSupplies(entry.suppliesSteps)
}

describe('every plus catalog import declares what it supplies, from its OWN labelmap (D730)', () => {
  it('plus catalog download of the Coral (mobiledet, tflite) model — crop kinds included', () => {
    const d = plusInfoToDescriptor(
      {
        id: 'e39924321228f76edd6b727c0cf2a4be',
        type: 'mobiledet',
        width: 320,
        height: 320,
        labelMap: Object.fromEntries(PLUS_CORAL_2026_1.map((l, i) => [String(i), l])),
      },
      { modelId: 'plus-coral', name: 'Plus', filename: 'plus.tflite', sizeMB: 4 },
    )
    expect(declared(d.entry)).toBe(EVERY_KIND)
  })

  it('preset upload and the unified registration declare the same, for any format', () => {
    for (const [type, filename, format] of [
      ['yolov9', 'p.onnx', 'onnx'],
      ['mobiledet', 'p.tflite', 'tflite'],
    ] as const) {
      const legacy = buildPlusCatalogDescriptor({
        type,
        modelId: 'p',
        name: 'P',
        stepId: 'object-detection',
        filename,
        sizeMB: 1,
        inputWidth: 320,
        inputHeight: 320,
        labels: PLUS_CORAL_2026_1,
      })
      const unified = buildRegistrationDescriptor({
        type,
        modelId: 'p',
        name: 'P',
        stepId: 'object-detection',
        format,
        source: { kind: 'upload', filename, sizeMB: 1 },
        inputWidth: 320,
        inputHeight: 320,
        labels: PLUS_CORAL_2026_1,
      })
      expect(declared(legacy.entry)).toBe(EVERY_KIND)
      expect(unified.entry.suppliesSteps).toEqual(legacy.entry.suppliesSteps)
    }
  })

  it('a labelmap without face / license_plate declares no crop kind', () => {
    const d = buildPlusCatalogDescriptor({
      type: 'yolov9',
      modelId: 'p',
      name: 'P',
      stepId: 'object-detection',
      filename: 'p.onnx',
      sizeMB: 1,
      inputWidth: 320,
      inputHeight: 320,
      labels: PLUS_CORAL_2026_1.filter((l) => l !== 'face' && l !== 'license_plate'),
    })
    expect(declared(d.entry)).toBe('animals 7/8 · vehicles 4/8 · packages')
  })

  it('the public COCO catalog entry supplies the classifiers like any root — no COCO exception', () => {
    const d = buildPlusCatalogCatalogDescriptor('frigate-mobiledet-edgetpu')
    // plus catalog's COCO-91 labelmap writes `car` where COCO has `truck`, so its
    // own labelmap names four vehicle types, not five.
    expect(declared(d.entry)).toBe('animals 6/8 · vehicles 4/8')
  })

  it('a registry row stored with the OLD declaration (no crop kinds) is re-derived on read', () => {
    const fresh = buildPlusCatalogDescriptor({
      type: 'mobiledet',
      modelId: 'frigate-plus-e39924321228f76edd6b727c0cf2a4be',
      name: 'plus catalog base',
      stepId: 'object-detection',
      filename: 'p.tflite',
      sizeMB: 4,
      inputWidth: 320,
      inputHeight: 320,
      labels: PLUS_CORAL_2026_1,
    })
    // The row as the hub stores it today: the D715 field, which the schema no
    // longer knows, and no `suppliesSteps`.
    const { suppliesSteps: _dropped, ...entry } = fresh.entry
    const stored = { ...fresh, entry }
    expect(describeRootSupplies(rowSupplies(stored))).toBe(EVERY_KIND)
    const [row] = toModelRows([stored], {})
    expect(row?.supplies?.map((s) => s.stepId)).toEqual([
      'animal-classifier',
      'vehicle-classifier',
      'package-detection',
      'plate-detection',
      'face-detection',
    ])
  })
})
