/**
 * Swapping two device ids — the primitive a camera replacement is built on.
 *
 * ## What the swap is FOR
 *
 * Everything general about a camera is keyed on the numeric id and on nothing
 * else: the recording path on disk is `<deviceId>/profile/…`, and the hour
 * ledger, the media store and zone ownership carry `deviceId` without one
 * `stableId` between them. All four ecosystem exports key on it too. So a
 * replacement moves the NUMBER onto the new hardware instead of moving the
 * work off it — the difference between two rows and a data migration that
 * breaks every external integration.
 *
 * ## What is asserted, and what deliberately is not
 *
 * The rows, the children, and the ABSENCE of the temp id. Not the order of the
 * writes: there are no transactions under this store, so the order exists to
 * make a crash loud rather than to be observable in the happy path, and a test
 * that pinned the sequence would fail on any future reordering that is equally
 * safe.
 *
 * The child assertions are the half that a naive implementation gets wrong: a
 * swap that moves only the two parents leaves the old accessory hanging off the
 * new camera, which reads as correct in a device list and is not.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { DeviceRowStore, deviceRowBackendOf } from '../device-row-store.js'
import { MigrationRefusedError } from '../migration-refused.js'
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

/** The shape of tomorrow's real case: two cameras, each with one accessory. */
const FIXTURE: readonly {
  readonly id: number
  readonly parentDeviceId: number | null
  readonly addonId: string
  readonly name: string
}[] = [
  { id: 3836, parentDeviceId: null, addonId: 'provider-reolink', name: 'Studio (broken)' },
  { id: 3876, parentDeviceId: 3836, addonId: 'provider-reolink', name: 'Studio Siren' },
  { id: 4300, parentDeviceId: null, addonId: 'provider-onvif', name: 'Studio (new)' },
  { id: 4301, parentDeviceId: 4300, addonId: 'provider-onvif', name: 'New Siren' },
  { id: 900, parentDeviceId: null, addonId: 'provider-reolink', name: 'Untouched' },
]

const TEMP_ID = 99_001

async function makeStore(): Promise<DeviceRowStore> {
  const api = await makeSettingsStoreApi()
  const store = new DeviceRowStore(deviceRowBackendOf(api.api), makeLogger())
  for (const f of FIXTURE) {
    await store.upsert(
      {
        id: f.id,
        addonId: f.addonId,
        stableId: `s-${f.id}`,
        type: 'camera',
        name: f.name,
        location: null,
        disabled: false,
        parentDeviceId: f.parentDeviceId,
      },
      { registered: true },
    )
  }
  return store
}

describe('DeviceRowStore.swapIds — the number moves, the work does not', () => {
  it('the new hardware answers on the old number, and the reverse', async () => {
    const store = await makeStore()

    await store.swapIds(3836, 4300, TEMP_ID)

    // 3836 is the number the recordings, the ledger and all four exports know.
    expect((await store.get(3836))?.meta.name).toBe('Studio (new)')
    expect((await store.get(3836))?.meta.addonId).toBe('provider-onvif')
    expect((await store.get(4300))?.meta.name).toBe('Studio (broken)')
  })

  it('leaves no row parked on the temp id', async () => {
    const store = await makeStore()

    await store.swapIds(3836, 4300, TEMP_ID)

    expect(await store.get(TEMP_ID)).toBeNull()
  })

  it('re-points the children, so no accessory hangs off the wrong camera', async () => {
    const store = await makeStore()

    await store.swapIds(3836, 4300, TEMP_ID)

    // The OLD siren followed its own camera to 4300; the NEW one is on 3836.
    expect((await store.get(3876))?.meta.parentDeviceId).toBe(4300)
    expect((await store.get(4301))?.meta.parentDeviceId).toBe(3836)
    const under3836 = await store.listByParent(3836)
    expect(under3836.map((r) => r.meta.id)).toEqual([4301])
  })

  it('keeps the children on their OWN ids — their work is not being inherited', async () => {
    const store = await makeStore()

    await store.swapIds(3836, 4300, TEMP_ID)

    expect((await store.get(3876))?.meta.name).toBe('Studio Siren')
    expect((await store.get(4301))?.meta.name).toBe('New Siren')
  })

  it('touches nothing else', async () => {
    const store = await makeStore()

    await store.swapIds(3836, 4300, TEMP_ID)

    const other = await store.get(900)
    expect(other?.meta.name).toBe('Untouched')
    expect(other?.meta.parentDeviceId).toBeNull()
  })

  it('refuses a device that is not there rather than half-moving the other', async () => {
    const store = await makeStore()

    await expect(store.swapIds(3836, 4999, TEMP_ID)).rejects.toThrow(/4999 does not exist/)

    expect((await store.get(3836))?.meta.name).toBe('Studio (broken)')
    expect(await store.get(TEMP_ID)).toBeNull()
  })

  it('refuses a temp id that is taken — it would overwrite a device', async () => {
    const store = await makeStore()

    await expect(store.swapIds(3836, 4300, 900)).rejects.toThrow(/temp id 900 is taken/)

    expect((await store.get(900))?.meta.name).toBe('Untouched')
  })

  it('refuses to swap a device with itself', async () => {
    const store = await makeStore()

    await expect(store.swapIds(3836, 3836, TEMP_ID)).rejects.toThrow(/same device/)
  })

  /**
   * The migration restores both cameras' switches on a refusal that moved
   * nothing, and leaves them off on anything that may have moved rows (D663
   * 5b ruling I-1). So the TYPE of each failure is the contract.
   */
  it('every precheck refusal is a MigrationRefusedError — nothing moved', async () => {
    const store = await makeStore()

    for (const [a, b, temp] of [
      [3836, 4999, TEMP_ID],
      [3836, 4300, 900],
      [3836, 3836, TEMP_ID],
    ] as const) {
      await expect(store.swapIds(a, b, temp)).rejects.toBeInstanceOf(MigrationRefusedError)
    }
  })

  it('a READ that fails before the first write is a refusal too, and moves nothing', async () => {
    const store = await makeStore()
    const realGet = store.get.bind(store)
    const get = vi.spyOn(store, 'get').mockRejectedValueOnce(new Error('sqlite busy'))

    const err = await store.swapIds(3836, 4300, TEMP_ID).catch((e: unknown) => e)
    get.mockRestore()

    expect(err).toBeInstanceOf(MigrationRefusedError)
    expect(String(err)).toMatch(/precheck failed before any row moved — sqlite busy/)
    expect((await realGet(3836))?.meta.name).toBe('Studio (broken)')
  })

  it('a WRITE that fails is NOT a refusal — rows may have moved', async () => {
    const store = await makeStore()
    const upsert = vi.spyOn(store, 'upsert').mockRejectedValueOnce(new Error('disk I/O error'))

    const err = await store.swapIds(3836, 4300, TEMP_ID).catch((e: unknown) => e)
    upsert.mockRestore()

    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(MigrationRefusedError)
  })
})
