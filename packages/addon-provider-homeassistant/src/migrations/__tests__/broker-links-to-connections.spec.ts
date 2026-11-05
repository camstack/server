import { makeInMemoryRecords, moveBrokerLinksToConnections } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { haBrokersEntryKind, haConnectionsEntryKind } from '../../broker-record-kinds.js'
import { haBrokerLinkPorts } from '../broker-links-to-connections.js'
import { ADDON_MIGRATIONS, INSTANCE_SETTINGS_TO_RECORD_ID } from '../index.js'

describe('Home Assistant broker links to connections', () => {
  it('moves the link onto the integration record and keeps the connection and its calendars intact', async () => {
    const world = makeInMemoryRecords('provider-homeassistant')
    await world.records.declare({
      brokers: haBrokersEntryKind,
      connections: haConnectionsEntryKind,
    })
    const brokers = world.records.kind(haBrokersEntryKind)
    await brokers.put(
      {
        id: 'ha_003',
        data: {
          name: 'Hub connection',
          authKind: 'long-lived',
          baseUrl: 'http://ha.local:8123',
          accessToken: 'tok',
          calendarIds: ['calendar.marked'],
          integrationId: 'int_0061',
        },
      },
      { ifRev: 0 },
    )
    const ports = haBrokerLinkPorts(world.records, () => undefined)
    expect((await moveBrokerLinksToConnections(ports)).outcome).toBe('done')
    expect((await world.records.kind(haConnectionsEntryKind).get('int_0061'))?.data).toEqual({
      name: 'Hub connection',
      brokerId: 'ha_003',
    })
    const kept = await brokers.getResolved('ha_003')
    expect(kept?.data).toMatchObject({
      baseUrl: 'http://ha.local:8123',
      accessToken: 'tok',
      calendarIds: ['calendar.marked'],
    })
    expect(kept?.data.integrationId).toBeUndefined()
    expect((await moveBrokerLinksToConnections(ports)).outcome).toBe('already-done')
  })

  it('runs after the instance-settings move that writes the link', () => {
    const ids = ADDON_MIGRATIONS.map((m) => m.meta.id)
    expect(ids.at(-1)).toBe('provider-homeassistant/2026-11-05-broker-links-to-connections')
    expect(ids.indexOf(INSTANCE_SETTINGS_TO_RECORD_ID)).toBeLessThan(ids.length - 1)
  })
})
