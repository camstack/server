import { defaultIntegrationMigrations } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { greeConnectionsEntryKind, greeRecordKinds } from '../gree-instances.js'

/**
 * Gree integrations are name-only `connections` records (D1007): the kind accepts a name and
 * nothing else the AC devices own, and the S-A migration catalogue binds for this addon.
 */
describe('gree integration instances', () => {
  it('the connections kind is declared and takes a name only', () => {
    expect(Object.keys(greeRecordKinds)).toEqual(['connections'])
    expect(greeConnectionsEntryKind.schema.safeParse({ name: 'Default' }).success).toBe(true)
    expect(greeConnectionsEntryKind.schema.safeParse({}).success).toBe(false)
  })

  it('the migration pair binds under the addon id: rows first, then the claim', () => {
    const catalogue = defaultIntegrationMigrations({ addonId: 'provider-gree', date: '2026-11-04' })
    expect(catalogue.map((m) => m.meta.id)).toEqual([
      'provider-gree/2026-11-04-integration-rows-to-record',
      'provider-gree/2026-11-04-claim-devices-to-default-integration',
    ])
    expect(catalogue.map((m) => m.meta.onFailure)).toEqual(['block-owner', 'tolerate'])
    expect(catalogue.every((m) => m.meta.bodyKind === 'procedure' && 'procedure' in m)).toBe(true)
  })
})
