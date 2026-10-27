/**
 * Scalar compiler (phase 2): identity, invert, threshold+dwell, linear and
 * companions. Battery and running fixtures must come back unchanged.
 */
import { describe, expect, it } from 'vitest'
import type { CompositionFieldsFeature } from '../../composition.js'
import { CUSTOMIZE_STORED_CASES, type CustomizeStoredCase } from '../__fixtures__/stored-cases.js'
import { compileScalarOverride, type ScalarCompileInput } from '../scalar-compile.js'
import { decodeScalarOverride } from '../scalar-decode.js'
import { projectScalarAssignment } from '../scalar-status.js'

function storedCase(id: string): CustomizeStoredCase {
  const found = CUSTOMIZE_STORED_CASES.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`missing customize fixture ${id}`)
  return found
}

function featureOf(id: string): CompositionFieldsFeature {
  const stored = storedCase(id).stored
  if (stored.family !== 'composition') throw new Error(`${id} is not a composition`)
  return stored.feature
}

function compileInput(id: string): ScalarCompileInput {
  return storedCase(id).input
}

describe('scalar compiler', () => {
  it.each([
    'battery-add-number',
    'battery-replace-number',
    'battery-add-numeric-string',
  ])('%s matches the frozen battery feature', (id) => {
    const compiled = compileScalarOverride(compileInput(id))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value).toEqual(featureOf(id))
    const decoded = decodeScalarOverride({
      feature: featureOf(id),
      device: compileInput(id).device,
      cap: 'battery',
      targetId: 'level',
    })
    expect(decoded).not.toBeNull()
    if (decoded === null) return
    const again = compileScalarOverride({
      draft: decoded.draft,
      device: compileInput(id).device,
      apply: decoded.apply,
      sourceValueKind: decoded.sourceValueKind,
      changedAtField: decoded.changedAtField,
      sourceUnit: decoded.sourceUnit,
    })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value).toEqual(featureOf(id))
  })

  it.each([
    'running-switch',
    'running-invert',
    'running-power',
  ])('%s matches the frozen running feature', (id) => {
    const compiled = compileScalarOverride(compileInput(id))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value).toEqual(featureOf(id))
    const decoded = decodeScalarOverride({
      feature: featureOf(id),
      device: compileInput(id).device,
      cap: 'running-state',
      targetId: 'running',
    })
    expect(decoded).not.toBeNull()
    if (decoded === null) return
    const again = compileScalarOverride({
      draft: decoded.draft,
      device: compileInput(id).device,
      apply: decoded.apply,
      sourceValueKind: decoded.sourceValueKind,
      changedAtField: decoded.changedAtField,
      sourceUnit: decoded.sourceUnit,
    })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value).toEqual(featureOf(id))
  })

  it('linear on a number clamps, and a numeric string is number(x) first', () => {
    const base = compileInput('battery-add-number')
    const numberLinear = compileScalarOverride({
      ...base,
      draft: {
        ...base.draft,
        transform: { kind: 'linear', scale: 2, offset: 1, clampMin: 0, clampMax: 100 },
      },
    })
    expect(numberLinear.ok).toBe(true)
    if (!numberLinear.ok) return
    expect(numberLinear.value.fields['level']).toEqual({
      kind: 'expression',
      expr: 'clamp(x * 2 + 1, 0, 100)',
      bindings: {
        x: {
          kind: 'from',
          source: {
            addonId: base.draft.source.addonId,
            stableId: base.draft.source.stableId,
          },
          cap: base.draft.source.cap,
          fieldPath: base.draft.source.fieldPath,
        },
      },
    })

    const stringBase = compileInput('battery-add-numeric-string')
    const stringLinear = compileScalarOverride({
      ...stringBase,
      draft: {
        ...stringBase.draft,
        transform: { kind: 'linear', scale: 1, offset: 0, clampMin: 0, clampMax: 100 },
      },
    })
    expect(stringLinear.ok).toBe(true)
    if (!stringLinear.ok) return
    const level = stringLinear.value.fields['level']
    expect(level?.kind === 'expression' ? level.expr : '').toBe('clamp(number(x) * 1 + 0, 0, 100)')
    const decoded = decodeScalarOverride({
      feature: stringLinear.value,
      device: stringBase.device,
      cap: 'battery',
      targetId: 'level',
    })
    expect(decoded?.draft.transform).toEqual({
      kind: 'linear',
      scale: 1,
      offset: 0,
      clampMin: 0,
      clampMax: 100,
    })
    expect(decoded?.sourceValueKind).toBe('string')
  })

  it('a less-than threshold dwells on x <= threshold', () => {
    const base = compileInput('running-power')
    const compiled = compileScalarOverride({
      ...base,
      draft: {
        ...base.draft,
        transform: {
          kind: 'threshold',
          comparison: 'lte',
          threshold: 5,
          startDwellMs: 30_000,
          stopDwellMs: 180_000,
        },
      },
    })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const running = compiled.value.fields['running']
    expect(running?.kind === 'expression' ? running.expr : '').toBe('dwell(x <= 5, 30000, 180000)')
  })

  it('refuses a bad threshold, dwell, scale, clamp, unit, transform and enum by name', () => {
    const power = compileInput('running-power')
    const negative = compileScalarOverride({
      ...power,
      draft: {
        ...power.draft,
        transform: {
          kind: 'threshold',
          comparison: 'gte',
          threshold: -1,
          startDwellMs: 0,
          stopDwellMs: 0,
        },
      },
    })
    expect(negative.ok).toBe(false)
    if (negative.ok) return
    expect(negative.reason).toBe('threshold')

    const fractionalDwell = compileScalarOverride({
      ...power,
      draft: {
        ...power.draft,
        transform: {
          kind: 'threshold',
          comparison: 'gte',
          threshold: 5,
          startDwellMs: -5,
          stopDwellMs: 0,
        },
      },
    })
    expect(fractionalDwell.ok).toBe(false)
    if (fractionalDwell.ok) return
    expect(fractionalDwell.reason).toBe('dwell')

    const battery = compileInput('battery-add-number')
    const scale = compileScalarOverride({
      ...battery,
      draft: {
        ...battery.draft,
        transform: { kind: 'linear', scale: Number.NaN, offset: 0, clampMin: 0, clampMax: 100 },
      },
    })
    expect(scale.ok).toBe(false)
    if (scale.ok) return
    expect(scale.reason).toBe('scale')

    const clamp = compileScalarOverride({
      ...battery,
      draft: {
        ...battery.draft,
        transform: { kind: 'linear', scale: 1, offset: 0, clampMin: 100, clampMax: 0 },
      },
    })
    expect(clamp.ok).toBe(false)
    if (clamp.ok) return
    expect(clamp.reason).toBe('clamp')

    const unit = compileScalarOverride({ ...power, sourceUnit: 'C' })
    expect(unit.ok).toBe(false)
    if (unit.ok) return
    expect(unit.reason).toBe('unit')

    const untyped = compileScalarOverride({ ...power, sourceUnit: null })
    expect(untyped.ok).toBe(false)
    if (untyped.ok) return
    expect(untyped.reason).toBe('unit')

    const invertSwitch = compileScalarOverride({
      ...compileInput('running-switch'),
      draft: { ...compileInput('running-switch').draft, transform: { kind: 'invert' } },
    })
    expect(invertSwitch.ok).toBe(false)
    if (invertSwitch.ok) return
    expect(invertSwitch.reason).toBe('transform')

    const enumMap = compileScalarOverride({
      ...battery,
      draft: { ...battery.draft, transform: { kind: 'enum-map', mapping: { a: 'b' } } },
    })
    expect(enumMap.ok).toBe(false)
    if (enumMap.ok) return
    expect(enumMap.reason).toBe('enum')
  })

  it('a hand-written battery companion does not decode', () => {
    const feature = featureOf('battery-add-number')
    const decoded = decodeScalarOverride({
      feature: {
        ...feature,
        fields: {
          ...feature.fields,
          sleeping: { kind: 'expression', expr: 'true', bindings: {} },
        },
      },
      device: compileInput('battery-add-number').device,
      cap: 'battery',
      targetId: 'level',
    })
    expect(decoded).toBeNull()
  })
})

describe('scalar assignment status', () => {
  const device = compileInput('battery-replace-number').device
  const feature = featureOf('battery-replace-number')
  const addFeature = featureOf('battery-add-number')

  it('no assignment is Native', () => {
    const projected = projectScalarAssignment({
      cap: 'battery',
      targetId: 'level',
      device,
      stored: { kind: 'known', value: null },
      sourcePresence: 'absent',
      sourceUnknownReason: null,
    })
    expect(projected.text).toBe('Native')
    expect(projected.status).toEqual({
      targetId: 'level',
      configured: false,
      source: 'native',
      state: 'active',
      reason: null,
    })
  })

  it('a present source is Assigned · cap.field', () => {
    const projected = projectScalarAssignment({
      cap: 'battery',
      targetId: 'level',
      device,
      stored: { kind: 'known', value: feature },
      sourcePresence: 'present',
      sourceUnknownReason: null,
    })
    expect(projected.text).toBe('Assigned · numeric-sensor.value')
    expect(projected.status.source).toBe('assigned')
    expect(projected.status.state).toBe('active')
    expect(projected.status.configured).toBe(true)
    expect(projected.status.reason).toBeNull()
  })

  it('a missing source on a replacement is Native · source missing', () => {
    const projected = projectScalarAssignment({
      cap: 'battery',
      targetId: 'level',
      device,
      stored: { kind: 'known', value: feature },
      sourcePresence: 'absent',
      sourceUnknownReason: null,
    })
    expect(projected.text).toBe('Native · source missing')
    expect(projected.status).toMatchObject({
      source: 'native',
      state: 'released',
      reason: 'source-missing',
      configured: true,
    })
  })

  it('a missing source on an added field stays assigned', () => {
    const projected = projectScalarAssignment({
      cap: 'battery',
      targetId: 'level',
      device,
      stored: { kind: 'known', value: addFeature },
      sourcePresence: 'absent',
      sourceUnknownReason: null,
    })
    expect(projected.text).toBe('Assigned · numeric-sensor.value')
    expect(projected.status).toMatchObject({
      source: 'assigned',
      state: 'unavailable',
      reason: 'source-missing',
    })
  })

  it('an unanswered read is pending and a failed read is unknown, never 0', () => {
    const pending = projectScalarAssignment({
      cap: 'battery',
      targetId: 'level',
      device,
      stored: { kind: 'pending' },
      sourcePresence: 'present',
      sourceUnknownReason: null,
    })
    expect(pending.text).toBe('pending')
    expect(pending.status.state).not.toBe('active')
    expect(pending.status.reason).toBeNull()

    const unknown = projectScalarAssignment({
      cap: 'battery',
      targetId: 'level',
      device,
      stored: { kind: 'unknown', reason: 'source read failed' },
      sourcePresence: 'present',
      sourceUnknownReason: null,
    })
    expect(unknown.text).toBe('unknown')
    expect(unknown.status.reason).toBe('source read failed')
    expect(unknown.status.reason).not.toBe('0')
    expect(unknown.status.state).toBe('stale')

    const sourcePending = projectScalarAssignment({
      cap: 'battery',
      targetId: 'level',
      device,
      stored: { kind: 'known', value: feature },
      sourcePresence: 'pending',
      sourceUnknownReason: null,
    })
    expect(sourcePending.text).toBe('pending')
    expect(sourcePending.status.state).toBe('stale')
    expect(sourcePending.status.source).toBe('assigned')

    const sourceUnknown = projectScalarAssignment({
      cap: 'battery',
      targetId: 'level',
      device,
      stored: { kind: 'known', value: feature },
      sourcePresence: 'unknown',
      sourceUnknownReason: 'socket closed',
    })
    expect(sourceUnknown.text).toBe('unknown')
    expect(sourceUnknown.status.reason).toBe('socket closed')
    expect(sourceUnknown.status.state).toBe('stale')
  })
})
