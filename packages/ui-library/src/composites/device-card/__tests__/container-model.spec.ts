import { describe, expect, it } from 'vitest'
import { childBatteryOf } from '../connected/ConnectedContainerCard'
import {
  type ChildBattery,
  type ContainerCardChild,
  containerCountsOf,
} from '../scenes/container/container-model'

const child = (online: boolean, battery: ChildBattery): ContainerCardChild => ({
  online,
  battery,
})

describe('containerCountsOf', () => {
  it('splits the children into online, offline and low battery', () => {
    expect(
      containerCountsOf([child(true, 80), child(true, 10), child(false, 'none'), child(false, 5)]),
    ).toEqual({ total: 4, online: 2, offline: 2, lowBattery: 2 })
  })

  it('a child that keeps no battery level is not low', () => {
    expect(containerCountsOf([child(true, 'none')]).lowBattery).toBe(0)
  })

  it('an unknown level makes the low-battery count unknown, never 0 (D393)', () => {
    expect(containerCountsOf([child(true, 5), child(true, 'unknown')]).lowBattery).toBeNull()
  })

  it('the low-battery bar is below 20, not at it', () => {
    expect(containerCountsOf([child(true, 20), child(true, 19)]).lowBattery).toBe(1)
  })

  it('no children is all zero', () => {
    expect(containerCountsOf([])).toEqual({ total: 0, online: 0, offline: 0, lowBattery: 0 })
  })
})

describe('childBatteryOf', () => {
  it('a read that has not answered, or a child past the read bound, is unknown', () => {
    expect(childBatteryOf(undefined, 1)).toBe('unknown')
    expect(childBatteryOf(new Map([[1, 40]]), 2)).toBe('unknown')
  })
  it('an answered read is its level, or none', () => {
    const read = new Map<number, number | 'none'>([
      [1, 40],
      [2, 'none'],
    ])
    expect(childBatteryOf(read, 1)).toBe(40)
    expect(childBatteryOf(read, 2)).toBe('none')
  })
})
