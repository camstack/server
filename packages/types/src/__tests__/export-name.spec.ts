import { describe, expect, it } from 'vitest'
import { EXPORT_NAME_REFUSED, ExportNameRefusedError } from '../capabilities/device-export.cap.js'
import {
  EXPOSED_NAMES_STORE_KEY,
  type ExposedNameStore,
  freeTextNameValidator,
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
})
