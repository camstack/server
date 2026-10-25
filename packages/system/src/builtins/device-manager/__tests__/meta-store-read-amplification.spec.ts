/**
 * One question about ONE device reads one row. One question about the fleet
 * reads the collection once. Neither is a cache.
 *
 * ## What this file used to pin, and why that is gone
 *
 * `DeviceMetaStore` projected four things out of one addon-store row set —
 * `deviceIndex`, `deviceMeta`, `deviceMetadata` and the per-device
 * `resolvePersistedById` — and each one called `readAddonStore()`. That read is
 * not cheap and does not get cheaper with fleet size: on the live hub the three
 * blobs were 625 KB, so every projection was a 625 KB read plus a 625 KB
 * `JSON.parse`, synchronously, on hub-main's event loop — the loop that also
 * answers every runner's UDS request. A V8 profile of the 2026-08-19 boot found
 * hub-main's JS thread **99.9% busy for 76 s with 64% of it inside
 * `getAllAddon`**, ~89% of that entered through this class.
 *
 * The old fix was `readAll()`: one read serving three projections. It made the
 * amplification 1× instead of 3× and left the 625 KB in place — a device's
 * NAME still cost the whole fleet. The flatten removes the amplification
 * itself: `device-manager:devices` is one row per device, so
 * `resolvePersistedById` is a primary-key lookup that reads one row whatever
 * the fleet size, and there is no `readAll` because there is no blob to
 * project.
 *
 * ## What it pins now
 *
 *  1. **A per-device question reads one row.** Not the fleet, not a filtered
 *     scan — a `get` on the primary key.
 *  2. **A fleet question is ONE statement**, and it is bounded explicitly (the
 *     engine's silent 2 000-row default cap is half the reference hub's fleet).
 *  3. **Nothing is retained.** Two identical reads reach the store twice.
 *  4. **The write lock still serialises** read-modify-write pairs, which is the
 *     only thing column-scoped writes did NOT make unnecessary.
 *  5. **A write that lands on nothing says so.** The `patch` path is an UPDATE;
 *     matching zero rows means a device was removed under it and the patch is
 *     lost. Silence there reads as a write that happened.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceManagerSettings } from '../device-meta-store.js'
import { DeviceMetaStore } from '../device-meta-store.js'
import type { PersistedDeviceMeta } from '../device-meta-types.js'
import type { DeviceRowBackend } from '../device-row-store.js'
import { DEVICE_ROWS_FLEET_LIMIT, DeviceRowStore, deviceRowBackendOf } from '../device-row-store.js'
import { makeSettingsStoreApi } from './settings-store-api.js'

interface Call {
  readonly op: 'get' | 'query' | 'count' | 'set' | 'updateWhere' | 'delete'
  readonly key?: string
  readonly limit?: number
  readonly where?: Record<string, unknown>
}

/** The real backend, with every call it receives recorded in order. */
function countingBackend(inner: DeviceRowBackend): {
  backend: DeviceRowBackend
  calls: Call[]
} {
  const calls: Call[] = []
  const backend: DeviceRowBackend = {
    declareCollection: (input) => inner.declareCollection(input),
    get: (input) => {
      calls.push({ op: 'get', key: input.key })
      return inner.get(input)
    },
    query: (input) => {
      calls.push({
        op: 'query',
        ...(input.filter?.limit !== undefined ? { limit: input.filter.limit } : {}),
        ...(input.filter?.where !== undefined ? { where: input.filter.where } : {}),
      })
      return inner.query(input)
    },
    count: (input) => {
      calls.push({ op: 'count' })
      return inner.count(input)
    },
    set: (input) => {
      calls.push({ op: 'set', key: input.key })
      return inner.set(input)
    },
    updateWhere: (input) => {
      calls.push({ op: 'updateWhere' })
      return inner.updateWhere(input)
    },
    delete: (input) => {
      calls.push({ op: 'delete', key: input.key })
      return inner.delete(input)
    },
  }
  return { backend, calls }
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

function meta(id: number, addonId: string, stableId: string): PersistedDeviceMeta {
  return {
    id,
    addonId,
    stableId,
    type: 'camera',
    name: `cam-${id}`,
    location: null,
    disabled: false,
    parentDeviceId: null,
  }
}

async function fleet(): Promise<{
  rows: DeviceRowStore
  calls: Call[]
  logger: IScopedLogger
}> {
  const store = await makeSettingsStoreApi()
  const { backend, calls } = countingBackend(deviceRowBackendOf(store.api))
  const logger = makeLogger()
  const rows = new DeviceRowStore(backend, logger)
  await rows.upsert(meta(101, 'provider-hikvision', 'cam-1'), { registered: true })
  await rows.upsert(meta(102, 'provider-hikvision', 'cam-2'), { registered: true })
  await rows.upsert(meta(900, 'provider-rtsp', 'door'), { registered: true })
  calls.length = 0
  return { rows, calls, logger }
}

/**
 * The settings surface `DeviceMetaStore` still uses — for `nextDeviceId` and
 * the location registry, which are not devices and never were.
 *
 * Type boundary: `DeviceManagerSettings` is the whole `ctx.settings` surface
 * and this exercises two of its methods; the store only ever reaches for what
 * is stubbed here.
 */
function countingSettings(store: Record<string, unknown>): {
  settings: DeviceManagerSettings
  reads: () => number
} {
  let reads = 0
  const partial = {
    readAddonStore: async (): Promise<Record<string, unknown>> => {
      reads += 1
      await Promise.resolve()
      return store
    },
    writeAddonStore: async (): Promise<void> => {},
  }
  return { settings: partial as unknown as DeviceManagerSettings, reads: () => reads }
}

describe('a per-device question reads ONE row', () => {
  it('resolves a device by primary key, never by scanning the fleet', async () => {
    const { rows, calls } = await fleet()
    const s = countingSettings({ nextDeviceId: 901 })
    const metaStore = new DeviceMetaStore(s.settings, null, rows)

    const persisted = await metaStore.resolvePersistedById(102)

    expect(persisted?.addonId).toBe('provider-hikvision')
    expect(persisted?.stableId).toBe('cam-2')
    expect(calls).toEqual([{ op: 'get', key: '102' }])
    expect(s.reads(), 'a device is not on the addon-settings row set any more').toBe(0)
  })

  it('serves identity AND hardware metadata from that same row', async () => {
    const { rows, calls } = await fleet()
    await rows.patch(101, { metadata: { mac: 'aa:bb' } })
    calls.length = 0

    const row = await rows.get(101)

    expect(row?.metadata).toEqual({ mac: 'aa:bb' })
    expect(row?.meta.name).toBe('cam-101')
    expect(calls, 'metadata used to be a second blob, and a second read').toEqual([
      { op: 'get', key: '101' },
    ])
  })

  it('answers an unknown device without touching the rest of the fleet', async () => {
    const { rows, calls } = await fleet()
    expect(await rows.get(4242)).toBeNull()
    expect(calls).toEqual([{ op: 'get', key: '4242' }])
  })
})

describe('a fleet question is ONE statement, explicitly bounded', () => {
  it('lists every device in one query, with a limit the caller chose', async () => {
    const { rows, calls } = await fleet()

    const all = await rows.listAll()

    expect(all.map((r) => r.meta.id)).toEqual([101, 102, 900])
    expect(calls).toEqual([{ op: 'query', limit: DEVICE_ROWS_FLEET_LIMIT }])
  })

  it('scopes an addon listing to that addon rather than filtering in JS', async () => {
    const { rows, calls } = await fleet()

    const mine = await rows.listByAddon('provider-hikvision')

    expect(mine.map((r) => r.meta.id)).toEqual([101, 102])
    expect(calls).toEqual([
      { op: 'query', where: { addonId: 'provider-hikvision' }, limit: DEVICE_ROWS_FLEET_LIMIT },
    ])
  })

  it('never lets the engine impose its default row cap on a fleet read', async () => {
    // 974 devices on the reference hub against a silent 2 000-row default:
    // a truncated fleet listing looks exactly like a shrunken fleet.
    const { rows, calls } = await fleet()
    await rows.listAll()
    await rows.listByAddon('provider-rtsp')
    await rows.listByParent(101)
    await rows.listByIntegration('int_0001')
    for (const call of calls) {
      expect(call.op).toBe('query')
      expect(call.limit).toBe(DEVICE_ROWS_FLEET_LIMIT)
    }
  })
})

describe('nothing is retained', () => {
  it('reaches the store again for a repeated read — this is not a cache', async () => {
    const { rows, calls } = await fleet()
    await rows.get(101)
    await rows.get(101)
    expect(calls).toEqual([
      { op: 'get', key: '101' },
      { op: 'get', key: '101' },
    ])
  })

  it('declares the collection once, however many callers race the first use', async () => {
    const store = await makeSettingsStoreApi()
    let declarations = 0
    const inner = deviceRowBackendOf(store.api)
    const backend: DeviceRowBackend = {
      ...inner,
      declareCollection: (input) => {
        declarations += 1
        return inner.declareCollection(input)
      },
    }
    const rows = new DeviceRowStore(backend, makeLogger())

    await Promise.all([rows.get(1), rows.get(2), rows.listAll(), rows.count()])

    expect(declarations).toBe(1)
  })
})

describe('the write lock still serialises', () => {
  it('does not let a read leak across a read-modify-write', async () => {
    const { rows } = await fleet()
    const s = countingSettings({})
    const metaStore = new DeviceMetaStore(s.settings, null, rows)
    const order: string[] = []

    const a = metaStore.withMetaWriteLock(async () => {
      order.push('a:start')
      await metaStore.resolvePersistedById(101)
      order.push('a:end')
    })
    const b = metaStore.withMetaWriteLock(async () => {
      order.push('b:start')
      await metaStore.resolvePersistedById(101)
      order.push('b:end')
    })
    await Promise.all([a, b])

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })
})

describe('a write that lands on nothing says so', () => {
  it('warns, tagged with the deviceId, when a patch matches no row', async () => {
    const { rows, logger } = await fleet()

    await rows.patch(4242, { name: 'ghost' })

    expect(logger.warn).toHaveBeenCalledWith(
      'device row patch matched no row — the device was removed under it',
      expect.objectContaining({ tags: { deviceId: 4242 } }),
    )
  })

  it('stays silent when the patch does land', async () => {
    const { rows, logger } = await fleet()
    await rows.patch(101, { name: 'renamed' })
    expect(logger.warn).not.toHaveBeenCalled()
    expect((await rows.get(101))?.meta.name).toBe('renamed')
  })
})

describe('a row missing its identity is skipped, loudly', () => {
  it('warns with the deviceId rather than projecting a nameless device', async () => {
    const store = await makeSettingsStoreApi()
    const rows = new DeviceRowStore(deviceRowBackendOf(store.api), makeLogger())
    await rows.upsert(meta(101, 'provider-hikvision', 'cam-1'), { registered: true })

    // `name` is NOT NULL, so a nameless row cannot be written through the
    // store — reach past it to produce the shape a hand-edit or a partial
    // restore leaves behind.
    const logger = makeLogger()
    const broken = new DeviceRowStore(
      {
        ...deviceRowBackendOf(store.api),
        get: async () => ({ deviceId: 101, addonId: 'x', stableId: 'y', type: 'camera' }),
      },
      logger,
    )

    expect(await broken.get(101)).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      'device row skipped — identity fields missing',
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })
})
