import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import { batteryCapability } from '../battery.cap.js'
import { consumablesCapability, ConsumableItemSchema } from '../consumables.cap.js'
import { DeviceType } from '../../device/device-type.js'

describe('composedMethods (D663)', () => {
  it('battery answers wakeForStream with the contract’s own "unavailable" answer', () => {
    const answer = batteryCapability.composedMethods.wakeForStream
    expect(answer).toEqual({ kind: 'answer', value: { awoke: false, durationMs: 0 } })
    expect(batteryCapability.methods.wakeForStream.output.safeParse(answer.value).success).toBe(
      true,
    )
  })

  it('consumables refuses reset by name', () => {
    expect(consumablesCapability.composedMethods.reset.kind).toBe('refuse')
  })

  it('every declared key is a method of its cap, and every answer parses with that method’s output', () => {
    for (const def of ALL_CAPABILITY_DEFINITIONS) {
      for (const [name, answer] of Object.entries(def.composedMethods ?? {})) {
        const m = def.methods[name]
        // `expect(...).toBeDefined()` does not narrow under `noUncheckedIndexedAccess` (tsconfig.base.json:15).
        if (m === undefined) throw new Error(`${def.name}.composedMethods.${name} is not a method`)
        if (answer.kind === 'answer') expect(m.output.safeParse(answer.value).success).toBe(true)
      }
    }
  })

  it('battery is offered on a pet feeder and on a container (HA containers already register it natively)', () => {
    expect(batteryCapability.deviceTypes).toEqual(
      expect.arrayContaining([DeviceType.PetFeeder, DeviceType.Container]),
    )
  })

  it('a consumable item may carry remaining {value, unit}; absent stays valid', () => {
    const base = {
      key: 'desiccant',
      label: 'Desiccant',
      level: null,
      status: null,
      lastResetAt: null,
      resettable: false,
    }
    expect(ConsumableItemSchema.safeParse(base).success).toBe(true)
    expect(
      ConsumableItemSchema.safeParse({ ...base, remaining: { value: 12, unit: 'days' } }).success,
    ).toBe(true)
    expect(
      ConsumableItemSchema.safeParse({ ...base, remaining: { value: null, unit: 'days' } }).success,
    ).toBe(true)
    expect(
      ConsumableItemSchema.safeParse({ ...base, remaining: { value: 3, unit: 'weeks' } }).success,
    ).toBe(false)
  })
})
