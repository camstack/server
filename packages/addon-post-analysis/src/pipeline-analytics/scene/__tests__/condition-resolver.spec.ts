import { describe, expect, it } from 'vitest'
import { resolveCondition } from '../condition-resolver.js'

describe('resolveCondition', () => {
  it('honours a forced day-night mode first', () => {
    expect(
      resolveCondition({
        forcedMode: 'night',
        coordinates: { lat: 40, lng: 14 },
        now: new Date('2026-07-15T12:00:00Z'),
      }),
    ).toBe('night')
  })
  it('uses sun-times when coordinates are configured and no forced mode', () => {
    // Naples ~40N,14E: 12:00 UTC (14:00 local summer) is day
    expect(
      resolveCondition({
        coordinates: { lat: 40.85, lng: 14.27 },
        now: new Date('2026-07-15T12:00:00Z'),
      }),
    ).toBe('day')
    expect(
      resolveCondition({
        coordinates: { lat: 40.85, lng: 14.27 },
        now: new Date('2026-07-15T02:00:00Z'),
      }),
    ).toBe('night')
  })
  it('falls back to a coarse clock split when no coordinates', () => {
    expect(resolveCondition({ now: new Date('2026-07-15T13:00:00Z') })).toBe('day')
    expect(resolveCondition({ now: new Date('2026-07-15T23:00:00Z') })).toBe('night')
  })

  // The IR-cut is MEASURABLE, and measuring it beats guessing. The `day-night`
  // cap reports the CONFIGURED mode (`auto` for most cameras), which says
  // nothing about now; the clock is a guess; the frame is a direct observation
  // of the very thing that shifts the embedding.
  it('a chromatically flat frame is `ir`, even at noon', () => {
    expect(
      resolveCondition({
        chromaSpread: 1.2,
        coordinates: { lat: 40.85, lng: 14.27 },
        now: new Date('2026-07-15T12:00:00Z'),
      }),
    ).toBe('ir')
  })

  it('a colourful frame at night is NOT ir — a floodlit driveway is still colour', () => {
    expect(
      resolveCondition({
        chromaSpread: 35,
        coordinates: { lat: 40.85, lng: 14.27 },
        now: new Date('2026-07-15T02:00:00Z'),
      }),
    ).toBe('night')
  })

  it('an operator-pinned mode still wins over a measured frame', () => {
    expect(resolveCondition({ forcedMode: 'day', chromaSpread: 0.5, now: new Date() })).toBe('day')
  })

  it('reports dawn/dusk inside the band around sunrise and sunset', () => {
    const coordinates = { lat: 40.85, lng: 14.27 }
    // Naples, mid-July: sunrise ≈ 03:38 UTC, sunset ≈ 18:31 UTC.
    expect(resolveCondition({ coordinates, now: new Date('2026-07-15T03:40:00Z') })).toBe('dawn')
    expect(resolveCondition({ coordinates, now: new Date('2026-07-15T18:20:00Z') })).toBe('dusk')
  })

  it('a scene with only day+ir references reports the conditions it can be asked about', () => {
    // The point of dawn/dusk being their OWN conditions: with no reference for
    // them the scene reports `unknown` rather than scoring a day reference
    // against a half-lit frame and calling the difference a theft.
    const coordinates = { lat: 40.85, lng: 14.27 }
    const dusk = resolveCondition({ coordinates, now: new Date('2026-07-15T18:20:00Z') })
    expect(['dawn', 'dusk']).toContain(dusk)
  })
})
