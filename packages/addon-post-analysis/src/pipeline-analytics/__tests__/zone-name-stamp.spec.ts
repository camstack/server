import type { Track } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { stampZoneNames } from '../zone-name-stamp.js'

/**
 * The ids and names below are camera 101's, read off the live hub on
 * 2026-08-09 (`zones.listZones`) — the only two zones on the whole fleet, and
 * the exact pair a track's `zonesVisited` carries. An invented `zone-1` /
 * `Porch` fixture would not have shown that the stored value is a UUID, which
 * is the entire defect.
 */
const USCIO = 'cfeec78c-8d69-4678-9d25-937193eacb5d'
const AIUOLA = 'fa03b60a-5669-4a8a-976b-bac422f5f530'

const CATALOGUE: ReadonlyMap<number, ReadonlyMap<string, string>> = new Map([
  [
    101,
    new Map([
      [USCIO, 'Uscio'],
      [AIUOLA, 'Aiuola'],
    ]),
  ],
])

function track(over: Partial<Track>): Track {
  return {
    trackId: 'trk-1',
    deviceId: 101,
    className: 'person',
    firstSeen: 1000,
    lastSeen: 2000,
    positions: [],
    snapshots: [],
    zonesVisited: [],
    totalDistance: 0,
    state: 'idle',
    active: false,
    ...over,
  } as Track
}

describe('stampZoneNames', () => {
  const lookup = (deviceId: number): ReadonlyMap<string, string> | null =>
    CATALOGUE.get(deviceId) ?? null

  it('resolves the zone ids a track visited into the names an operator typed', () => {
    const [out] = stampZoneNames([track({ zonesVisited: [USCIO, AIUOLA] })], lookup)
    expect(out?.zoneNames).toEqual(['Uscio', 'Aiuola'])
    // The ids stay — the zone FILTER and the trajectory overlay both key on them.
    expect(out?.zonesVisited).toEqual([USCIO, AIUOLA])
  })

  it('DROPS a zone that no longer exists rather than inventing a name', () => {
    const [out] = stampZoneNames([track({ zonesVisited: [USCIO, 'deleted-zone-id'] })], lookup)
    expect(out?.zoneNames).toEqual(['Uscio'])
  })

  it('leaves a zoneless track untouched — no empty array on the wire', () => {
    const [out] = stampZoneNames([track({})], lookup)
    expect(out).not.toHaveProperty('zoneNames')
  })

  it('stays silent when the catalogue cannot be read', () => {
    // A zones cap that is down must not erase the ids or stamp a wrong name.
    const [out] = stampZoneNames([track({ zonesVisited: [USCIO] })], () => null)
    expect(out).not.toHaveProperty('zoneNames')
    expect(out?.zonesVisited).toEqual([USCIO])
  })

  it('never mutates the input track', () => {
    const input = track({ zonesVisited: [USCIO] })
    const [out] = stampZoneNames([input], lookup)
    expect(input).not.toHaveProperty('zoneNames')
    expect(out).not.toBe(input)
  })

  it('resolves per DEVICE — zone ids are only unique within a camera', () => {
    const other = track({ deviceId: 102, zonesVisited: [USCIO] })
    const [out] = stampZoneNames([other], lookup)
    expect(out).not.toHaveProperty('zoneNames')
  })
})
