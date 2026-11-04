import { defaultIntegrationMigrations } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { hikvisionConnectionsEntryKind, hikvisionRecordKinds } from '../hikvision-instances.js'

/**
 * Hikvision integrations are name-only `connections` records (D1007): the kind accepts a name and
 * nothing else the devices own, and the S-A migration catalogue binds for this addon.
 */
describe('hikvision integration instances', () => {
  it('the connections kind is declared and takes a name only', () => {
    expect(Object.keys(hikvisionRecordKinds)).toEqual(['connections'])
    expect(hikvisionConnectionsEntryKind.schema.safeParse({ name: 'Default' }).success).toBe(true)
    expect(hikvisionConnectionsEntryKind.schema.safeParse({}).success).toBe(false)
  })

  it('the migration pair binds under the addon id: rows first, then the claim', () => {
    const catalogue = defaultIntegrationMigrations({
      addonId: 'provider-hikvision',
      date: '2026-11-04',
    })
    expect(catalogue.map((m) => m.meta.id)).toEqual([
      'provider-hikvision/2026-11-04-integration-rows-to-record',
      'provider-hikvision/2026-11-04-claim-devices-to-default-integration',
    ])
    expect(catalogue.map((m) => m.meta.onFailure)).toEqual(['block-owner', 'tolerate'])
    expect(catalogue.every((m) => m.meta.bodyKind === 'procedure' && 'procedure' in m)).toBe(true)
  })
})
