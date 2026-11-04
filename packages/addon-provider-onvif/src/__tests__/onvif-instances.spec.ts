import { defaultIntegrationMigrations } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ADDON_MIGRATIONS } from '../migrations/index.js'
import { onvifConnectionsEntryKind, onvifRecordKinds } from '../onvif-instances.js'

/**
 * ONVIF integrations are name-only `connections` records (D1007): the kind accepts a name and
 * nothing else the cameras own, and the whole migration catalogue binds for this addon.
 */
describe('onvif integration instances', () => {
  it('the connections kind is declared and takes a name only', () => {
    expect(Object.keys(onvifRecordKinds)).toEqual(['connections'])
    expect(onvifConnectionsEntryKind.schema.safeParse({ name: 'Default' }).success).toBe(true)
    expect(onvifConnectionsEntryKind.schema.safeParse({}).success).toBe(false)
  })

  it('the default pair follows the two earlier migrations: rows at seq 3, the claim at seq 4', () => {
    const pair = defaultIntegrationMigrations({
      addonId: 'provider-onvif',
      date: '2026-11-05',
      seq: 3,
    })
    expect(pair.map((m) => m.meta.id)).toEqual([
      'provider-onvif/2026-11-05-integration-rows-to-record',
      'provider-onvif/2026-11-05-claim-devices-to-default-integration',
    ])
    expect(pair.map((m) => m.meta.onFailure)).toEqual(['block-owner', 'tolerate'])
    const whole = [...ADDON_MIGRATIONS, ...pair].map((m) => m.meta.seq)
    expect(whole).toEqual([1, 2, 3, 4])
  })
})
