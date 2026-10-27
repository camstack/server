import { describe, expect, it } from 'vitest'
import {
  DISHWASHER,
  SWITCH_REF,
} from '../../../../../../../types/src/composition/customize/__fixtures__/refs.js'
import { previewScalarOverride } from '../scalar-preview'
import type { ScalarFormSource } from '../scalar-form'

const POWER: ScalarFormSource = {
  addonId: SWITCH_REF.addonId,
  stableId: SWITCH_REF.stableId,
  cap: 'power-meter',
  fieldPath: 'power',
  valueKind: 'number',
  sourceUnit: 'W',
  changedAtField: null,
}

describe('previewScalarOverride', () => {
  it('shows the full start dwell for an active threshold and does not invent memory', () => {
    const preview = previewScalarOverride({
      cap: 'running-state',
      targetId: 'running',
      device: DISHWASHER,
      apply: 'replace',
      source: POWER,
      transform: {
        kind: 'threshold',
        comparison: 'gte',
        threshold: 5,
        startDwellMs: 30_000,
        stopDwellMs: 180_000,
      },
      sourceValue: 8.4,
      nowMs: 1_000,
    })
    expect(preview).toEqual({
      kind: 'dwell',
      sourceText: '8.4 W',
      active: true,
      countdownMs: 30_000,
    })
  })

  it('a missing source value is a failure, not zero', () => {
    const preview = previewScalarOverride({
      cap: 'running-state',
      targetId: 'running',
      device: DISHWASHER,
      apply: 'replace',
      source: POWER,
      transform: {
        kind: 'threshold',
        comparison: 'gte',
        threshold: 5,
        startDwellMs: 30_000,
        stopDwellMs: 180_000,
      },
      sourceValue: undefined,
      nowMs: 1_000,
    })
    expect(preview.kind).toBe('failed')
    if (preview.kind !== 'failed') return
    expect(preview.reason).not.toBe('0')
  })

  it('an identity number previews the source value through the compiler', () => {
    const preview = previewScalarOverride({
      cap: 'battery',
      targetId: 'level',
      device: DISHWASHER,
      apply: 'add',
      source: { ...POWER, cap: 'numeric-sensor', fieldPath: 'value', sourceUnit: null },
      transform: { kind: 'identity' },
      sourceValue: 81,
      nowMs: 1_000,
    })
    expect(preview).toEqual({ kind: 'value', text: '81' })
  })
})
