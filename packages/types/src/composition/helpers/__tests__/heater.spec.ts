/**
 * A heater helper is a smart plug that powers a dumb stove: the plug is the
 * actuator (a forward, D967) and an optional power reading says whether it is
 * really heating. Both shapes must validate as a `Heater` device.
 */
import { describe, expect, it } from 'vitest'
import { powerMeterCapability } from '../../../capabilities/power-meter.cap.js'
import { runningStateCapability } from '../../../capabilities/running-state.cap.js'
import { switchCapability } from '../../../capabilities/switch.cap.js'
import { DeviceType } from '../../../device/device-type.js'
import { compositionSourceKey } from '../../composition.js'
import {
  buildCapabilityLookup,
  type ValidateCompositionContext,
  validateComposition,
} from '../../validate-composition.js'
import { compileHelper } from '../compile.js'
import { HEATER_START_DWELL_MS, HEATER_STOP_DWELL_MS, HEATER_THRESHOLD_WATTS } from '../heater.js'
import type { HeaterHelperSpec } from '../spec.js'

const PLUG = {
  source: { addonId: 'provider-homeassistant', stableId: 'switch.stove_plug' },
  cap: 'switch',
  fieldPath: 'on',
}
const METER = {
  source: { addonId: 'provider-homeassistant', stableId: 'switch.stove_plug_power' },
  cap: 'power-meter',
  fieldPath: 'power',
}

function heater(overrides: Partial<HeaterHelperSpec> = {}): HeaterHelperSpec {
  return {
    kind: 'heater',
    templateId: 'heater',
    plug: PLUG,
    thresholdWatts: HEATER_THRESHOLD_WATTS,
    startDwellMs: HEATER_START_DWELL_MS,
    stopDwellMs: HEATER_STOP_DWELL_MS,
    ...overrides,
  }
}

const lookupCap = buildCapabilityLookup([
  switchCapability,
  runningStateCapability,
  powerMeterCapability,
])

function context(): ValidateCompositionContext {
  const sources = new Map()
  for (const member of [PLUG, METER]) {
    sources.set(compositionSourceKey(member.source), {
      kind: 'found',
      deviceId: member === PLUG ? 7 : 8,
      caps: new Set([member.cap]),
      deviceType: DeviceType.Switch,
    })
  }
  return { lookupCap, sources, self: null, blockId: null, target: null, peers: [] }
}

describe('heater helper', () => {
  it('builds a Heater from a plug alone: running is the switch', () => {
    const compiled = compileHelper(heater())
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.composition.target).toEqual({ kind: 'new', type: DeviceType.Heater })
    expect(compiled.composition.features.map((f) => f.cap)).toEqual(['switch', 'running-state'])
    const sw = compiled.composition.features[0]
    expect(sw?.kind === 'fields' && sw.commands?.setState).toMatchObject({
      kind: 'forward',
      cap: 'switch',
      method: 'setState',
      source: PLUG.source,
    })
    expect(validateComposition(compiled.composition, context()).problems).toEqual([])
  })

  it('builds a Heater from a metered plug: running is the draw above the line', () => {
    const compiled = compileHelper(heater({ meter: METER }))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.composition.features.map((f) => f.cap)).toEqual([
      'switch',
      'running-state',
      'power-meter',
    ])
    const running = compiled.composition.features[1]
    const source = running?.kind === 'fields' ? running.fields.running : undefined
    expect(source?.kind === 'expression' && source.expr).toBe(
      `dwell(x >= ${HEATER_THRESHOLD_WATTS}, ${HEATER_START_DWELL_MS}, ${HEATER_STOP_DWELL_MS})`,
    )
    expect(validateComposition(compiled.composition, context()).problems).toEqual([])
  })

  it('refuses a plug that is not switch.on and a meter that is not power', () => {
    const badPlug = compileHelper(
      heater({ plug: { ...PLUG, cap: 'power-meter', fieldPath: 'power' } }),
    )
    const badMeter = compileHelper(heater({ meter: { ...METER, cap: 'binary', fieldPath: 'on' } }))
    expect(badPlug.ok).toBe(false)
    expect(badMeter.ok).toBe(false)
  })
})
