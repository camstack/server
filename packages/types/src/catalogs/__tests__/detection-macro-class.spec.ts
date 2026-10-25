/**
 * The vocabulary a per-class COUNT can ever be keyed on.
 *
 * `COCO_TO_MACRO.preserveOriginal` is `false`: the executor maps every raw COCO
 * label onto its macro and drops the rest, so a tracked detection's `className`
 * is ALWAYS one of the four macros. Anything that indexes counts by class name
 * — the ZoneAnalytics occupancy snapshot's `byClass`, and therefore every
 * occupancy rule — can only ever match those four.
 *
 * Live cost of not having this predicate, 2026-08-12: two occupancy rules were
 * authored with `className: 'car'` because the rule editor offered the whole
 * taxonomy. `byClass` has no `car` key and never will, so both counters read 0
 * forever and neither rule could fire — silently.
 */
import { describe, expect, it } from 'vitest'
import {
  COCO_TO_MACRO,
  DETECTION_MACRO_CLASSES,
  isDetectionMacroClass,
  MACRO_LABELS,
} from '../coco-classmap.js'

describe('isDetectionMacroClass', () => {
  it('accepts every macro the class map can emit', () => {
    for (const label of MACRO_LABELS) {
      expect(isDetectionMacroClass(label.id)).toBe(true)
    }
  })

  it('rejects the COCO sub-types — the trap the editor used to offer', () => {
    for (const sub of ['car', 'truck', 'bus', 'dog', 'cat', 'bicycle', 'suitcase']) {
      expect(isDetectionMacroClass(sub)).toBe(false)
    }
  })

  it('rejects an unknown class outright', () => {
    expect(isDetectionMacroClass('carrot')).toBe(false)
    expect(isDetectionMacroClass('')).toBe(false)
  })

  it('is case/space insensitive — an operator-typed value still resolves', () => {
    expect(isDetectionMacroClass(' Vehicle ')).toBe(true)
  })

  it('is DERIVED from the class map, never hand-listed', () => {
    // Every macro the mapping targets is in the set; the set adds nothing the
    // macro-label catalog does not declare.
    for (const macro of Object.values(COCO_TO_MACRO.mapping)) {
      expect(DETECTION_MACRO_CLASSES.has(macro)).toBe(true)
    }
    expect([...DETECTION_MACRO_CLASSES].toSorted()).toEqual(
      MACRO_LABELS.map((l) => l.id).toSorted(),
    )
  })
})
