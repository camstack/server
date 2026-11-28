/**
 * A migrated row keeps the NAMES its tags had beside `tagIds` for one release (D1089). Clearing
 * the tags writes `tagIds: []`, and every later full-row write (a swap, a re-registration) must
 * keep that `[]`: a `null` would let the kept names read back as tags the operator removed.
 */
import type { IScopedLogger } from '@dominevo/types'
import { describe, expect, it, vi } from 'vitest'
import {
  DEVICE_ROWS_COLLECTION,
  type DeviceRowBackend,
  DeviceRowStore,
  decodeDeviceRow,
  deviceRowBackendOf,
  encodeDeviceRow,
} from '../device-row-store.js'
import { makeSettingsStoreApi } from './settings-store-api.js'

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

const meta = (id: number) => ({
  id,
  addonId: 'provider-x',
  stableId: `s-${id}`,
  type: 'camera',
  name: `Cam ${id}`,
  location: null,
  disabled: false,
  parentDeviceId: null,
})

async function migratedStore(): Promise<{ store: DeviceRowStore; backend: DeviceRowBackend }> {
  const api = await makeSettingsStoreApi()
  const backend = deviceRowBackendOf(api.api)
  const store = new DeviceRowStore(backend, makeLogger())
  store.setDerivedNames({ room: () => null, tag: (id) => (id === 't-keep' ? 'Keep' : null) })
  for (const id of [1, 2]) await store.upsert(meta(id), { registered: true })
  for (const id of [1, 2]) {
    const raw = await backend.get({ collection: DEVICE_ROWS_COLLECTION, key: String(id) })
    if (typeof raw !== 'object' || raw === null) throw new Error('fixture')
    // The shape a migrated row has: ids beside the kept names.
    await backend.set({
      collection: DEVICE_ROWS_COLLECTION,
      key: String(id),
      value: { ...raw, tags: ['Old name'], tagIds: ['t-keep'] },
    })
  }
  return { store, backend }
}

describe('a cleared tag list stays cleared (D1089)', () => {
  it('encodes an empty tagIds as [], and only an unset one as null', () => {
    expect(encodeDeviceRow({ ...meta(1), tagIds: [] })['tagIds']).toEqual([])
    expect(encodeDeviceRow(meta(1))['tagIds']).toBeNull()
  })

  it('decodes a stored [] back to [] so a rewrite can keep it', () => {
    const row = decodeDeviceRow({ ...encodeDeviceRow({ ...meta(1), tagIds: [] }), tags: ['Old'] })
    expect(row?.meta.tagIds).toEqual([])
    expect(row?.meta.tags ?? []).toEqual([])
  })

  it('the kept names do not come back after the tags are cleared and the ids are swapped', async () => {
    const { store } = await migratedStore()
    expect((await store.get(1))?.meta.tags).toEqual(['Keep'])

    await store.patch(1, { tagIds: [] })
    expect((await store.get(1))?.meta.tags ?? []).toEqual([])

    await store.swapIds(1, 2, 99)
    // The cleared row now answers on 2; the untouched one on 1 still has its tag.
    expect((await store.get(2))?.meta.tags ?? []).toEqual([])
    expect((await store.get(1))?.meta.tags).toEqual(['Keep'])
  })
})
