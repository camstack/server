/**
 * A `device-export` write changes ONE broker's membership - the named instance - and a
 * broker the addon does not know is refused by name.
 *
 * Disarm: make `setBrokerMembership` write every enabled broker (the old "everywhere" path) -
 * "writes only the named broker" fails; drop the `brokerScope` check - "unknown broker" fails.
 */
import {
  ExportInstanceUnknownError,
  type IScopedLogger,
  makeInMemoryRecords,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { HaExportAddon } from '../ha-export.addon.js'
import { defaultLinks, ExportLinks, haExportLinksKind } from '../link-records.js'
import type { ExportMembership } from '../membership.js'

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

interface Harness {
  readonly write: (instanceId: string, deviceId: string, exposed: boolean) => Promise<void>
  readonly scope: (instanceId: string | undefined) => readonly string[]
  /** What the records hold now, by broker. */
  readonly stored: () => Promise<Record<string, readonly string[]>>
  readonly reconciles: string[]
}

const BROKERS = [
  { id: 'ha_001', name: 'Home' },
  { id: 'ha_002', name: 'Cabin' },
]

async function harness(membership: ExportMembership): Promise<Harness> {
  const addon = new HaExportAddon()
  const reconciles: string[] = []
  const memory = makeInMemoryRecords('homeassistant-export')
  await memory.records.declare({ 'ha-export-links': haExportLinksKind })
  const handle = memory.records.kind(haExportLinksKind)
  for (const [id, devices] of Object.entries(membership)) {
    await handle.put({ id, data: { ...defaultLinks(id), devices } })
  }
  Reflect.set(addon, '_ctx', { logger: silent })
  Reflect.set(addon, '_config', { knownBrokers: BROKERS })
  Reflect.set(addon, 'enabled', ['ha_001', 'ha_002'])
  Reflect.set(addon, 'linkBook', await ExportLinks.load(handle))
  Reflect.set(addon, 'reconcile', async (reason: string) => {
    reconciles.push(reason)
  })
  const write: unknown = Reflect.get(addon, 'setBrokerMembership')
  const scope: unknown = Reflect.get(addon, 'brokerScope')
  if (typeof write !== 'function' || typeof scope !== 'function') throw new Error('no seam')
  return {
    write: (instanceId, deviceId, exposed) => write.call(addon, instanceId, deviceId, exposed),
    scope: (instanceId) => scope.call(addon, instanceId),
    stored: async () => {
      const page = await handle.query({ limit: 100 })
      return Object.fromEntries(page.records.map((row) => [row.id, row.data.devices]))
    },
    reconciles,
  }
}

describe('a device-export write targets one broker', () => {
  it('writes only the named broker; the other broker is unchanged', async () => {
    const h = await harness({ ha_001: ['10'], ha_002: ['20'] })
    await h.write('ha_001', '11', true)
    const stored = await h.stored()
    expect(stored['ha_001']).toEqual(['10', '11'])
    expect(stored['ha_002']).toEqual(['20'])
    expect(h.reconciles).toEqual(['expose'])
  })

  it('unexposes from the named broker only', async () => {
    const h = await harness({ ha_001: ['10'], ha_002: ['10'] })
    await h.write('ha_002', '10', false)
    const stored = await h.stored()
    expect(stored['ha_001']).toEqual(['10'])
    expect(stored['ha_002'] ?? []).toEqual([])
  })

  it('creates the record of a broker that has none yet', async () => {
    const h = await harness({})
    await h.write('ha_002', '10', true)
    expect(await h.stored()).toEqual({ ha_002: ['10'] })
  })

  it('refuses a broker it does not know, writing nothing', async () => {
    const h = await harness({ ha_001: ['10'] })
    await expect(h.write('ha_999', '11', true)).rejects.toBeInstanceOf(ExportInstanceUnknownError)
    expect(await h.stored()).toEqual({ ha_001: ['10'] })
  })
})

describe('a device-export read scope', () => {
  it('is every enabled broker when absent, the named one when present, a refusal when unknown', async () => {
    const h = await harness({})
    expect(h.scope(undefined)).toEqual(['ha_001', 'ha_002'])
    expect(h.scope('ha_002')).toEqual(['ha_002'])
    expect(() => h.scope('ha_999')).toThrow(ExportInstanceUnknownError)
  })
})
