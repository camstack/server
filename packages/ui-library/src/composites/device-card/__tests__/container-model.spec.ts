import { describe, expect, it } from 'vitest'
import { containerCountsOf, type ContainerCardChild } from '../scenes/container/container-model'

const child = (online: boolean, battery: number | null): ContainerCardChild => ({ online, battery })

describe('containerCountsOf', () => {
  it('splits the children into online, offline and low battery', () => {
    expect(
      containerCountsOf([child(true, 80), child(true, 10), child(false, null), child(false, 5)]),
    ).toEqual({ total: 4, online: 2, offline: 2, lowBattery: 2 })
  })

  it('an unknown battery level is not low (D393)', () => {
    expect(containerCountsOf([child(true, null)]).lowBattery).toBe(0)
  })

  it('the low-battery bar is below 20, not at it', () => {
    expect(containerCountsOf([child(true, 20), child(true, 19)]).lowBattery).toBe(1)
  })

  it('no children is all zero', () => {
    expect(containerCountsOf([])).toEqual({ total: 0, online: 0, offline: 0, lowBattery: 0 })
  })
})
