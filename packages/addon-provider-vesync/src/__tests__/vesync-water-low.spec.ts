/**
 * The water-low sensor never claims "tank OK" before a real read said so (D315: not-yet-known
 * must never look like a value). Its `binary` slice stays unset until the first reported tank,
 * and a status asked before that is refused, not answered `false`.
 */
import { describe, expect, it } from 'vitest'
import { waterLowNext, waterLowStatus } from '../devices/vesync-sensor-device.js'

describe('water-low sensor', () => {
  it('an unread tank answers no status (refused), never on: false', () => {
    expect(() => waterLowStatus(undefined)).toThrow(/not read yet/)
  })

  it('a snapshot that does not report the tank writes nothing', () => {
    expect(waterLowNext(undefined, null, 1_000)).toBeNull()
  })

  it('the first real read is written, a repeat is not', () => {
    const first = waterLowNext(undefined, false, 1_000)
    expect(first).toEqual({ on: false, lastChangedAt: 1_000 })
    expect(waterLowNext(first ?? undefined, false, 2_000)).toBeNull()
    expect(waterLowNext(first ?? undefined, true, 3_000)).toEqual({
      on: true,
      lastChangedAt: 3_000,
    })
  })
})
