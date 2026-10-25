import { describe, expect, it } from 'vitest'
import { HaBrokerEntrySchema } from '../ha-broker-registry.js'
import { HaBrokerStore } from '../ha-broker-store.js'
import { makeHaRecords } from './fake-records.js'

describe('HaBrokerStore', () => {
  it('round-trips a long-lived broker through the brokers entry kind', async () => {
    const world = await makeHaRecords()
    const store = HaBrokerStore.of(world.records)
    const entry = HaBrokerEntrySchema.parse({
      id: 'ha_001',
      name: 'Home',
      auth: { kind: 'long-lived', baseUrl: 'https://hass.local:8123', accessToken: 'tok' },
    })
    await store.upsert(entry)
    const listed = await store.listResolved()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe('ha_001')
    expect(listed[0]?.auth.kind).toBe('long-lived')
    if (listed[0]?.auth.kind === 'long-lived') {
      expect(listed[0].auth.accessToken).toBe('tok')
    }
  })

  it('replaceAll removes brokers absent from the next snapshot', async () => {
    const world = await makeHaRecords()
    const store = HaBrokerStore.of(world.records)
    const a = HaBrokerEntrySchema.parse({
      id: 'ha_001',
      name: 'A',
      auth: { kind: 'long-lived', baseUrl: 'https://a', accessToken: 'a' },
    })
    const b = HaBrokerEntrySchema.parse({
      id: 'ha_002',
      name: 'B',
      auth: { kind: 'long-lived', baseUrl: 'https://b', accessToken: 'b' },
    })
    await store.replaceAll([a, b])
    await store.replaceAll([b])
    expect((await store.listResolved()).map((e) => e.id)).toEqual(['ha_002'])
  })
})
