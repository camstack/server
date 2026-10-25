import { createRecordsAccess } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import CalendarsAddon from '../calendars.addon.js'

describe('CalendarsAddon — records path', () => {
  it('does not call declareCollection for calendars:user-prefs on hub boot', async () => {
    const declared = new Set<string>()
    const backend = {
      declareCollection: {
        mutate: async (input: { collection: string }) => declared.add(input.collection),
      },
      get: { query: async () => null },
      set: { mutate: async () => {} },
      query: { query: async () => [] },
    }
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'calendars',
      transport: world.transportFor('calendars'),
      secrets: null,
    })
    const addon = new CalendarsAddon()
    await addon.initialize({
      api: { settingsStore: backend },
      records,
      capabilities: { listProviders: () => [] },
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
      kernel: {},
      settings: {
        readAddonStore: async () => ({}),
        writeAddonStore: async () => {},
        readDeviceStore: async () => ({}),
        writeDeviceStore: async () => {},
        setSection: async () => {},
      },
      id: 'calendars',
      dataDir: '/tmp',
    } as never)
    expect(declared.has('calendars:user-prefs')).toBe(false)
  })
})
