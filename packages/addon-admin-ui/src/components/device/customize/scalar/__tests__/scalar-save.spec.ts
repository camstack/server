import type { CompositionFieldsFeature } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  CUSTOMIZE_STORED_CASES,
  type CustomizeStoredCase,
} from '../../../../../../../types/src/composition/customize/__fixtures__/stored-cases.js'
import { scalarFeatureFromForm, type ScalarFormSource } from '../scalar-form'

function storedCase(id: string): CustomizeStoredCase {
  const found = CUSTOMIZE_STORED_CASES.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(id)
  return found
}

function featureOf(id: string): CompositionFieldsFeature {
  const stored = storedCase(id).stored
  if (stored.family !== 'composition') throw new Error(id)
  return stored.feature
}

function fromCase(id: string): CompositionFieldsFeature | null {
  const input = storedCase(id).input
  const source: ScalarFormSource = {
    addonId: input.draft.source.addonId,
    stableId: input.draft.source.stableId,
    cap: input.draft.source.cap,
    fieldPath: input.draft.source.fieldPath,
    valueKind: input.sourceValueKind,
    sourceUnit: input.sourceUnit,
    changedAtField: input.changedAtField,
  }
  return scalarFeatureFromForm({
    cap: input.draft.cap,
    targetId: input.draft.targetId,
    device: input.device,
    apply: input.apply,
    source,
    transform: input.draft.transform,
  })
}

describe('scalarFeatureFromForm', () => {
  it('battery add, replace and numeric string match the frozen features', () => {
    expect(fromCase('battery-add-number')).toEqual(featureOf('battery-add-number'))
    expect(fromCase('battery-replace-number')).toEqual(featureOf('battery-replace-number'))
    expect(fromCase('battery-add-numeric-string')).toEqual(featureOf('battery-add-numeric-string'))
  })

  it('running switch, invert and power match the frozen features', () => {
    expect(fromCase('running-switch')).toEqual(featureOf('running-switch'))
    expect(fromCase('running-invert')).toEqual(featureOf('running-invert'))
    expect(fromCase('running-power')).toEqual(featureOf('running-power'))
  })
})
