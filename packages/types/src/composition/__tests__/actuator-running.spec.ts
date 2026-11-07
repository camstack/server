/**
 * "Switch on = device on" for an actuated device (D933 amended): a composed
 * heater with an ACTUATOR switch and no SUPPLY relation runs while its switch
 * is on, computed at plan time and never written into the stored composition.
 */
import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import {
  actuatorSwitchDrivesRunning,
  CompositionSchema,
  followSwitchRunningFeature,
  isRunningOptOut,
  runningOptOutFeature,
  buildCapabilityLookup,
  planComposition,
  runningFollowsSwitch,
  withDefaultRunning,
  type Composition,
  type CompositionFieldsFeature,
  type CompositionSourceRef,
} from '../index.js'
import { composedDeviceRef } from '../composition.js'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import { compileScalarOverride } from '../customize/scalar-compile.js'
import { dwellExpr } from '../customize/scalar-expr.js'

const PLUG: CompositionSourceRef = { addonId: 'provider-mqtt-ha', stableId: 'plug-5388' }
const BLOCK = 'blk-heater'

function switchFeature(): CompositionFieldsFeature {
  return {
    kind: 'fields',
    cap: 'switch',
    fields: {
      on: { kind: 'from', source: PLUG, cap: 'switch', fieldPath: 'on' },
      lastChangedAt: { kind: 'from', source: PLUG, cap: 'switch', fieldPath: 'lastChangedAt' },
    },
    commands: { setState: { kind: 'forward', source: PLUG, cap: 'switch', method: 'setState' } },
  }
}

function powerSourceFeature(): CompositionFieldsFeature {
  return {
    kind: 'fields',
    cap: 'power-source',
    fields: { switchOn: { kind: 'from', source: PLUG, cap: 'switch', fieldPath: 'on' } },
  }
}

function authoredDwell(): CompositionFieldsFeature {
  return {
    kind: 'fields',
    cap: 'running-state',
    fields: {
      running: {
        kind: 'expression',
        expr: dwellExpr('gte', '50', '30000', '60000', 2),
        bindings: { x: { kind: 'from', source: PLUG, cap: 'power-meter', fieldPath: 'power' } },
      },
    },
  }
}

function composition(type: DeviceType, features: readonly CompositionFieldsFeature[]): Composition {
  return CompositionSchema.parse({ target: { kind: 'new', type }, features })
}

describe('actuatorSwitchDrivesRunning', () => {
  it('is true for a heater with a switch and no supply relation', () => {
    expect(actuatorSwitchDrivesRunning(composition(DeviceType.Heater, [switchFeature()]))).toBe(
      true,
    )
  })

  it('is false for an appliance whose switch only feeds power', () => {
    const washer = composition(DeviceType.Washer, [switchFeature(), powerSourceFeature()])
    expect(actuatorSwitchDrivesRunning(washer)).toBe(false)
  })

  it('is false without an actuator switch, with a disabled one, or on an ineligible type', () => {
    expect(actuatorSwitchDrivesRunning(composition(DeviceType.Heater, []))).toBe(false)
    expect(
      actuatorSwitchDrivesRunning(
        composition(DeviceType.Heater, [{ ...switchFeature(), enabled: false }]),
      ),
    ).toBe(false)
    expect(actuatorSwitchDrivesRunning(composition(DeviceType.Switch, [switchFeature()]))).toBe(
      false,
    )
  })
})

describe('withDefaultRunning', () => {
  it('adds a running-state feature that reads the actuator switch, without touching the input', () => {
    const stored = composition(DeviceType.Heater, [switchFeature()])
    const effective = withDefaultRunning(stored, BLOCK)
    expect(stored.features).toHaveLength(1)
    const running = effective.features.find((f) => f.cap === 'running-state')
    expect(running?.kind).toBe('fields')
    if (running?.kind !== 'fields') throw new Error('unreachable')
    expect(running.fields['running']).toEqual({
      kind: 'from',
      source: PLUG,
      cap: 'switch',
      fieldPath: 'on',
    })
    expect(running.fields['since']).toEqual({
      kind: 'from',
      source: PLUG,
      cap: 'switch',
      fieldPath: 'lastChangedAt',
    })
  })

  it('keeps an AUTHORED running field untouched (the operator chose it)', () => {
    const stored = composition(DeviceType.Heater, [switchFeature(), authoredDwell()])
    expect(withDefaultRunning(stored, BLOCK)).toBe(stored)
  })

  it('keeps a supply-switch appliance on its power source', () => {
    const stored = composition(DeviceType.Washer, [switchFeature(), powerSourceFeature()])
    expect(withDefaultRunning(stored, BLOCK)).toBe(stored)
  })
})

describe('runningFollowsSwitch', () => {
  it('reads true from the derived default, and false once a dwell is authored', () => {
    expect(runningFollowsSwitch(composition(DeviceType.Heater, [switchFeature()]))).toBe(true)
    expect(
      runningFollowsSwitch(composition(DeviceType.Heater, [switchFeature(), authoredDwell()])),
    ).toBe(false)
  })

  it('reads true for a stored follow link', () => {
    const stored = composition(DeviceType.Heater, [switchFeature()])
    const follow = followSwitchRunningFeature(stored, composedDeviceRef(BLOCK))
    if (follow === null) throw new Error('no follow feature')
    const withLink = composition(DeviceType.Heater, [switchFeature(), follow])
    expect(runningFollowsSwitch(withLink)).toBe(true)
  })

  it('is what the round trip of the scalar compiler stores for a switch source', () => {
    const compiled = compileScalarOverride({
      draft: {
        kind: 'scalar',
        cap: 'running-state',
        targetId: 'running',
        source: { ...PLUG, cap: 'switch', fieldPath: 'on' },
        transform: { kind: 'identity' },
      },
      device: composedDeviceRef(BLOCK),
      apply: 'add',
      sourceValueKind: 'boolean',
      changedAtField: 'lastChangedAt',
      sourceUnit: null,
    })
    if (!compiled.ok) throw new Error(compiled.reason)
    const stored = composition(DeviceType.Heater, [switchFeature()])
    expect(followSwitchRunningFeature(stored, composedDeviceRef(BLOCK))).toEqual(compiled.value)
  })
})

describe('the opt-out', () => {
  it('a stored opt-out keeps the default out and reads as not following', () => {
    const stored = composition(DeviceType.Heater, [switchFeature(), runningOptOutFeature()])
    expect(withDefaultRunning(stored, BLOCK)).toBe(stored)
    expect(runningFollowsSwitch(stored)).toBe(false)
    expect(isRunningOptOut(runningOptOutFeature())).toBe(true)
    expect(isRunningOptOut(authoredDwell())).toBe(false)
  })

  it('plans without a problem and plans no running field', () => {
    const stored = composition(DeviceType.Heater, [switchFeature(), runningOptOutFeature()])
    const plan = planComposition(stored, buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS))
    expect(plan.problems).toEqual([])
    expect(plan.fields.some((f) => f.cap === 'running-state')).toBe(false)
  })
})
