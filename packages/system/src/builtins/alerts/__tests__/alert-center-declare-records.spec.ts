/**
 * Hub boot must not re-declare the legacy `alerts` KV collection once the kind
 * is on `ctx.records` (phase 4).
 */
import { createRecordsAccess } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { AlertCenterAddon } from '../alerts.addon.js'

class Probe extends AlertCenterAddon {
  caps(): readonly string[] {
    return this.scopedSettingsCapabilities()
  }
}

const quietLogger = () => {
  const leaf = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ({}) as never,
    withTags: () => ({}) as never,
  }
  return { ...leaf, child: () => leaf, withTags: () => leaf }
}

function makeBackend(declared: Set<string>) {
  return {
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
}

async function makeContext(declared: Set<string>, withRecords: boolean) {
  let records: ReturnType<typeof createRecordsAccess> | undefined
  if (withRecords) {
    const world = makeRecordsWorld()
    await world.provider.init()
    records = createRecordsAccess({
      owner: 'alert-center',
      transport: world.transportFor('alert-center'),
      secrets: null,
    })
  }
  return {
    api: { settingsStore: makeBackend(declared) },
    ...(records !== undefined ? { records } : {}),
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
    logger: quietLogger(),
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
  }
}

describe('AlertCenterAddon — records path', () => {
  it('does not call declareCollection for legacy alerts on hub boot', async () => {
    const declared = new Set<string>()
    const addon = new AlertCenterAddon()
    await addon.initialize((await makeContext(declared, true)) as never)
    expect(declared.has('alerts')).toBe(false)
  })

  it('hosts the jobs ledger, and names its settings, only with a records engine', async () => {
    const withRecords = new Probe()
    await withRecords.initialize((await makeContext(new Set(), true)) as never)
    expect(withRecords.caps()).toEqual(['alerts', 'jobs'])

    const without = new Probe()
    await without.initialize((await makeContext(new Set(), false)) as never)
    expect(without.caps()).toEqual(['alerts'])
  })
})
