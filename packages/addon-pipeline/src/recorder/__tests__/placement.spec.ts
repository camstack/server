/**
 * `resolvePlacement` — routes a recording profile to its storage location.
 *
 * Regression guard: storage-location ids are `<type>:<instance>` (e.g.
 * `recordings:default`, `recordingsLow:default`), so matching against the bare
 * string `'recordings'` / `'recordingsLow'` never hit. Placement now matches on
 * the location's declared `type`, so `low` correctly routes to `recordingsLow`
 * the day the two types resolve to different disks.
 */
import { describe, it, expect } from 'vitest'
import {
  resolvePlacement,
  type RecordingsLocation,
  recordingsLocationOfMode,
} from '../addon/roots.js'

const HIGH: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:default', type: 'recordings', root: '/data/rec' },
  'active',
)
const LOW: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordingsLow:default', type: 'recordingsLow', root: '/data/rec-low' },
  'active',
)
const HIGH_RO: RecordingsLocation = recordingsLocationOfMode(
  { ...HIGH, id: 'recordings:old-disk' },
  'readonly',
)
const LOW_RO: RecordingsLocation = recordingsLocationOfMode(
  { ...LOW, id: 'recordingsLow:old-disk' },
  'readonly',
)

describe('resolvePlacement', () => {
  it('routes the low profile to the recordingsLow location', () => {
    expect(resolvePlacement([HIGH, LOW], 'low')).toBe(LOW)
  })

  it('routes high/mid profiles to the recordings location', () => {
    expect(resolvePlacement([HIGH, LOW], 'high')).toBe(HIGH)
    expect(resolvePlacement([HIGH, LOW], 'mid')).toBe(HIGH)
  })

  it('is order-independent (recordingsLow declared first still matches low)', () => {
    expect(resolvePlacement([LOW, HIGH], 'low')).toBe(LOW)
    expect(resolvePlacement([LOW, HIGH], 'high')).toBe(HIGH)
  })

  it('falls back to the first location when the preferred type is absent (single disk)', () => {
    // Only the `recordings` location exists — low falls back to it (same disk today).
    expect(resolvePlacement([HIGH], 'low')).toBe(HIGH)
    expect(resolvePlacement([HIGH], 'high')).toBe(HIGH)
  })

  it('throws when no recordings locations are resolved', () => {
    expect(() => resolvePlacement([], 'high')).toThrow(/no recordings storage locations/)
  })

  // ── Read-only (drain) semantics ────────────────────────────────────
  it('never writes to a read-only location, even when its type matches', () => {
    // The draining recordingsLow disk is skipped; low falls to the writable
    // recordings location.
    expect(resolvePlacement([HIGH, LOW_RO], 'low')).toBe(HIGH)
  })

  it('a read-only location never wins the untyped fallback either', () => {
    expect(resolvePlacement([HIGH_RO, LOW], 'high')).toBe(LOW)
  })

  it('throws LOUDLY when every location is read-only — recording cannot start', () => {
    expect(() => resolvePlacement([HIGH_RO, LOW_RO], 'high')).toThrow(/read-only/)
  })
})
