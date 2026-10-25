/**
 * A `disabled` location is an OPERATOR CHOICE, not a fault.
 *
 * This is the one change in the four-state model (D385) that can manufacture a
 * bug report: a read that names a switched-off location used to come back as
 * `unknown recordings location <id>` — a message that says the system has lost
 * track of a location the operator can see on the storage screen. So the two
 * answers are named separately, and both are pinned here.
 */
import { describe, expect, it } from 'vitest'
import { locationUnavailableReason, requireReadableLocation } from '../location-resolve.js'
import type { RecordingsLocation } from '../roots.js'
import { recordingsLocationOfMode } from '../roots.js'

const location = (id: string, mode: Parameters<typeof recordingsLocationOfMode>[1]) =>
  recordingsLocationOfMode({ id, type: 'recordings', root: `/mnt/${id}` }, mode)

const POOL: readonly RecordingsLocation[] = [
  location('recordings:default', 'active'),
  location('recordings:frozen', 'readonly'),
  location('recordings:emptying', 'drain'),
  location('recordings:off', 'disabled'),
]

describe('requireReadableLocation', () => {
  it('serves an active location', () => {
    expect(requireReadableLocation(POOL, 'recordings:default', 'recording').root).toBe(
      '/mnt/recordings:default',
    )
  })

  it('serves readonly and drain — both are still READ', () => {
    expect(requireReadableLocation(POOL, 'recordings:frozen', 'recording').id).toBe(
      'recordings:frozen',
    )
    expect(requireReadableLocation(POOL, 'recordings:emptying', 'recording').id).toBe(
      'recordings:emptying',
    )
  })

  it('reports a DISABLED location as unavailable, never as unknown', () => {
    expect(() => requireReadableLocation(POOL, 'recordings:off', 'recording')).toThrow(
      /UNAVAILABLE/,
    )
    // The distinction is the point: the message must not claim the system has
    // lost a location the operator can see on the storage screen.
    expect(() => requireReadableLocation(POOL, 'recordings:off', 'recording')).not.toThrow(
      /unknown/,
    )
    // …and it names the state, so the operator knows which switch to flip.
    expect(() => requireReadableLocation(POOL, 'recordings:off', 'recording')).toThrow(/disabled/)
  })

  it('still reports a genuinely unknown location as unknown', () => {
    expect(() => requireReadableLocation(POOL, 'recordings:gone', 'recording')).toThrow(
      /unknown location recordings:gone/,
    )
  })

  it('carries the caller context into both messages', () => {
    expect(() => requireReadableLocation(POOL, 'recordings:gone', 'recorder scrub')).toThrow(
      /^recorder scrub:/,
    )
    expect(() => requireReadableLocation(POOL, 'recordings:off', 'recorder scrub')).toThrow(
      /^recorder scrub:/,
    )
  })
})

describe('locationUnavailableReason — the same question without the throw', () => {
  it('separates the two', () => {
    expect(locationUnavailableReason(POOL, 'recordings:default')).toBeNull()
    expect(locationUnavailableReason(POOL, 'recordings:frozen')).toBeNull()
    expect(locationUnavailableReason(POOL, 'recordings:emptying')).toBeNull()
    expect(locationUnavailableReason(POOL, 'recordings:off')).toBe('disabled')
    expect(locationUnavailableReason(POOL, 'recordings:gone')).toBe('unknown')
  })
})
