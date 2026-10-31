import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GEO_IP_ENDPOINTS,
  geolocatePublicIp,
  isUsableCoordinate,
  parseGeoIpPayload,
  type SettingsStoreGateway,
  SITE_LOCATION_KEY,
  SiteLocationService,
  toStatus,
} from '../../api/core/site-location.js'

/** In-memory stand-in for the settings-store cap, keyed the same way. */
function makeStore(seed: Record<string, unknown> = {}) {
  const rows = new Map<string, unknown>(Object.entries(seed))
  const key = (i: { namespace?: string; collection: string; key: string }) =>
    `${i.namespace ?? ''}|${i.collection}|${i.key}`
  const store: SettingsStoreGateway = {
    get: vi.fn(async (i) => rows.get(key(i)) ?? null),
    set: vi.fn(async (i) => {
      rows.set(key(i), i.value)
    }),
  }
  return { store, rows, key }
}

const SYSTEM_ROW = `|system-settings|${SITE_LOCATION_KEY}`
const LEGACY_ROW = 'pipeline-analytics|addon-settings|root'

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

beforeEach(() => {
  SiteLocationService.__resetForTests()
})

describe('isUsableCoordinate', () => {
  it('rejects Null Island, non-finite values and out-of-range degrees', () => {
    expect(isUsableCoordinate(0, 0)).toBe(false)
    expect(isUsableCoordinate(Number.NaN, 12)).toBe(false)
    expect(isUsableCoordinate(91, 12)).toBe(false)
    expect(isUsableCoordinate(40, 181)).toBe(false)
    expect(isUsableCoordinate('40', 12)).toBe(false)
    expect(isUsableCoordinate(40.8518, 14.2681)).toBe(true)
    // A real coordinate with a zero component is NOT Null Island.
    expect(isUsableCoordinate(51.4778, 0)).toBe(true)
  })
})

describe('parseGeoIpPayload', () => {
  it('reads the ipinfo `loc` string', () => {
    expect(parseGeoIpPayload({ loc: '40.8518,14.2681', city: 'Naples', country: 'IT' })).toEqual({
      latitude: 40.8518,
      longitude: 14.2681,
      label: 'Naples, IT',
    })
  })

  it('reads the ipapi latitude/longitude pair', () => {
    expect(
      parseGeoIpPayload({ latitude: 45.4642, longitude: 9.19, city: 'Milan', country_code: 'IT' }),
    ).toEqual({ latitude: 45.4642, longitude: 9.19, label: 'Milan, IT' })
  })

  it('returns null rather than a plausible-looking zero', () => {
    expect(parseGeoIpPayload({ loc: '0,0' })).toBeNull()
    expect(parseGeoIpPayload({ latitude: 'x', longitude: 'y' })).toBeNull()
    expect(parseGeoIpPayload(null)).toBeNull()
    expect(parseGeoIpPayload({ error: 'rate limited' })).toBeNull()
  })
})

describe('geolocatePublicIp', () => {
  it('falls through to the second endpoint when the first refuses', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === GEO_IP_ENDPOINTS[0]
        ? ({ ok: false, status: 429, json: async () => ({}) } as unknown as Response)
        : okResponse({ latitude: 40.85, longitude: 14.26 }),
    )
    await expect(geolocatePublicIp(fetchImpl)).resolves.toEqual({
      latitude: 40.85,
      longitude: 14.26,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('returns null — never throws — when every endpoint fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    })
    await expect(geolocatePublicIp(fetchImpl)).resolves.toBeNull()
  })
})

describe('SiteLocationService.get', () => {
  it('derives a default from the public IP on the first read and persists it', async () => {
    const { store, rows } = makeStore()
    const fetchImpl = vi.fn(async () => okResponse({ loc: '40.8518,14.2681', city: 'Naples' }))
    const svc = new SiteLocationService({ store, fetchImpl, now: () => 1_000 })

    const status = await svc.get()

    expect(status.location).toEqual({
      latitude: 40.8518,
      longitude: 14.2681,
      source: 'derived-from-ip',
      updatedAt: 1_000,
      label: 'Naples',
    })
    expect(rows.get(SYSTEM_ROW)).toMatchObject({ source: 'derived-from-ip' })
  })

  it('never calls geo-IP again once a value is stored', async () => {
    const { store } = makeStore({
      [SYSTEM_ROW]: {
        latitude: 1.5,
        longitude: 2.5,
        source: 'operator-set',
        updatedAt: 7,
      },
    })
    const fetchImpl = vi.fn()
    const svc = new SiteLocationService({ store, fetchImpl })

    const status = await svc.get()

    expect(status.location?.source).toBe('operator-set')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('persists the FAILURE and never retries on a read path', async () => {
    const { store, rows } = makeStore()
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    const svc = new SiteLocationService({ store, fetchImpl, now: () => 42 })

    const first = await svc.get()
    expect(first.location).toBeNull()
    expect(first.derivationAttemptedAt).toBe(42)
    expect(first.derivationError).not.toBeNull()
    expect(rows.get(SYSTEM_ROW)).toMatchObject({ derivationAttemptedAt: 42 })

    const callsAfterFirst = fetchImpl.mock.calls.length
    const second = await svc.get()
    expect(second.location).toBeNull()
    // The whole contract: ONE call, ever.
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst)
  })

  it('single-flights concurrent first reads into one lookup pass', async () => {
    const { store } = makeStore()
    const fetchImpl = vi.fn(async () => okResponse({ loc: '40.85,14.26' }))
    const svc = new SiteLocationService({ store, fetchImpl })

    await Promise.all([svc.get(), svc.get(), svc.get()])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('migrates the old pipeline-analytics setting as operator-set, without a lookup', async () => {
    const { store, rows } = makeStore({
      [LEGACY_ROW]: { siteLatitude: 40.8518, siteLongitude: 14.2681, someOtherKey: 1 },
    })
    const fetchImpl = vi.fn()
    const svc = new SiteLocationService({ store, fetchImpl, now: () => 5 })

    const status = await svc.get()

    expect(status.location).toMatchObject({
      latitude: 40.8518,
      longitude: 14.2681,
      source: 'operator-set',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(rows.get(SYSTEM_ROW)).toMatchObject({ source: 'operator-set' })
  })

  it('ignores a blank legacy setting and derives instead', async () => {
    const { store } = makeStore({ [LEGACY_ROW]: { siteLatitude: 0, siteLongitude: 0 } })
    const fetchImpl = vi.fn(async () => okResponse({ loc: '45.46,9.19' }))
    const svc = new SiteLocationService({ store, fetchImpl })

    const status = await svc.get()

    expect(status.location?.source).toBe('derived-from-ip')
  })

  it('propagates a failed READ instead of deriving over an unknown value', async () => {
    const store: SettingsStoreGateway = {
      get: vi.fn(async () => {
        throw new Error('storage down')
      }),
      set: vi.fn(async () => undefined),
    }
    const fetchImpl = vi.fn()
    const svc = new SiteLocationService({ store, fetchImpl })

    await expect(svc.get()).rejects.toThrow('storage down')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store.set).not.toHaveBeenCalled()
  })
})

describe('SiteLocationService.set / detect', () => {
  it('stores operator input as operator-set', async () => {
    const { store, rows } = makeStore()
    const svc = new SiteLocationService({ store, now: () => 99 })

    const status = await svc.set({ latitude: 51.5, longitude: -0.12 })

    expect(status.location).toMatchObject({ source: 'operator-set', updatedAt: 99 })
    expect(rows.get(SYSTEM_ROW)).toMatchObject({ latitude: 51.5, longitude: -0.12 })
  })

  it('clearing leaves the derivation spent — it does not re-arm a guess', async () => {
    const { store } = makeStore()
    const fetchImpl = vi.fn()
    const svc = new SiteLocationService({ store, fetchImpl, now: () => 3 })

    await svc.set(null)
    const after = await svc.get()

    expect(after.location).toBeNull()
    expect(after.derivationAttemptedAt).toBe(3)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('detect retries after a failure', async () => {
    const { store } = makeStore({ [SYSTEM_ROW]: { derivationAttemptedAt: 1 } })
    const fetchImpl = vi.fn(async () => okResponse({ loc: '40.85,14.26' }))
    const svc = new SiteLocationService({ store, fetchImpl })

    const status = await svc.detect()

    expect(status.location?.source).toBe('derived-from-ip')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('detect refuses to clobber an operator-set value', async () => {
    const { store } = makeStore({
      [SYSTEM_ROW]: { latitude: 1.5, longitude: 2.5, source: 'operator-set', updatedAt: 7 },
    })
    const fetchImpl = vi.fn()
    const svc = new SiteLocationService({ store, fetchImpl })

    const status = await svc.detect()

    expect(status.location).toMatchObject({ latitude: 1.5, source: 'operator-set' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('toStatus — the site time zone', () => {
  it('always names an IANA zone, with or without a location (the hub zone by default)', () => {
    const none = toStatus(null)
    expect(none.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(none.timeZone.length).toBeGreaterThan(0)
    const located = toStatus(
      { latitude: 41.9, longitude: 12.5, source: 'operator-set', updatedAt: 1 },
      'Europe/Rome',
    )
    expect(located.timeZone).toBe('Europe/Rome')
    expect(located.location?.latitude).toBe(41.9)
  })
})
