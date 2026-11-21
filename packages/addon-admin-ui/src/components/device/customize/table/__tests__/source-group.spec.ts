/**
 * "Source device" of a Customize cap group: one picked device fills every target of the group
 * whose field its same cap exposes (identity), leaves the rest as they were, and the group's
 * display state reads the per-field assignments back (one device, mixed, or nothing).
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  type CustomizeCatalog,
  type CompositionSourceRef,
  compileScalarOverride,
  decodeScalarOverride,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { featureOf, withScalarTarget } from '../../customization-save'
import type { ScalarFieldOffer } from '../../scalar/scalar-fit'
import { fillSourceGroup, groupSourceState } from '../source-group'

const HOST: CompositionSourceRef = { addonId: 'provider-x', stableId: 'dryer' }
const METER: CompositionSourceRef = { addonId: 'provider-x', stableId: 'plug-meter' }
const OTHER: CompositionSourceRef = { addonId: 'provider-x', stableId: 'other-meter' }
const CAP = 'power-meter'

const catalog: CustomizeCatalog = CAP_CUSTOMIZE_CATALOG
const group = (() => {
  const found = catalog[CAP]?.sourceGroups?.[0]
  if (found === undefined) throw new Error('power-meter declares no source group')
  return found
})()

const UNITS: Readonly<Record<string, string>> = {
  power: 'W',
  energy: 'kWh',
  voltage: 'V',
  current: 'A',
}

function offer(path: string, cap = CAP): ScalarFieldOffer {
  return { cap, path, kind: 'number', unit: UNITS[path] ?? null }
}

function assigned(source: CompositionSourceRef, targetId: string) {
  const out = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: CAP,
      targetId,
      source: { ...source, cap: CAP, fieldPath: targetId },
      transform: { kind: 'identity' },
    },
    device: HOST,
    apply: 'add',
    sourceValueKind: 'number',
    changedAtField: null,
    sourceUnit: UNITS[targetId] ?? null,
  })
  if (!out.ok) throw new Error(out.reason)
  return out.value
}

function sourceOf(composition: ReturnType<typeof withScalarTarget> | null, targetId: string) {
  const feature = composition === null ? null : featureOf(composition, CAP)
  if (feature === null) return null
  return (
    decodeScalarOverride({ feature, device: HOST, cap: CAP, targetId })?.draft.source.stableId ??
    null
  )
}

describe('fillSourceGroup', () => {
  it('fills every target the device exposes with an identity link', () => {
    const result = fillSourceGroup({
      cap: CAP,
      group,
      host: HOST,
      source: METER,
      offers: ['power', 'energy', 'voltage', 'current'].map((path) => offer(path)),
      current: null,
    })
    expect(result.filled).toEqual(['power', 'energy', 'voltage', 'current'])
    expect(result.skipped).toEqual([])
    for (const id of result.filled) expect(sourceOf(result.composition, id)).toBe('plug-meter')
  })

  it('leaves a target the device does not expose as it was, and says so', () => {
    const before = withScalarTarget(null, HOST, assigned(OTHER, 'voltage'), CAP, 'voltage')
    const result = fillSourceGroup({
      cap: CAP,
      group,
      host: HOST,
      source: METER,
      offers: [offer('power'), offer('energy')],
      current: before,
    })
    expect(result.filled).toEqual(['power', 'energy'])
    expect(result.skipped).toEqual(['voltage', 'current'])
    expect(sourceOf(result.composition, 'voltage')).toBe('other-meter')
    expect(sourceOf(result.composition, 'power')).toBe('plug-meter')
  })

  it('ignores a field of another cap with the same name', () => {
    const result = fillSourceGroup({
      cap: CAP,
      group,
      host: HOST,
      source: METER,
      offers: [offer('power', 'numeric-sensor')],
      current: null,
    })
    expect(result.filled).toEqual([])
    expect(result.composition).toBeNull()
  })

  it('refuses a field in the wrong unit rather than linking it', () => {
    const result = fillSourceGroup({
      cap: CAP,
      group,
      host: HOST,
      source: METER,
      offers: [{ cap: CAP, path: 'power', kind: 'number', unit: 'kWh' }],
      current: null,
    })
    expect(result.filled).toEqual([])
    expect(result.skipped).toContain('power')
  })
})

describe('groupSourceState', () => {
  const read = (current: Parameters<typeof groupSourceState>[0]['current']) =>
    groupSourceState({ cap: CAP, group, host: HOST, current })

  it('is none when nothing is assigned', () => {
    expect(read(null)).toEqual({ kind: 'none' })
  })

  it('names the device when every assigned target points at it', () => {
    const filled = fillSourceGroup({
      cap: CAP,
      group,
      host: HOST,
      source: METER,
      offers: ['power', 'energy'].map((path) => offer(path)),
      current: null,
    })
    expect(read(filled.composition)).toEqual({ kind: 'single', source: METER })
  })

  it('is mixed when the targets point at different devices', () => {
    const one = withScalarTarget(null, HOST, assigned(METER, 'power'), CAP, 'power')
    const two = withScalarTarget(one, HOST, assigned(OTHER, 'energy'), CAP, 'energy')
    expect(read(two)).toEqual({ kind: 'mixed' })
  })
})
