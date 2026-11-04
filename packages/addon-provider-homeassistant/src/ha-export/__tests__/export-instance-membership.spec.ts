/**
 * A `device-export` write changes ONE broker's membership - the named instance - and a
 * broker the addon does not know is refused by name.
 *
 * Disarm: make `setBrokerMembership` write every enabled broker (the old "everywhere" path) -
 * "writes only the named broker" fails; drop the `brokerScope` check - "unknown broker" fails.
 */
import { ExportInstanceUnknownError, type IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { HaExportAddon } from '../ha-export.addon.js'
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
  readonly persisted: ExportMembership[]
  readonly reconciles: string[]
}

function harness(membership: ExportMembership): Harness {
  const addon = new HaExportAddon()
  const persisted: ExportMembership[] = []
  const reconciles: string[] = []
  Reflect.set(addon, '_ctx', { logger: silent })
  Reflect.set(addon, '_config', {
    membership,
    knownBrokers: [
      { id: 'ha_001', name: 'Home' },
      { id: 'ha_002', name: 'Cabin' },
    ],
  })
  Reflect.set(addon, 'enabled', ['ha_001', 'ha_002'])
  Reflect.set(addon, 'updateGlobalSettings', async (patch: { membership: ExportMembership }) => {
    persisted.push(patch.membership)
    Reflect.set(addon, '_config', {
      membership: patch.membership,
      knownBrokers: [
        { id: 'ha_001', name: 'Home' },
        { id: 'ha_002', name: 'Cabin' },
      ],
    })
  })
  Reflect.set(addon, 'reconcile', async (reason: string) => {
    reconciles.push(reason)
  })
  const write: unknown = Reflect.get(addon, 'setBrokerMembership')
  const scope: unknown = Reflect.get(addon, 'brokerScope')
  if (typeof write !== 'function' || typeof scope !== 'function') throw new Error('no seam')
  return {
    write: (instanceId, deviceId, exposed) => write.call(addon, instanceId, deviceId, exposed),
    scope: (instanceId) => scope.call(addon, instanceId),
    persisted,
    reconciles,
  }
}

describe('a device-export write targets one broker', () => {
  it('writes only the named broker; the other broker is unchanged', async () => {
    const h = harness({ ha_001: ['10'], ha_002: ['20'] })
    await h.write('ha_001', '11', true)
    expect(h.persisted).toHaveLength(1)
    expect(h.persisted[0]?.['ha_001']).toEqual(expect.arrayContaining(['10', '11']))
    expect(h.persisted[0]?.['ha_002']).toEqual(['20'])
    expect(h.reconciles).toEqual(['expose'])
  })

  it('unexposes from the named broker only', async () => {
    const h = harness({ ha_001: ['10'], ha_002: ['10'] })
    await h.write('ha_002', '10', false)
    expect(h.persisted[0]?.['ha_001']).toEqual(['10'])
    expect(h.persisted[0]?.['ha_002'] ?? []).toEqual([])
  })

  it('refuses a broker it does not know, writing nothing', async () => {
    const h = harness({ ha_001: ['10'] })
    await expect(h.write('ha_999', '11', true)).rejects.toBeInstanceOf(ExportInstanceUnknownError)
    expect(h.persisted).toHaveLength(0)
  })
})

describe('a device-export read scope', () => {
  it('is every enabled broker when absent, the named one when present, a refusal when unknown', () => {
    const h = harness({})
    expect(h.scope(undefined)).toEqual(['ha_001', 'ha_002'])
    expect(h.scope('ha_002')).toEqual(['ha_002'])
    expect(() => h.scope('ha_999')).toThrow(ExportInstanceUnknownError)
  })
})
