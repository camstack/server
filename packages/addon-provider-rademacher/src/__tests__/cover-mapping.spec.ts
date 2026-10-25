import { describe, expect, it } from 'vitest'
import {
  clampPercent,
  coverStateForPosition,
  type RademacherCoverSnapshot,
  toCoverStatus,
  toLibraryPosition,
} from '../cover-mapping.js'

/**
 * A fake noderademacher `CoverDevice` — faithfully reproduces the library's OWN
 * inversion: on the HomePilot wire `Position` is `0` = open … `100` = closed,
 * and the library getter returns `100 - raw` to expose the HA-style scale
 * (`0` = closed … `100` = open). This fixture takes the RAW wire value and
 * applies that same `100 - raw`, so a test can drive the whole read path from
 * the wire and assert the camstack cover position that results.
 */
function fakeCoverSnapshot(input: {
  wirePosition: number | null
  wireSlat?: number | null
  supportsTilt?: boolean
  online?: boolean
}): RademacherCoverSnapshot {
  const normalize = (raw: number | null): number | null => (raw === null ? null : 100 - raw)
  return {
    position: normalize(input.wirePosition),
    tiltPosition: normalize(input.wireSlat ?? null),
    supportsTilt: input.supportsTilt ?? false,
    online: input.online ?? true,
  }
}

describe('clampPercent', () => {
  it('rounds + clamps into 0..100', () => {
    expect(clampPercent(50.4)).toBe(50)
    expect(clampPercent(-10)).toBe(0)
    expect(clampPercent(150)).toBe(100)
    expect(clampPercent(Number.NaN)).toBe(0)
  })
})

describe('coverStateForPosition', () => {
  it('maps position to the settled lifecycle state', () => {
    expect(coverStateForPosition(0)).toBe('closed')
    expect(coverStateForPosition(100)).toBe('open')
    expect(coverStateForPosition(42)).toBe('open')
    expect(coverStateForPosition(null)).toBe('stopped')
  })
})

describe('toCoverStatus — standard (non-inverted) HomePilot device', () => {
  it('passes the library-normalized position straight through', () => {
    // Wire Position=0 (fully OPEN on the wire) → library normalizes to 100 (open).
    const openish = fakeCoverSnapshot({ wirePosition: 0 })
    const status = toCoverStatus(openish, { invertPosition: false }, 1_000)
    expect(status.position).toBe(100)
    expect(status.state).toBe('open')
    expect(status.lastChangedAt).toBe(1_000)
  })

  it('maps a fully-closed wire reading to camstack position 0 / closed', () => {
    // Wire Position=100 (fully CLOSED on the wire) → library normalizes to 0.
    const closed = fakeCoverSnapshot({ wirePosition: 100 })
    const status = toCoverStatus(closed, { invertPosition: false }, 1)
    expect(status.position).toBe(0)
    expect(status.state).toBe('closed')
  })

  it('maps a mid-travel wire reading (wire 70 → 30% open)', () => {
    const mid = fakeCoverSnapshot({ wirePosition: 70 })
    const status = toCoverStatus(mid, { invertPosition: false }, 1)
    expect(status.position).toBe(30)
    expect(status.state).toBe('open')
  })

  it('leaves tiltPosition null when the device advertises no slat-tilt', () => {
    const noTilt = fakeCoverSnapshot({ wirePosition: 50, wireSlat: 30, supportsTilt: false })
    const status = toCoverStatus(noTilt, { invertPosition: false }, 1)
    expect(status.tiltPosition).toBeNull()
  })

  it('maps slat/tilt when supported (wire 70 → 30% tilt)', () => {
    const withTilt = fakeCoverSnapshot({ wirePosition: 50, wireSlat: 70, supportsTilt: true })
    const status = toCoverStatus(withTilt, { invertPosition: false }, 1)
    expect(status.tiltPosition).toBe(30)
  })
})

describe('toCoverStatus — INVERTED HomePilot device (inverted_cover_position)', () => {
  it('re-inverts the library-normalized position so it reads correctly', () => {
    // This unit reports an already-HA-oriented position on the wire, so the
    // library's blanket `100 - raw` lands BACKWARDS. Wire Position=0 → library
    // normalizes to 100, but the shutter is actually fully CLOSED. invertPosition
    // re-inverts (100 → 0) to recover the correct camstack position.
    const snap = fakeCoverSnapshot({ wirePosition: 0 })
    const status = toCoverStatus(snap, { invertPosition: true }, 1)
    expect(status.position).toBe(0)
    expect(status.state).toBe('closed')
  })

  it('re-inverts a fully-open inverted device to camstack position 100 / open', () => {
    const snap = fakeCoverSnapshot({ wirePosition: 100 })
    const status = toCoverStatus(snap, { invertPosition: true }, 1)
    expect(status.position).toBe(100)
    expect(status.state).toBe('open')
  })

  it('re-inverts a mid-travel inverted device (library 30 → 70)', () => {
    // Wire Position=70 → library normalizes to 30 → invert → 70.
    const snap = fakeCoverSnapshot({ wirePosition: 70 })
    const status = toCoverStatus(snap, { invertPosition: true }, 1)
    expect(status.position).toBe(70)
    expect(status.state).toBe('open')
  })

  it('re-inverts slat/tilt with the same flag', () => {
    const snap = fakeCoverSnapshot({ wirePosition: 50, wireSlat: 20, supportsTilt: true })
    // wire slat 20 → library normalizes to 80 → invert → 20.
    const status = toCoverStatus(snap, { invertPosition: true }, 1)
    expect(status.tiltPosition).toBe(20)
  })
})

describe('toLibraryPosition — write path symmetry', () => {
  it('passes a non-inverted position straight to the library', () => {
    expect(toLibraryPosition(30, false)).toBe(30)
    expect(toLibraryPosition(0, false)).toBe(0)
    expect(toLibraryPosition(100, false)).toBe(100)
  })

  it('re-inverts the target for a flagged-inverted device', () => {
    expect(toLibraryPosition(30, true)).toBe(70)
    expect(toLibraryPosition(0, true)).toBe(100)
    expect(toLibraryPosition(100, true)).toBe(0)
  })

  it('round-trips: a written position reads back as the same camstack position', () => {
    // Operator sets camstack position 25 on an inverted device. The library
    // receives toLibraryPosition(25,true)=75, applies its own 100-raw → wire=25.
    // Reading the wire back: fixture library-normalizes wire 25 → 75, then the
    // inversion flag re-inverts → 25. Same value the operator asked for.
    const written = toLibraryPosition(25, true)
    expect(written).toBe(75)
    const wireAfterLibraryInvert = 100 - written // library's own 100-raw on write
    expect(wireAfterLibraryInvert).toBe(25)
    const snap = fakeCoverSnapshot({ wirePosition: wireAfterLibraryInvert })
    const status = toCoverStatus(snap, { invertPosition: true }, 1)
    expect(status.position).toBe(25)
  })
})
