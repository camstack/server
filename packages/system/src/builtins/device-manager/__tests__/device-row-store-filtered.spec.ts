/**
 * A question about EIGHT devices must not read nine hundred and sixty-seven.
 *
 * `listAll` on this store is a full-fleet `SELECT … ORDER BY "deviceId"`, and
 * `device-queries.ts#listAll` then threw most of it away in JS: the viewer's
 * linked-devices panel asks for ~8 named ids and was answered by reading the
 * whole ledger and filtering the result. Measured on the live hub 2026-08-25:
 * ~1 017 rows per call, 14–54 calls a minute.
 *
 * So the id set becomes a `whereIn` and the slim projection becomes a `columns`
 * list. Both are asserted here on what the store ASKED the backend for — the
 * returned rows are identical either way, which is exactly why asserting on
 * them would prove nothing.
 *
 * ## The two things this file refuses to let anyone "simplify"
 *
 * 1. **The projection is a DENYLIST.** `decodeDeviceRow` returns `null` — and
 *    the row VANISHES from every listing, with only a warn — when `deviceId`,
 *    `addonId`, `stableId`, `type` or `name` is missing. An allowlist that
 *    forgot one would not slow the fleet down, it would empty it. So the slim
 *    list is "every declared column except the ones slim provably discards",
 *    and the test derives its expectation the same way.
 *
 * 2. **`isCamera` is NOT pushed down.** `isCameraDevice` is a method-presence
 *    check (`getStreamSources`), not the persisted `type` — a doorbell with a
 *    camera answers yes while its row says `doorbell`. A `where: {type:
 *    'camera'}` would strip the rows of exactly those devices, and since
 *    `toDeviceInfo` reads `name` / `location` / `disabled` from the ROW (the
 *    live device's copies are stale by construction), they would silently start
 *    reporting pre-rename names. The type filter stays in JS on purpose.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceRowBackend } from '../device-row-store.js'
import {
  DEVICE_ROWS_COLUMNS,
  DEVICE_ROWS_SLIM_COLUMNS,
  DeviceRowStore,
  deviceRowBackendOf,
} from '../device-row-store.js'
import { FleetReadCensus } from '../fleet-read-census.js'
import { makeSettingsStoreApi } from './settings-store-api.js'

interface QueryCall {
  readonly whereIn?: Record<string, unknown>
  readonly columns?: readonly string[]
}

function recordingBackend(inner: DeviceRowBackend): {
  backend: DeviceRowBackend
  queries: QueryCall[]
} {
  const queries: QueryCall[] = []
  const backend: DeviceRowBackend = {
    ...inner,
    query: (input) => {
      const withCols = input as { columns?: readonly string[] }
      queries.push({
        ...(input.filter?.whereIn !== undefined ? { whereIn: input.filter.whereIn } : {}),
        ...(withCols.columns !== undefined ? { columns: withCols.columns } : {}),
      })
      return inner.query(input)
    },
  }
  return { backend, queries }
}

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

async function makeStore(): Promise<{ store: DeviceRowStore; queries: QueryCall[] }> {
  const api = await makeSettingsStoreApi()
  const { backend, queries } = recordingBackend(deviceRowBackendOf(api.api))
  const store = new DeviceRowStore(backend, makeLogger())
  for (const id of [1, 2, 3, 4, 5]) {
    await store.upsert(
      {
        id,
        addonId: 'addon-a',
        stableId: `s-${id}`,
        type: id === 3 ? 'doorbell' : 'camera',
        name: `dev-${id}`,
        location: null,
        disabled: false,
        parentDeviceId: null,
      },
      { registered: true },
    )
  }
  queries.length = 0
  return { store, queries }
}

describe('DeviceRowStore.listFleet — the read is as narrow as the question', () => {
  it('an id set becomes a whereIn, not a full scan filtered afterwards', async () => {
    const { store, queries } = await makeStore()

    const rows = await store.listFleet({ deviceIds: [2, 4] })

    expect(queries).toHaveLength(1)
    expect(queries[0]?.whereIn).toEqual({ deviceId: [2, 4] })
    expect(rows.map((r) => r.meta.id)).toEqual([2, 4])
  })

  it('an EMPTY id set reads nothing at all — a request for nothing is honoured', async () => {
    const { store, queries } = await makeStore()

    const rows = await store.listFleet({ deviceIds: [] })

    expect(rows).toEqual([])
    expect(queries).toHaveLength(0)
  })

  it('no id set is still the whole fleet, with no whereIn', async () => {
    const { store, queries } = await makeStore()

    const rows = await store.listFleet({})

    expect(queries).toHaveLength(1)
    expect(queries[0]?.whereIn).toBeUndefined()
    expect(rows).toHaveLength(5)
  })

  it('the slim projection is every declared column MINUS metadata — a denylist', async () => {
    const { store, queries } = await makeStore()

    await store.listFleet({ slim: true })

    const asked = queries[0]?.columns
    expect(asked).toBeDefined()
    expect(asked).toEqual(DEVICE_ROWS_SLIM_COLUMNS)
    // Derived the same way the store derives it: nothing is enumerated by hand
    // on either side, so a column added tomorrow is carried by both.
    const declared = DEVICE_ROWS_COLUMNS.map((c) => c.name).filter(
      (n) => n !== 'id' && n !== 'metadata',
    )
    expect([...(asked ?? [])].sort()).toEqual([...declared].sort())
  })

  it('every field `decodeDeviceRow` REQUIRES survives the slim projection', async () => {
    // The failure this guards is not slowness: a projection missing one of
    // these makes `decodeDeviceRow` return null and the device disappears from
    // the fleet with a warn nobody reads.
    for (const required of ['deviceId', 'addonId', 'stableId', 'type', 'name']) {
      expect(DEVICE_ROWS_SLIM_COLUMNS).toContain(required)
    }
  })

  it('a slim read still decodes to the same devices a full read does', async () => {
    const { store } = await makeStore()

    const full = await store.listFleet({})
    const slim = await store.listFleet({ slim: true })

    expect(slim.map((r) => r.meta.id)).toEqual(full.map((r) => r.meta.id))
    expect(slim.map((r) => r.meta.name)).toEqual(full.map((r) => r.meta.name))
    expect(slim.map((r) => r.meta.type)).toEqual(full.map((r) => r.meta.type))
  })

  it('the full projection sends no column list at all', async () => {
    const { store, queries } = await makeStore()

    await store.listFleet({})

    expect(queries[0]?.columns).toBeUndefined()
  })
})

describe('DeviceRowStore.getMany — a primary-key lookup that stays ONE query, however many ids', () => {
  it('one query, whereIn the requested ids — not N primary-key lookups', async () => {
    const { store, queries } = await makeStore()

    const rows = await store.getMany([2, 4])

    expect(queries).toHaveLength(1)
    expect(queries[0]?.whereIn).toEqual({ deviceId: [2, 4] })
    expect(rows.size).toBe(2)
    expect(rows.get(2)?.meta.id).toBe(2)
    expect(rows.get(4)?.meta.id).toBe(4)
  })

  it('a device the fleet does not know gets NO map entry — never a fabricated row', async () => {
    const { store, queries } = await makeStore()

    const rows = await store.getMany([2, 4242])

    expect(queries).toHaveLength(1)
    expect(rows.size).toBe(1)
    expect(rows.has(4242)).toBe(false)
    expect(rows.get(2)?.meta.id).toBe(2)
  })

  it('an empty id list issues no query at all', async () => {
    const { store, queries } = await makeStore()

    const rows = await store.getMany([])

    expect(rows.size).toBe(0)
    expect(queries).toHaveLength(0)
  })
})

describe('the fleet census names the real caller, not a microtask', () => {
  // This pins `device-row-store.ts` itself, not the census in the abstract. The
  // 2026-08-26 boot measurement came back naming `listAll` with
  // `processTicksAndRejections` as its caller — useless, because `siteOf()` sat
  // below `await this.declare()` and an await severs the synchronous stack. The
  // instrument was fine; its placement was not.
  it('a named caller appears in the site, and no microtask frame does', async () => {
    const api = await makeSettingsStoreApi()
    const { backend } = recordingBackend(deviceRowBackendOf(api.api))
    const census = new FleetReadCensus('60000', Date.now())
    const store = new DeviceRowStore(backend, makeLogger(), census)

    const aVeryDistinctiveCaller = async (): Promise<void> => {
      await store.listFleet({})
    }
    await aVeryDistinctiveCaller()

    const sites = census.rows().map((r) => r.site)
    expect(sites.length).toBeGreaterThan(0)
    expect(sites.join(' | ')).toContain('aVeryDistinctiveCaller')
    for (const s of sites) expect(s).not.toContain('processTicksAndRejections')
  })
})
