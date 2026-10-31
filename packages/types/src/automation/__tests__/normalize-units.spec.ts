import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import { QuantityUnitError } from '../../units/quantity-input.js'
import {
  capUnitResolver,
  normalizeActionUnits,
  normalizeConditionUnits,
} from '../normalize-units.js'
import type { AutomationCapStep, AutomationWhen, DeviceIsLeaf } from '../index.js'

const resolver = capUnitResolver(ALL_CAPABILITY_DEFINITIONS)

function bowlLeaf(value: DeviceIsLeaf['value'], unit?: string): AutomationWhen {
  return {
    kind: 'device-is',
    deviceId: 7,
    cap: 'pet-feeder',
    fieldPath: 'bowlFood',
    operator: 'lt',
    value,
    ...(unit === undefined ? {} : { unit }),
  }
}

function feedStep(
  args: Record<string, unknown>,
  argUnits?: Record<string, string>,
): AutomationCapStep {
  return {
    kind: 'cap',
    target: { kind: 'devices', ids: [7] },
    cap: 'pet-feeder',
    method: 'feed',
    args,
    ...(argUnits === undefined ? {} : { argUnits }),
  }
}

function leafOf(result: AutomationWhen): DeviceIsLeaf {
  if (result.kind !== 'device-is') throw new Error('expected a leaf')
  return result
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (err: unknown) {
    return err instanceof QuantityUnitError ? err.code : 'not-a-QuantityUnitError'
  }
  return undefined
}

describe('capUnitResolver', () => {
  it('reads the reading quantity of a status field and the declared unit of a param', () => {
    expect(resolver.fieldQuantity('pet-feeder', 'bowlFood')).toBe('mass')
    expect(resolver.fieldQuantity('pet-feeder', 'eating')).toBeUndefined()
    expect(resolver.paramMeta('pet-feeder', 'feed', 'grams')).toEqual({
      quantity: 'mass',
      unit: 'g',
    })
    expect(resolver.paramMeta('pet-feeder', 'feed', 'deviceId')).toBeUndefined()
  })
})

describe('normalizeConditionUnits', () => {
  it('stores a leaf entered in grams as kilograms, keeping the picked unit', () => {
    const { value, warnings } = normalizeConditionUnits(
      bowlLeaf({ value: 10, unit: 'g' }),
      resolver,
    )
    const leaf = leafOf(value)
    expect(leaf.value).toBeCloseTo(0.01, 9)
    expect(leaf.unit).toBe('g')
    expect(warnings).toEqual([])
  })

  it('refuses a unit of another dimension with a typed error', () => {
    expect(codeOf(() => normalizeConditionUnits(bowlLeaf({ value: 1, unit: 'L' }), resolver))).toBe(
      'cross-dimension',
    )
  })

  it('refuses a unit on a field that is not a quantity', () => {
    const leaf: AutomationWhen = {
      kind: 'device-is',
      deviceId: 7,
      cap: 'pet-feeder',
      fieldPath: 'errorCode',
      operator: 'eq',
      value: { value: 1, unit: 'g' },
    }
    expect(codeOf(() => normalizeConditionUnits(leaf, resolver))).toBe('no-quantity')
  })

  it('accepts a bare number as the base unit and warns', () => {
    const { value, warnings } = normalizeConditionUnits(bowlLeaf(0.5), resolver)
    expect(leafOf(value).value).toBe(0.5)
    expect(leafOf(value).unit).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      deviceId: 7,
      field: 'bowlFood',
      value: 0.5,
      assumedUnit: 'kg',
    })
  })

  it('does not warn about, nor convert, a stored leaf that already carries its unit', () => {
    const first = normalizeConditionUnits(bowlLeaf({ value: 10, unit: 'g' }), resolver)
    const second = normalizeConditionUnits(first.value, resolver)
    expect(second.value).toEqual(first.value)
    expect(second.warnings).toEqual([])
  })

  it('leaves a non-quantity field alone, without a warning', () => {
    const leaf: AutomationWhen = {
      kind: 'device-is',
      deviceId: 7,
      cap: 'pet-feeder',
      fieldPath: 'errorCode',
      operator: 'eq',
      value: 3,
    }
    const { value, warnings } = normalizeConditionUnits(leaf, resolver)
    expect(value).toEqual(leaf)
    expect(warnings).toEqual([])
  })

  it('walks all / any / not', () => {
    const tree: AutomationWhen = {
      kind: 'all',
      children: [{ kind: 'not', child: bowlLeaf({ value: 10, unit: 'g' }) }],
    }
    const { value } = normalizeConditionUnits(tree, resolver)
    if (value.kind !== 'all') throw new Error('expected all')
    const child = value.children[0]
    if (child === undefined || child.kind !== 'not') throw new Error('expected not')
    expect(leafOf(child.child).value).toBeCloseTo(0.01, 9)
  })
})

describe('normalizeActionUnits', () => {
  it('converts a step arg entered in kilograms to the grams the method takes', () => {
    const { value, warnings } = normalizeActionUnits(
      [feedStep({ grams: { value: 0.1, unit: 'kg' } })],
      resolver,
    )
    expect(value).toEqual([feedStep({ grams: 100 }, { grams: 'kg' })])
    expect(warnings).toEqual([])
  })

  it('converts each hopper on its own', () => {
    const { value } = normalizeActionUnits(
      [feedStep({ hopper1: { value: 0.05, unit: 'kg' }, hopper2: 80 }, { hopper2: 'g' })],
      resolver,
    )
    expect(value).toEqual([feedStep({ hopper1: 50, hopper2: 80 }, { hopper1: 'kg', hopper2: 'g' })])
  })

  it('refuses a unit of another dimension', () => {
    expect(
      codeOf(() => normalizeActionUnits([feedStep({ grams: { value: 1, unit: 'L' } })], resolver)),
    ).toBe('cross-dimension')
  })

  it('accepts a bare number as the declared unit and warns', () => {
    const { value, warnings } = normalizeActionUnits([feedStep({ grams: 50 })], resolver)
    expect(value).toEqual([feedStep({ grams: 50 })])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ field: 'grams', value: 50, assumedUnit: 'g' })
  })

  it('is idempotent on an already normalized step', () => {
    const once = normalizeActionUnits([feedStep({ grams: { value: 0.1, unit: 'kg' } })], resolver)
    const twice = normalizeActionUnits(once.value, resolver)
    expect(twice.value).toEqual(once.value)
    expect(twice.warnings).toEqual([])
  })

  it('leaves an object arg on a param that is not a quantity alone', () => {
    const step: AutomationCapStep = {
      ...feedStep({}),
      args: { deviceId: 7, note: { value: 1, unit: 'x' } },
    }
    const { value } = normalizeActionUnits([step], resolver)
    expect(value).toEqual([step])
  })

  it('passes wait and non-cap steps through', () => {
    const { value } = normalizeActionUnits([{ kind: 'wait', seconds: 3 }], resolver)
    expect(value).toEqual([{ kind: 'wait', seconds: 3 }])
  })
})

describe('normalizeActionUnits — the save boundary writes only the new target shape', () => {
  it('turns a legacy multi-device step into target.devices and keeps the marked arg', () => {
    const legacy: AutomationCapStep = {
      kind: 'cap',
      deviceId: [7, 9],
      cap: 'pet-feeder',
      method: 'feed',
      args: { portion: 'MARK-42' },
    }
    const { value } = normalizeActionUnits([legacy], resolver)
    const step = value[0]
    if (step === undefined || step.kind !== 'cap') throw new Error('expected a cap step')
    expect(step.target).toEqual({ kind: 'devices', ids: [7, 9] })
    expect(step.deviceId).toBeUndefined()
    expect(step.args).toEqual({ portion: 'MARK-42' })
  })
})
