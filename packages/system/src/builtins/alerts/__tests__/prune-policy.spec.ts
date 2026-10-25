import { describe, it, expect } from 'vitest'
import { selectExpired, selectOverflow, type PrunableAlert } from '../prune-policy.js'

/**
 * A live hub held 2,288 alerts, ALL unread, growing ~128/day, with both
 * `maxAlerts` and `retentionDays` configured — and neither had ever deleted a
 * row, because both prune paths filtered `read: true`.
 *
 * These pin the two rules against exactly that state.
 */
const T = 1_800_000_000_000
const DAY = 86_400_000

const alert = (id: string, ageDays: number, read = false): PrunableAlert => ({
  id,
  createdAt: T - ageDays * DAY,
  read,
})

describe('age-based retention', () => {
  it('expires an UNREAD alert past the window — the whole bug', () => {
    const old = alert('old', 40)
    expect(selectExpired([old], T - 30 * DAY)).toEqual(['old'])
  })

  it('keeps anything inside the window, read or not', () => {
    expect(selectExpired([alert('a', 10), alert('b', 10, true)], T - 30 * DAY)).toEqual([])
  })

  it('returns oldest first', () => {
    const out = selectExpired([alert('newer', 31), alert('older', 90)], T - 30 * DAY)
    expect(out).toEqual(['older', 'newer'])
  })

  it('an all-unread backlog is fully collectable — the live hub state', () => {
    const backlog = Array.from({ length: 2288 }, (_, i) => alert(`a${i}`, 31 + i / 100))
    expect(selectExpired(backlog, T - 30 * DAY)).toHaveLength(2288)
  })
})

describe('the count cap', () => {
  it('bounds a list where NOTHING is read — otherwise it is not a cap', () => {
    const alerts = Array.from({ length: 10 }, (_, i) => alert(`a${i}`, 10 - i))
    const dropped = selectOverflow(alerts, 4)
    expect(dropped).toHaveLength(6)
  })

  it('prefers read alerts, oldest first, before touching an unread one', () => {
    const alerts = [
      alert('unread-oldest', 100),
      alert('read-newer', 5, true),
      alert('read-older', 50, true),
    ]
    // Two must go: both read ones, even though an unread alert is older.
    expect(selectOverflow(alerts, 1)).toEqual(['read-older', 'read-newer'])
  })

  it('falls through to unread once the read ones run out', () => {
    const alerts = [alert('read', 50, true), alert('unread-old', 90), alert('unread-new', 1)]
    expect(selectOverflow(alerts, 1)).toEqual(['read', 'unread-old'])
  })

  it('drops nothing when already within the cap', () => {
    expect(selectOverflow([alert('a', 1)], 5)).toEqual([])
    expect(selectOverflow([], 5)).toEqual([])
  })

  it('never drops more than the excess', () => {
    const alerts = Array.from({ length: 7 }, (_, i) => alert(`a${i}`, i, true))
    expect(selectOverflow(alerts, 5)).toHaveLength(2)
  })
})
