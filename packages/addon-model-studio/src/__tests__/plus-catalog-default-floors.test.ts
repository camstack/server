/**
 * D738 — an imported plus catalog / plus catalog detector carries the per-class floor
 * defaults of the system it comes from, unless the import states its own:
 *
 *  - a stock model: the per-detection `min_score` default, 0.5 for every class;
 *  - a plus catalog model: the documented starting values (person 0.65, car 0.65,
 *    cat 0.65, dog 0.70 → macro animal 0.65, the lower of its classes).
 *
 * The track-level `threshold` (median of a track's recent scores) has no
 * counterpart here and is not carried.
 */
import { describe, expect, it } from 'vitest'
import { PLUS_CATALOG_CLASS_FLOORS, PLUS_CATALOG_STOCK_CLASS_FLOORS } from '@camstack/types'
import { buildPlusCatalogCatalogDescriptor } from '../plus-catalog/plus-catalog-catalog.js'
import {
  buildPlusCatalogDescriptor,
  buildPlusCatalogTemplate,
  parsePlusCatalogTemplate,
} from '../plus-catalog/plus-catalog-import.js'
import { plusInfoToDescriptor } from '../plus-catalog/plus-catalog-api.js'
import { buildRegistrationDescriptor } from '../plus-catalog/registration.js'

const LABELS = ['person', 'car', 'dog'] as const
const STOCK = { person: 0.5, vehicle: 0.5, animal: 0.5 }
const PLUS = { person: 0.65, vehicle: 0.65, animal: 0.65 }

describe('plus catalog floor defaults', () => {
  it('the constants say what the source documents', () => {
    expect(PLUS_CATALOG_STOCK_CLASS_FLOORS).toEqual(STOCK)
    expect(PLUS_CATALOG_CLASS_FLOORS).toEqual(PLUS)
  })

  it('a public-catalog model gets the stock defaults', () => {
    const d = buildPlusCatalogCatalogDescriptor('frigate-mobiledet-edgetpu')
    expect(d.entry.defaultClassFloors).toEqual(STOCK)
  })

  it('an uploaded preset gets the stock defaults, unless the import carries its own', () => {
    const base = {
      type: 'yolonas' as const,
      modelId: 'my-yolonas',
      name: 'My YOLO-NAS',
      stepId: 'object-detection',
      filename: 'm.onnx',
      sizeMB: 40,
      inputWidth: 320,
      inputHeight: 320,
      labels: LABELS,
    }
    expect(buildPlusCatalogDescriptor(base).entry.defaultClassFloors).toEqual(STOCK)
    expect(
      buildPlusCatalogDescriptor({ ...base, defaultClassFloors: { person: 0.8 } }).entry
        .defaultClassFloors,
    ).toEqual({ person: 0.8 })
  })

  it('the unified registration flow does the same for a preset, and nothing for a custom model', () => {
    const base = {
      modelId: 'reg-model',
      name: 'Reg',
      stepId: 'object-detection',
      format: 'onnx' as const,
      source: { kind: 'upload' as const, filename: 'r.onnx', sizeMB: 40 },
      inputWidth: 320,
      inputHeight: 320,
      labels: LABELS,
    }
    expect(
      buildRegistrationDescriptor({ ...base, type: 'yolonas' }).entry.defaultClassFloors,
    ).toEqual(STOCK)
    expect(buildRegistrationDescriptor({ ...base, type: 'custom' }).entry.defaultClassFloors).toBe(
      undefined,
    )
  })

  it('a plus catalog model gets the plus catalog defaults', () => {
    const d = plusInfoToDescriptor(
      { id: 'p1', type: 'yolov9', width: 320, height: 320, labelMap: { '0': 'person' } },
      { modelId: 'plus-y9', name: 'p', filename: 'plus-y9.onnx', sizeMB: 25 },
    )
    expect(d.entry.defaultClassFloors).toEqual(PLUS)
  })

  it('a template may carry its own floors, and the parser keeps only valid ones', () => {
    const template = {
      ...buildPlusCatalogTemplate('yolonas'),
      defaultClassFloors: { person: 0.7, vehicle: 2 },
    }
    expect(parsePlusCatalogTemplate(JSON.stringify(template)).defaultClassFloors).toEqual({
      person: 0.7,
    })
    expect(
      parsePlusCatalogTemplate(JSON.stringify(buildPlusCatalogTemplate('yolonas')))
        .defaultClassFloors,
    ).toBe(undefined)
  })
})
