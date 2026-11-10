import { describe, expect, it } from 'vitest'
import { osdMigrationPortsOver, type OsdMigrationApi } from '../ports.js'

function stubApi(logged: unknown[]): OsdMigrationApi {
  return {
    settings: {
      read: async () => ({ store: { a: 1, b: 2, c: 3 } }),
      write: async () => ({}),
      deleteKeys: async () => ({ removed: [] }),
    },
    deviceSettings: {
      listIds: async () => ({ deviceIds: [4, 7] }),
      read: async () => ({ blobs: { '4': { f: 'x', g: 1 }, '7': { g: 2 } } }),
    },
    devices: {
      list: async () => ({ devices: [] }),
      get: async () => null,
      aliases: async () => ({ aliases: { '4': 'porch' } }),
      setIntegrationId: async () => ({}),
    },
    log: {
      info: async () => ({}),
      warn: async (line) => {
        logged.push(line)
        return {}
      },
    },
  }
}

describe('osdMigrationPortsOver', () => {
  it('picks only the asked keys, keys devices by number and tags device lines', async () => {
    const logged: unknown[] = []
    const ports = osdMigrationPortsOver(stubApi(logged))
    expect(await ports.readStored(['a', 'c', 'z'])).toEqual({ a: 1, c: 3 })
    expect(await ports.listDeviceIds()).toEqual([4, 7])
    expect([...(await ports.readDeviceField([4, 7], 'f'))]).toEqual([[4, 'x']])
    expect([...(await ports.readAliases([4]))]).toEqual([[4, 'porch']])
    ports.note('hello', 4)
    expect(logged).toEqual([{ message: 'osd-manager: migration - hello', tags: { deviceId: 4 } }])
  })
})
