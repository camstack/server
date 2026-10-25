/**
 * Hub boot must not re-declare the legacy `alerts` KV collection once the kind
 * is on `ctx.records` (phase 4).
 */
import { createRecordsAccess } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { AlertCenterAddon } from '../alerts.addon.js'

describe('AlertCenterAddon — records path', () => {
  it('does not call declareCollection for legacy alerts on hub boot', async () => {
    const declared = new Set<string>()
    const backend = {
      declareCollection: {
        mutate: async (input: { collection: string }) => declared.add(input.collection),
      },
      get: { query: async () => null },
      set: { mutate: async () => {} },
      query: { query: async () => [] },
      count: { query: async () => 0 },
      delete: { mutate: async () => {} },
      deleteWhere: { mutate: async () => ({ deleted: 0 }) },
    }
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'alert-center',
      transport: world.transportFor('alert-center'),
      secrets: null,
    })
    const addon = new AlertCenterAddon()
    await addon.initialize({
      api: { settingsStore: backend },
      records,
      eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => ({
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
          child: () => ({}) as never,
          withTags: () => ({}) as never,
        }),
        withTags: () => ({
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
          child: () => ({}) as never,
          withTags: () => ({}) as never,
        }),
      },
      addonConfig: {},
      kernel: {},
      settings: {
        readAddonStore: async () => ({}),
        writeAddonStore: async () => {},
        readDeviceStore: async () => ({}),
        writeDeviceStore: async () => {},
        setSection: async () => {},
      },
      id: 'alert-center',
      dataDir: '/tmp',
    } as never)
    expect(declared.has('alerts')).toBe(false)
  })
})
