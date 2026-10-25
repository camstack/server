import { createRecordsAccess } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { KeychainAddon } from '../keychain.addon.js'

describe('KeychainAddon — records path', () => {
  it('does not call declareCollection for audit or resets on hub boot', async () => {
    const declared = new Set<string>()
    const door = {
      declareCollection: async (input: { collection: string }) => {
        declared.add(input.collection)
      },
      get: async () => null,
      set: async () => {},
      query: async () => [],
      delete: async () => {},
      deleteWhere: async () => ({ deleted: 0 }),
    }
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'keychain',
      transport: world.transportFor('keychain'),
      secrets: null,
    })
    const addon = new KeychainAddon()
    await addon.initialize({
      api: { settingsStore: door },
      records,
      nodeDataDir: '/tmp/keychain-test',
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () =>
          ({
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
            child: () => ({}) as never,
            withTags: () => ({}) as never,
          }) as never,
        withTags: () =>
          ({
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
            child: () => ({}) as never,
            withTags: () => ({}) as never,
          }) as never,
      },
      addonConfig: {},
      kernel: { runnerIdForAddon: (id: string) => id },
      settings: {
        getSection: async () => ({}),
        readAddonStore: async () => ({}),
        writeAddonStore: async () => {},
        readDeviceStore: async () => ({}),
        writeDeviceStore: async () => {},
        setSection: async () => {},
      },
      eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
      id: 'keychain',
      dataDir: '/tmp',
    } as never)
    expect(declared.has('keychain:audit')).toBe(false)
    expect(declared.has('keychain:resets')).toBe(false)
    await addon.shutdown()
  })
})
