import { defaultIntegrationMigrations, makeInMemoryRecords } from '@camstack/types'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildRtspInstances, rtspConnectionsEntryKind, rtspRecordKinds } from '../rtsp-instances.js'

/**
 * Rtsp integrations are name-only `connections` records (D1007): the kind accepts a name and
 * nothing else the devices own, and the S-A migration catalogue binds for this addon.
 */
describe('rtsp integration instances', () => {
  it('the connections kind is declared and takes a name only', () => {
    expect(Object.keys(rtspRecordKinds)).toEqual(['connections'])
    expect(rtspConnectionsEntryKind.schema.safeParse({ name: 'Default' }).success).toBe(true)
    expect(rtspConnectionsEntryKind.schema.safeParse({}).success).toBe(false)
  })

  it('the migration pair binds under the addon id: rows first, then the claim', () => {
    const catalogue = defaultIntegrationMigrations({
      addonId: 'provider-rtsp',
      date: '2026-11-04',
    })
    expect(catalogue.map((m) => m.meta.id)).toEqual([
      'provider-rtsp/2026-11-04-integration-rows-to-record',
      'provider-rtsp/2026-11-04-claim-devices-to-default-integration',
    ])
    expect(catalogue.map((m) => m.meta.onFailure)).toEqual(['block-owner', 'tolerate'])
    expect(catalogue.every((m) => m.meta.bodyKind === 'procedure' && 'procedure' in m)).toBe(true)
  })
})

describe('rtsp integration test', () => {
  it('declares no test: an RTSP integration carries no URL, the stream probe belongs to camera creation', async () => {
    const mem = makeInMemoryRecords('provider-rtsp')
    await mem.records.declare(rtspRecordKinds)
    const instances = buildRtspInstances(mem.records)
    expect((await instances.describe()).canTest).toBe(false)
    const result = await instances.testInstance({ id: null, values: {} })
    expect(result.success).toBe(false)
    expect(result.status).toBe('unsupported')
  })
})

describe('rtsp registers no second connection test', () => {
  it('the addon answers a test through integration-instances only', () => {
    const addon = readFileSync(new URL('../addon.ts', import.meta.url), 'utf8')
    expect(addon).not.toMatch(/connectionTestCapability|ConnectionTestProvider/)
  })
})
