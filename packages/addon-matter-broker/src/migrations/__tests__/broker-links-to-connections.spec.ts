import { makeInMemoryRecords, moveBrokerLinksToConnections } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { matterBrokersEntryKind, matterConnectionsEntryKind } from '../../broker-record-kinds.js'
import { matterBrokerLinkPorts } from '../broker-links-to-connections.js'
import { ADDON_MIGRATIONS } from '../index.js'

describe('Matter broker links to connections', () => {
  it('moves the link onto the integration record and keeps the fabric intact', async () => {
    const world = makeInMemoryRecords('matter-broker')
    await world.records.declare({
      brokers: matterBrokersEntryKind,
      connections: matterConnectionsEntryKind,
    })
    const brokers = world.records.kind(matterBrokersEntryKind)
    await brokers.put(
      {
        id: 'matter_003',
        data: {
          name: 'Hub fabric',
          threadDataset: '0e08aa',
          wifiSsid: 'marked-ssid',
          wifiPassword: 'pw',
          reconcileIntervalMs: 300_000,
          integrationId: 'int_0040',
        },
      },
      { ifRev: 0 },
    )
    const ports = matterBrokerLinkPorts(world.records, () => undefined)
    expect((await moveBrokerLinksToConnections(ports)).outcome).toBe('done')
    expect((await world.records.kind(matterConnectionsEntryKind).get('int_0040'))?.data).toEqual({
      name: 'Hub fabric',
      brokerId: 'matter_003',
    })
    const kept = await brokers.getResolved('matter_003')
    expect(kept?.data).toMatchObject({ wifiSsid: 'marked-ssid', wifiPassword: 'pw' })
    expect(kept?.data.integrationId).toBeUndefined()
    expect((await moveBrokerLinksToConnections(ports)).outcome).toBe('already-done')
  })

  it('is in the catalogue after the flatten migration', () => {
    expect(ADDON_MIGRATIONS.map((m) => m.meta.id)).toEqual([
      'matter-broker/2026-11-04-flatten-broker-records',
      'matter-broker/2026-11-05-broker-links-to-connections',
    ])
  })
})
