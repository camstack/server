import type { PetFeederStatus } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildFeederConsumableItems } from '../petkit-feeder-consumables.js'

const SECONDS_PER_DAY = 86_400

function slice(overrides: Partial<PetFeederStatus> = {}): PetFeederStatus {
  return {
    foodLevel: 1,
    bowlFood: null,
    eating: false,
    supportsMarkRefilled: false,
    food1: null,
    food2: null,
    lowFood: false,
    batteryPower: null,
    powerSource: null,
    desiccantLeftDays: 12 * SECONDS_PER_DAY,
    feeding: false,
    status: 'normal',
    error: null,
    errorCode: null,
    isDualHopper: false,
    childLock: false,
    indicatorLight: true,
    feedSound: false,
    volume: 1,
    lastFetchedAt: 1,
    ...overrides,
  }
}

describe('buildFeederConsumableItems', () => {
  it('reports the tank as a supply/tank that the sensor drives and nobody resets', () => {
    const tank = buildFeederConsumableItems(slice()).find((i) => i.key === 'foodTank')
    expect(tank).toMatchObject({ kind: 'supply', form: 'tank', status: 'ok', resettable: false })
  })

  it('turns empty when the sensor says so', () => {
    const tank = buildFeederConsumableItems(slice({ foodLevel: 0, lowFood: true })).find(
      (i) => i.key === 'foodTank',
    )
    expect(tank?.status).toBe('empty')
  })

  it('omits the tank when the feeder reports no tank level', () => {
    expect(
      buildFeederConsumableItems(slice({ foodLevel: null })).some((i) => i.key === 'foodTank'),
    ).toBe(false)
  })

  it('reports an empty hopper of a dual feeder as an empty tank', () => {
    const tank = buildFeederConsumableItems(
      slice({ isDualHopper: true, foodLevel: 60, food1: 0, food2: 60, lowFood: true }),
    ).find((i) => i.key === 'foodTank')
    expect(tank?.status).toBe('empty')
  })

  it('reports the desiccant as a resettable wear item with days remaining', () => {
    const desiccant = buildFeederConsumableItems(slice()).find((i) => i.key === 'desiccant')
    expect(desiccant).toMatchObject({
      kind: 'wear',
      form: 'part',
      resettable: true,
      status: 'ok',
      remaining: { value: 12 * SECONDS_PER_DAY, kind: 'duration' },
    })
  })

  it('asks to replace the desiccant at zero days', () => {
    const desiccant = buildFeederConsumableItems(slice({ desiccantLeftDays: 0 })).find(
      (i) => i.key === 'desiccant',
    )
    expect(desiccant?.status).toBe('replace')
  })

  it('omits the desiccant when the model reports none', () => {
    expect(
      buildFeederConsumableItems(slice({ desiccantLeftDays: null })).some(
        (i) => i.key === 'desiccant',
      ),
    ).toBe(false)
  })

  it('builds no items before the first poll landed', () => {
    expect(
      buildFeederConsumableItems(
        slice({ foodLevel: null, desiccantLeftDays: null, lastFetchedAt: 0 }),
      ),
    ).toEqual([])
  })
})
