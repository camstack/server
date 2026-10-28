import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  draftToComposition,
  editorReducer,
  existingDraft,
  newDraft,
  nextBindingName,
} from '../draft-reducer'

const T1 = { addonId: 'provider-homeassistant', stableId: 'climate.porch' }
const T2 = { addonId: 'provider-homeassistant', stableId: 'sensor.porch_temperature' }

describe('editorReducer', () => {
  it('never mutates the draft it is given', () => {
    const draft = editorReducer(newDraft(DeviceType.Sensor), {
      type: 'add-feature',
      cap: 'temperature-sensor',
    })
    const before = structuredClone(draft)
    editorReducer(draft, {
      type: 'set-field',
      cap: 'temperature-sensor',
      path: 'celsius',
      source: { kind: 'from', source: T1, cap: 'temperature-sensor', fieldPath: 'temperature' },
    })
    expect(draft).toEqual(before)
  })
  it('builds the Porch temperature feature step by step', () => {
    let d = newDraft(DeviceType.Sensor)
    d = editorReducer(d, { type: 'set-name', name: 'Porch (composto)' })
    d = editorReducer(d, { type: 'add-feature', cap: 'temperature-sensor' })
    d = editorReducer(d, {
      type: 'set-field',
      cap: 'temperature-sensor',
      path: 'celsius',
      source: {
        kind: 'expression',
        expr: 'round(avg(t1, t2), 1)',
        bindings: {
          t1: { kind: 'from', source: T1, cap: 'temperature-sensor', fieldPath: 'temperature' },
          t2: { kind: 'from', source: T2, cap: 'temperature-sensor', fieldPath: 'temperature' },
        },
      },
    })
    const parsed = draftToComposition(d)
    expect(parsed.ok && parsed.composition.features[0]?.cap).toBe('temperature-sensor')
    expect(d.name).toBe('Porch (composto)')
  })
  it('"Copy the whole feature from…" fills every named field with a from, then one can be overridden', () => {
    let d = editorReducer(existingDraft(T2), { type: 'add-feature', cap: 'temperature-sensor' })
    d = editorReducer(d, {
      type: 'copy-feature',
      cap: 'temperature-sensor',
      from: T1,
      sourceCap: 'temperature-sensor',
      paths: ['celsius', 'lastFetchedAt'],
    })
    expect(Object.keys(d.features[0]?.fields ?? {})).toEqual(['celsius', 'lastFetchedAt'])
    d = editorReducer(d, { type: 'clear-field', cap: 'temperature-sensor', path: 'lastFetchedAt' })
    expect(Object.keys(d.features[0]?.fields ?? {})).toEqual(['celsius'])
  })
  it('a draft the schema refuses says why, by path', () => {
    const parsed = draftToComposition(newDraft(DeviceType.Sensor))
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.problems.join(' ')).toContain('features')
  })
  it('removes one binding from a formula without clearing the field', () => {
    let d = editorReducer(newDraft(DeviceType.Sensor), { type: 'add-feature', cap: 'binary' })
    const source = {
      kind: 'expression' as const,
      expr: 's1 && s2',
      bindings: {
        s1: { kind: 'from' as const, source: T1, cap: 'binary', fieldPath: 'on' },
        s2: { kind: 'from' as const, source: T2, cap: 'binary', fieldPath: 'on' },
      },
    }
    d = editorReducer(d, { type: 'set-field', cap: 'binary', path: 'on', source })
    d = editorReducer(d, {
      type: 'remove-binding',
      cap: 'binary',
      path: 'on',
      bindingName: 's1',
    })
    const field = d.features[0]?.fields.on
    expect(field?.kind).toBe('expression')
    expect(field?.kind === 'expression' && Object.keys(field.bindings)).toEqual(['s2'])
  })
  it('names new bindings s1, s2, … skipping taken names', () => {
    expect(nextBindingName([])).toBe('s1')
    expect(nextBindingName(['s1', 's3'])).toBe('s2')
  })
})
