/**
 * An appliance helper is one power reading plus a type. It compiles to that
 * device type's running-state (power at or above a threshold, with dwells)
 * and to the same power as a reading.
 */
import { describe, expect, it } from 'vitest'
import { powerMeterCapability } from '../../../capabilities/power-meter.cap.js'
import { runningStateCapability } from '../../../capabilities/running-state.cap.js'
import { triggersForDevice } from '../../../device/cap-vocabulary/resolve.js'
import { DeviceType } from '../../../device/device-type.js'
import { compositionSourceKey } from '../../composition.js'
import {
  buildCapabilityLookup,
  type ValidateCompositionContext,
  validateComposition,
} from '../../validate-composition.js'
import { APPLIANCE_DEFAULTS, type ApplianceKind } from '../appliance.js'
import { compileHelper } from '../compile.js'
import type { ApplianceHelperSpec } from '../spec.js'
import type { Composition } from '../../composition.js'

const PLUG = {
  source: { addonId: 'provider-homeassistant', stableId: 'sensor.plug_power' },
  cap: 'power-meter',
  fieldPath: 'power',
}

function appliance(
  kind: ApplianceKind,
  overrides: Partial<ApplianceHelperSpec> = {},
): ApplianceHelperSpec {
  const defaults = APPLIANCE_DEFAULTS[kind]
  return {
    kind: 'appliance',
    templateId: 'appliance',
    appliance: kind,
    thresholdWatts: defaults.thresholdWatts,
    startDwellMs: defaults.startDwellMs,
    stopDwellMs: defaults.stopDwellMs,
    member: PLUG,
    ...overrides,
  }
}

describe('appliance helper', () => {
  it.each([
    'washer',
    'dryer',
    'dishwasher',
  ] as const)('compiles a %s with running at or above its threshold and the plug power', (kind) => {
    const defaults = APPLIANCE_DEFAULTS[kind]
    const compiled = compileHelper(appliance(kind))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const type =
      kind === 'washer'
        ? DeviceType.Washer
        : kind === 'dryer'
          ? DeviceType.Dryer
          : DeviceType.Dishwasher
    expect(compiled.composition.target).toEqual({ kind: 'new', type })
    const running = compiled.composition.features.find((feature) => feature.cap === 'running-state')
    const power = compiled.composition.features.find((feature) => feature.cap === 'power-meter')
    expect(running?.kind).toBe('fields')
    expect(power?.kind).toBe('fields')
    if (running?.kind !== 'fields' || power?.kind !== 'fields') return
    const runningSource = running.fields.running
    expect(runningSource?.kind).toBe('expression')
    if (runningSource?.kind !== 'expression') return
    expect(runningSource.expr).toBe(
      `dwell(x >= ${defaults.thresholdWatts}, ${defaults.startDwellMs}, ${defaults.stopDwellMs})`,
    )
    expect(runningSource.bindings.x).toMatchObject({
      kind: 'from',
      cap: 'power-meter',
      fieldPath: 'power',
    })
    expect(power.fields.power).toMatchObject({
      kind: 'from',
      cap: 'power-meter',
      fieldPath: 'power',
    })
    expect(compiled.composition.helper).toEqual(appliance(kind))
    const report = validateComposition(compiled.composition, context(compiled.composition))
    expect(report.problems).toEqual([])
  })

  it('refuses a member that is not a power reading', () => {
    const compiled = compileHelper(
      appliance('washer', {
        member: { ...PLUG, cap: 'temperature-sensor', fieldPath: 'temperature' },
      }),
    )
    expect(compiled.ok).toBe(false)
    if (compiled.ok) return
    expect(compiled.problems.map((item) => item.code)).toContain('member-constraint')
  })
})

describe('cycle finished wording', () => {
  it.each([
    [
      'washer',
      DeviceType.Washer,
      'When the washing machine has finished',
      'Quando la lavatrice ha finito',
    ],
    ['dryer', DeviceType.Dryer, 'When the dryer has finished', "Quando l'asciugatrice ha finito"],
    [
      'dishwasher',
      DeviceType.Dishwasher,
      'When the dishwasher has finished',
      'Quando la lavastoviglie ha finito',
    ],
  ] as const)('%s offers the running→false flip in both languages', (_name, type, en, it) => {
    const triggers = triggersForDevice(['running-state'], type)
    const running = triggers.find(
      (trigger) => trigger.kind === 'boolean' && trigger.field === 'running',
    )
    const finished = triggers.find(
      (trigger) => trigger.kind === 'event' && trigger.phrase.en === en,
    )
    expect(running?.kind).toBe('boolean')
    if (running?.kind !== 'boolean') return
    expect(running.whenFalse).toEqual({ en, it })
    expect(finished?.kind).toBe('event')
    if (finished?.kind !== 'event') return
    expect(finished.phrase).toEqual({ en, it })
  })
})

const lookupCap = buildCapabilityLookup([runningStateCapability, powerMeterCapability])

function context(composition: Composition): ValidateCompositionContext {
  const sources = new Map()
  if (composition.helper?.kind === 'appliance') {
    const member = composition.helper.member
    sources.set(compositionSourceKey(member.source), {
      kind: 'found',
      deviceId: 7,
      caps: new Set([member.cap]),
      deviceType: DeviceType.Sensor,
      quantity: 'power',
    })
  }
  return { lookupCap, sources, self: null, blockId: null, target: null, peers: [] }
}
