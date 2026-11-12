import { describe, expect, it } from 'vitest'
import { EXPORT_NAME_REFUSED, ExportNameRefusedError } from '../capabilities/device-export.cap.js'
import {
  EXPOSED_NAMES_STORE_KEY,
  type ExposedNameStore,
  freeTextNameValidator,
  type PrunableDeviceStore,
  pruneExposedNames,
  readExposedName,
  saveExposedName,
} from '../device/export-name.js'

const anyName = freeTextNameValidator('Test', 10)

function memoryStore(initial: Record<string, unknown> = {}): {
  store: ExposedNameStore
  blob: () => Record<string, unknown>
  writes: () => number
} {
  let blob: Record<string, unknown> = { ...initial }
  let writes = 0
  return {
    store: {
      read: async () => blob,
      write: async (_deviceId, patch) => {
        writes += 1
        blob = { ...blob, ...patch }
      },
    },
    blob: () => blob,
    writes: () => writes,
  }
}

describe('exposed name (D1049)', () => {
  it('saves one instance name and keeps the other instances', async () => {
    const mem = memoryStore({
      [EXPOSED_NAMES_STORE_KEY]: { other: 'Kept' },
      unrelated: 1,
    })
    const out = await saveExposedName({
      store: mem.store,
      deviceId: 7,
      instanceId: 'a',
      raw: '  Porch   cam ',
      validate: anyName,
    })
    expect(out).toEqual({ changed: true, name: 'Porch cam' })
    expect(mem.blob()[EXPOSED_NAMES_STORE_KEY]).toEqual({
      other: 'Kept',
      a: 'Porch cam',
    })
    expect(mem.blob()['unrelated']).toBe(1)
  })

  it('blank clears the instance name, and an unchanged name writes nothing', async () => {
    const mem = memoryStore({
      [EXPOSED_NAMES_STORE_KEY]: { a: 'Porch', b: 'Gate' },
    })
    await saveExposedName({
      store: mem.store,
      deviceId: 7,
      instanceId: 'a',
      raw: ' ',
      validate: anyName,
    })
    expect(mem.blob()[EXPOSED_NAMES_STORE_KEY]).toEqual({ b: 'Gate' })
    const again = await saveExposedName({
      store: mem.store,
      deviceId: 7,
      instanceId: 'b',
      raw: 'Gate',
      validate: anyName,
    })
    expect(again.changed).toBe(false)
    expect(mem.writes()).toBe(1)
  })

  it('a name the platform refuses throws the typed refusal and writes nothing', async () => {
    const mem = memoryStore({ [EXPOSED_NAMES_STORE_KEY]: { a: 'Porch' } })
    const err = await saveExposedName({
      store: mem.store,
      deviceId: 7,
      instanceId: 'a',
      raw: 'Far too long a name',
      validate: anyName,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ExportNameRefusedError)
    expect(err instanceof Error ? err.message : '').toMatch(new RegExp(`^${EXPORT_NAME_REFUSED}: `))
    expect(mem.writes()).toBe(0)
    expect(readExposedName(mem.blob(), 'a', anyName)).toBe('Porch')
  })

  it('a stored name the platform now refuses reads as no name', () => {
    expect(
      readExposedName({ [EXPOSED_NAMES_STORE_KEY]: { a: 'x'.repeat(20) } }, 'a', anyName),
    ).toBeNull()
    expect(readExposedName({ [EXPOSED_NAMES_STORE_KEY]: 'garbage' }, 'a', anyName)).toBeNull()
  })

  it('a dry run refuses like a save and writes nothing, even for a valid name', async () => {
    const mem = memoryStore()
    const ok = await saveExposedName({
      store: mem.store,
      deviceId: 7,
      instanceId: 'a',
      raw: 'Gate',
      validate: anyName,
      dryRun: true,
    })
    expect(ok).toEqual({ changed: false, name: 'Gate' })
    await expect(
      saveExposedName({
        store: mem.store,
        deviceId: 7,
        instanceId: 'a',
        raw: 'x'.repeat(20),
        validate: anyName,
        dryRun: true,
      }),
    ).rejects.toBeInstanceOf(ExportNameRefusedError)
    expect(mem.writes()).toBe(0)
  })
})

describe('pruning a deleted instance (D1049)', () => {
  function fleet(blobs: Record<number, Record<string, unknown>>) {
    const rows = new Map<number, Record<string, unknown>>(
      Object.entries(blobs).map(([id, blob]) => [Number(id), { ...blob }]),
    )
    const settings: PrunableDeviceStore = {
      listDeviceStoreIds: async () => [...rows.keys()],
      readDeviceStoreBatch: async (ids) =>
        new Map(ids.flatMap((id) => (rows.has(id) ? [[id, rows.get(id) ?? {}] as const] : []))),
      readDeviceStore: async (id) => rows.get(id) ?? {},
      writeDeviceStore: async (id, patch) => {
        rows.set(id, { ...rows.get(id), ...patch })
      },
    }
    return { settings, rows }
  }

  it('removes only the deleted instance name, on every device that had one', async () => {
    const { settings, rows } = fleet({
      1: { [EXPOSED_NAMES_STORE_KEY]: { gone: 'Old', kept: 'Stays' }, other: 1 },
      2: { [EXPOSED_NAMES_STORE_KEY]: { gone: 'Old 2' } },
      3: { [EXPOSED_NAMES_STORE_KEY]: { kept: 'Untouched' } },
    })
    expect(await pruneExposedNames(settings, 'gone')).toEqual([1, 2])
    expect(rows.get(1)).toEqual({ [EXPOSED_NAMES_STORE_KEY]: { kept: 'Stays' }, other: 1 })
    expect(rows.get(2)).toEqual({ [EXPOSED_NAMES_STORE_KEY]: {} })
    expect(rows.get(3)).toEqual({ [EXPOSED_NAMES_STORE_KEY]: { kept: 'Untouched' } })
  })
})
