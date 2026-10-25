/**
 * Event-media occupancy (D388) — mostly about where the LEGACY rows go.
 */
import { describe, expect, it } from 'vitest'
import { legacyMediaLocationOf, mediaOccupancyReports } from '../media-occupancy.js'

describe('legacyMediaLocationOf', () => {
  it('the sole eventMedia location takes the NULL-stamped rows', () => {
    expect(legacyMediaLocationOf(['recordings:default', 'eventMedia:nas'])).toBe('eventMedia:nas')
  })

  it('with several, the `:default`-slugged one — the same rule resolveRef applies', () => {
    expect(legacyMediaLocationOf(['eventMedia:nas', 'eventMedia:default'])).toBe(
      'eventMedia:default',
    )
  })

  it('with several and no `:default`, NOBODY takes them', () => {
    expect(legacyMediaLocationOf(['eventMedia:a', 'eventMedia:b'])).toBeNull()
    expect(legacyMediaLocationOf(['recordings:default'])).toBeNull()
  })
})

describe('mediaOccupancyReports', () => {
  it('omits a location with nothing on it — it never reports a zero', () => {
    const { reports } = mediaOccupancyReports(
      { byLocation: new Map([['eventMedia:default', 0]]), legacyNullBytes: 0 },
      ['eventMedia:default', 'recordings:default'],
      50,
    )
    expect(reports).toEqual([])
  })

  it('adds the legacy NULL bytes onto the resolved location', () => {
    const { reports, unattributedBytes } = mediaOccupancyReports(
      { byLocation: new Map([['eventMedia:default', 100]]), legacyNullBytes: 400 },
      ['eventMedia:default'],
      50,
    )
    expect(reports).toEqual([
      { locationId: 'eventMedia:default', ownedBytes: 500, measuredAtMs: 50 },
    ])
    expect(unattributedBytes).toBe(0)
  })

  it('reports unplaceable legacy bytes NOWHERE, and says how many', () => {
    // Spreading them over the candidates, or dropping them on the first one,
    // would put a number on a screen that no disk agrees with.
    const { reports, unattributedBytes } = mediaOccupancyReports(
      { byLocation: new Map([['eventMedia:a', 10]]), legacyNullBytes: 400 },
      ['eventMedia:a', 'eventMedia:b'],
      50,
    )
    expect(reports).toEqual([{ locationId: 'eventMedia:a', ownedBytes: 10, measuredAtMs: 50 }])
    expect(unattributedBytes).toBe(400)
  })
})
