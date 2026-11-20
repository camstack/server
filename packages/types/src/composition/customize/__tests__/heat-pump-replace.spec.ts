/**
 * A heat pump's electrical power and electrical energy are linked by the
 * OPERATOR to a device they pick (#476): each is a `replace` over a field the
 * `heat-pump-status` cap lists in `overridable`, with the unit checked (W for
 * power, kWh for energy). Nothing is linked or inferred by itself (D356).
 */
import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../../../generated/capability-router-map.js'
import { CAP_CUSTOMIZE_CATALOG } from '../../../generated/customize-catalog.js'
import { DeviceType } from '../../../device/device-type.js'
import {
  buildCapabilityLookup,
  CompositionSchema,
  validateComposition,
  type ValidateCompositionContext,
} from '../../index.js'
import type { CompositionSourceRef } from '../../composition.js'
import { compileScalarOverride } from '../scalar-compile.js'
import { decodeScalarOverride } from '../scalar-decode.js'

const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
const PUMP: CompositionSourceRef = { addonId: 'bosch', stableId: 'hp-1' }
const METER: CompositionSourceRef = { addonId: 'enpal', stableId: 'hp-meter' }

function compile(targetId: string, fieldPath: string, sourceUnit: string | null) {
  return compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: 'heat-pump-status',
      targetId,
      source: { ...METER, cap: 'power-meter', fieldPath },
      transform: { kind: 'identity' },
    },
    device: PUMP,
    apply: 'replace',
    sourceValueKind: 'number',
    changedAtField: null,
    sourceUnit,
  })
}

describe('heat-pump-status declares its electrical readings overridable', () => {
  it('lists exactly power.electricalW and energy.electricalKwh, each by its own target', () => {
    const overridable = CAP_CUSTOMIZE_CATALOG['heat-pump-status']?.overridable ?? []
    expect(overridable).toEqual([
      { path: 'power.electricalW', by: 'electrical-power' },
      { path: 'energy.electricalKwh', by: 'electrical-energy' },
    ])
  })

  it('the unit is checked: W for power, kWh for energy', () => {
    const targets = CAP_CUSTOMIZE_CATALOG['heat-pump-status']?.targets ?? []
    const units = Object.fromEntries(
      targets.map((t) => [t.id, t.sources.map((s) => s.requiredUnit)]),
    )
    expect(units).toEqual({
      'electrical-power': ['W'],
      'electrical-energy': ['kWh'],
    })
  })
})

describe('compiling the links', () => {
  it('links the power meter W to power.electricalW', () => {
    const out = compile('electrical-power', 'power', 'W')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(Object.keys(out.value.fields)).toEqual(['power.electricalW'])
  })

  it('links the meter kWh to energy.electricalKwh', () => {
    const out = compile('electrical-energy', 'energy', 'kWh')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(Object.keys(out.value.fields)).toEqual(['energy.electricalKwh'])
  })

  it('refuses energy picked for power, and the reverse (unit)', () => {
    expect(compile('electrical-power', 'energy', 'kWh')).toEqual({ ok: false, reason: 'unit' })
    expect(compile('electrical-energy', 'power', 'W')).toEqual({ ok: false, reason: 'unit' })
  })

  it('round-trips as a replace', () => {
    const out = compile('electrical-power', 'power', 'W')
    if (!out.ok) throw new Error(out.reason)
    const decoded = decodeScalarOverride({
      feature: out.value,
      device: PUMP,
      cap: 'heat-pump-status',
      targetId: 'electrical-power',
    })
    expect(decoded?.apply).toBe('replace')
  })
})

describe('planning the replace on the native heat pump', () => {
  it('has no problem and plans a replace', () => {
    const out = compile('electrical-power', 'power', 'W')
    if (!out.ok) throw new Error(out.reason)
    const ctx: ValidateCompositionContext = {
      lookupCap,
      self: PUMP,
      blockId: null,
      peers: [],
      target: {
        kind: 'found',
        deviceId: 7,
        type: DeviceType.HeatPump,
        nativeCaps: new Map([['heat-pump-status', 'bosch']]),
      },
      sources: new Map([
        [
          `${METER.addonId}/${METER.stableId}`,
          { kind: 'found', deviceId: 9, caps: new Set(['power-meter']) },
        ],
      ]),
    }
    const v = validateComposition(
      CompositionSchema.parse({
        target: { kind: 'existing', device: PUMP },
        features: [out.value],
      }),
      ctx,
    )
    expect(v.problems).toEqual([])
    expect(v.features).toEqual([{ featureIndex: 0, cap: 'heat-pump-status', mode: 'replace' }])
  })
})
