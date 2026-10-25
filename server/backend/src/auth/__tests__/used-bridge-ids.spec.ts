import { describe, expect, it } from 'vitest'
import { UsedBridgeIds } from '../used-bridge-ids.js'

describe('UsedBridgeIds', () => {
  it('accepts a jti once and refuses every replay', () => {
    const ids = new UsedBridgeIds()
    expect(ids.consume('j-1')).toBe(true)
    expect(ids.consume('j-1')).toBe(false)
    expect(ids.consume('j-1')).toBe(false)
    expect(ids.consume('j-2')).toBe(true)
  })

  it('forgets an entry only after every bridge it could belong to has expired', () => {
    let now = 0
    const ids = new UsedBridgeIds({ now: () => now })
    ids.consume('j-1')
    now += 5 * 60_000
    expect(ids.consume('j-1')).toBe(false)
    now += 6 * 60_000
    ids.consume('j-other')
    expect(ids.size()).toBe(1)
  })

  it('is bounded', () => {
    const ids = new UsedBridgeIds({ maxEntries: 3 })
    for (let i = 0; i < 10; i++) ids.consume(`j-${i}`)
    expect(ids.size()).toBe(3)
  })
})
