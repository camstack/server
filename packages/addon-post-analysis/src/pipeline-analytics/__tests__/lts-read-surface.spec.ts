/**
 * The long-term read surface — the history that replaces a RAM ring.
 *
 * The ring it replaces dies with the process, cannot answer about last night,
 * and had a 60-minute horizon. These rows are ~60 bytes, kept for a year, and
 * were already being written; nothing was reading them.
 */
import { describe, expect, it } from 'vitest'

import { occupancyScope, parseOccupancyScope } from '@camstack/types'

describe('the occupancy scope grammar is shared, not re-spelled', () => {
  it('round-trips every shape', () => {
    expect(occupancyScope()).toBe('')
    expect(occupancyScope('z1')).toBe('z1')
    expect(occupancyScope(undefined, 'person')).toBe('|person')
    expect(occupancyScope('z1', 'person')).toBe('z1|person')

    expect(parseOccupancyScope('')).toEqual({ zoneId: '' })
    expect(parseOccupancyScope('z1')).toEqual({ zoneId: 'z1' })
    expect(parseOccupancyScope('|person')).toEqual({ zoneId: '', className: 'person' })
    expect(parseOccupancyScope('z1|person')).toEqual({ zoneId: 'z1', className: 'person' })
  })

  // The two aggregate spellings existed before the class dimension. If either
  // ever parsed as a class scope, every occupancy chart already drawn would
  // start reading a different number without anything failing.
  it('an aggregate scope is never mistaken for a class scope', () => {
    expect(parseOccupancyScope('550e8400-e29b-41d4-a716-446655440000').className).toBeUndefined()
    expect(parseOccupancyScope('').className).toBeUndefined()
  })

  // The writer in this package and the reader in the viewer must import the
  // SAME function. This test exists to fail if someone re-declares it locally.
  it('is re-exported from the history producer from @camstack/types', async () => {
    const store = await import('../store/analytics-history-producer.js')
    expect(store.occupancyScope).toBe(occupancyScope)
    expect(store.parseOccupancyScope).toBe(parseOccupancyScope)
  })
})
