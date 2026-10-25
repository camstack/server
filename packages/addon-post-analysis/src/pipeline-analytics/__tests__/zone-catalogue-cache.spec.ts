import { describe, expect, it } from 'vitest'
import { ZONE_CATALOGUE_TTL_MS, ZoneCatalogueCache } from '../zone-catalogue-cache.js'

const USCIO = 'cfeec78c-8d69-4678-9d25-937193eacb5d'

function cache(
  fetcher: (deviceId: number) => Promise<readonly { id: string; name: string }[]>,
  now: () => number,
): ZoneCatalogueCache {
  return new ZoneCatalogueCache({ fetchZones: fetcher, now, onError: () => {} })
}

describe('ZoneCatalogueCache', () => {
  it('reads a device once and answers from memory afterwards', async () => {
    let calls = 0
    const c = cache(
      async () => {
        calls += 1
        return [{ id: USCIO, name: 'Uscio' }]
      },
      () => 0,
    )

    await c.ensure([101, 101])
    await c.ensure([101])
    expect(calls).toBe(1)
    expect(c.lookup(101)?.get(USCIO)).toBe('Uscio')
  })

  it('re-reads only after the TTL — a rename must not need a restart', async () => {
    let calls = 0
    let clock = 0
    const c = cache(
      async () => {
        calls += 1
        return [{ id: USCIO, name: calls === 1 ? 'Uscio' : 'Front door' }]
      },
      () => clock,
    )

    await c.ensure([101])
    clock = ZONE_CATALOGUE_TTL_MS - 1
    await c.ensure([101])
    expect(calls).toBe(1)
    clock = ZONE_CATALOGUE_TTL_MS + 1
    await c.ensure([101])
    expect(calls).toBe(2)
    expect(c.lookup(101)?.get(USCIO)).toBe('Front door')
  })

  it('KEEPS the last known catalogue when a refresh throws', async () => {
    // A zones cap that blips must not turn every zoned track into an unzoned
    // one for the next minute — that would read as "the zone stopped working".
    let calls = 0
    let clock = 0
    const c = cache(
      async () => {
        calls += 1
        if (calls > 1) throw new Error('zones provider unavailable')
        return [{ id: USCIO, name: 'Uscio' }]
      },
      () => clock,
    )

    await c.ensure([101])
    clock = ZONE_CATALOGUE_TTL_MS + 1
    await c.ensure([101])
    expect(c.lookup(101)?.get(USCIO)).toBe('Uscio')
  })

  it('answers null for a device it has never been able to read', async () => {
    const c = cache(
      async () => {
        throw new Error('nope')
      },
      () => 0,
    )
    await c.ensure([101])
    expect(c.lookup(101)).toBeNull()
  })

  it('reads each device separately — ids are unique only within a camera', async () => {
    const seen: number[] = []
    const c = cache(
      async (deviceId) => {
        seen.push(deviceId)
        return [{ id: USCIO, name: `zone-${deviceId}` }]
      },
      () => 0,
    )
    await c.ensure([101, 102])
    expect(seen.sort()).toEqual([101, 102])
    expect(c.lookup(102)?.get(USCIO)).toBe('zone-102')
  })
})
