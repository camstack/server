/**
 * A composed heater runs while its actuator switch is on, with no authored
 * running field (D933 amended). The default is computed at plan time and the
 * stored composition is left exactly as it was.
 */
import {
  type ComposerBlock,
  composedDeviceRef,
  compileScalarOverride,
  CompositionSchema,
  DeviceType,
  type CompositionFieldsFeature,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { planNew } from '../composer-plan.js'
import { LOOKUP_CAP } from './fixtures.js'

const PLUG = { addonId: 'provider-mqtt-ha', stableId: 'plug-5388' }

const SWITCH: CompositionFieldsFeature = {
  kind: 'fields',
  cap: 'switch',
  fields: {
    on: { kind: 'from', source: PLUG, cap: 'switch', fieldPath: 'on' },
    lastChangedAt: { kind: 'expression', expr: 'now', bindings: {} },
  },
  commands: { setState: { kind: 'forward', source: PLUG, cap: 'switch', method: 'setState' } },
}
const SUPPLY = supplyLink()

/** What the Customize dialog stores for the plug that powers the device. */
function supplyLink(): CompositionFieldsFeature {
  const out = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: 'power-source',
      targetId: 'switch',
      source: { ...PLUG, cap: 'switch', fieldPath: 'on' },
      transform: { kind: 'identity' },
    },
    device: composedDeviceRef('b1'),
    apply: 'add',
    sourceValueKind: 'boolean',
    changedAtField: null,
    sourceUnit: null,
  })
  if (!out.ok) throw new Error(out.reason)
  return out.value
}
const AUTHORED = authoredDwell()

/** What the Customize dialog stores for a power dwell, companions included. */
function authoredDwell(): CompositionFieldsFeature {
  const out = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: 'running-state',
      targetId: 'running',
      source: { ...PLUG, cap: 'power-meter', fieldPath: 'power' },
      transform: {
        kind: 'threshold',
        comparison: 'gte',
        threshold: 50,
        startDwellMs: 30000,
        stopDwellMs: 60000,
      },
    },
    device: composedDeviceRef('b1'),
    apply: 'add',
    sourceValueKind: 'number',
    changedAtField: null,
    sourceUnit: 'W',
  })
  if (!out.ok) throw new Error(out.reason)
  return out.value
}

function block(type: DeviceType, features: readonly CompositionFieldsFeature[]): ComposerBlock {
  return {
    id: 'b1',
    name: 'Stove',
    enabled: true,
    updatedAt: 1,
    composition: CompositionSchema.parse({ target: { kind: 'new', type }, features }),
  }
}

function plan(b: ComposerBlock) {
  if (b.composition.target.kind !== 'new') throw new Error('new target expected')
  return planNew(b, b.composition.target, LOOKUP_CAP, new Set())
}

function runningRead(b: ComposerBlock) {
  return plan(b).fields.find((f) => f.cap === 'running-state' && f.path === 'running')
}

describe('planNew - running follows the actuator switch', () => {
  it('plans running from the switch when nothing is authored, and the stored block is untouched', () => {
    const heater = block(DeviceType.Fan, [SWITCH])
    const field = runningRead(heater)
    expect(field?.source).toEqual({ kind: 'from', source: PLUG, cap: 'switch', fieldPath: 'on' })
    expect(heater.composition.features).toHaveLength(1)
    expect(plan(heater).declaration?.type).toBe(DeviceType.Fan)
  })

  it('keeps the authored power dwell (5391/5392 keep their rule)', () => {
    expect(runningRead(block(DeviceType.Fan, [SWITCH, AUTHORED]))?.source.kind).toBe('expression')
  })

  it('does not read a SUPPLY switch as running', () => {
    expect(runningRead(block(DeviceType.Fan, [SWITCH, SUPPLY]))).toBeUndefined()
  })
})
