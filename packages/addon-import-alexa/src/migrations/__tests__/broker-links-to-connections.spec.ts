/**
 * The Alexa integration link moves off the account record onto the integration's own record. The
 * fixture marks the account's name and an extra field: both must survive on the broker.
 */
import { moveBrokerLinksToConnections, makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { alexaBrokersEntryKind, alexaConnectionsEntryKind } from '../../broker-record-kinds.js'
import { ADDON_MIGRATIONS, BROKER_RECORD_MIGRATION_IDS } from '../index.js'
import { alexaBrokerLinkPorts } from '../broker-links-to-connections.js'

const MARK = 'kitchen account, kept as written'

describe('Alexa broker links to connections', () => {
  it('moves int_0035 onto its own record, keeps the broker intact, and is idempotent', async () => {
    const world = makeInMemoryRecords('import-alexa')
    await world.records.declare({
      brokers: alexaBrokersEntryKind,
      connections: alexaConnectionsEntryKind,
    })
    const brokers = world.records.kind(alexaBrokersEntryKind)
    await brokers.put(
      {
        id: 'alexa_002',
        data: {
          name: MARK,
          amazonDomain: 'amazon.it',
          cookie: 'cookie',
          refreshToken: 'refresh',
          macDms: 'mac',
          pollIntervalMs: 90_000,
          integrationId: 'int_0035',
        },
      },
      { ifRev: 0 },
    )
    const warnings: string[] = []
    const ports = alexaBrokerLinkPorts(world.records, (m) => warnings.push(m))
    expect((await moveBrokerLinksToConnections(ports)).outcome).toBe('done')
    expect((await world.records.kind(alexaConnectionsEntryKind).get('int_0035'))?.data).toEqual({
      name: MARK,
      brokerId: 'alexa_002',
    })
    const kept = await brokers.getResolved('alexa_002')
    expect(kept?.data).toMatchObject({
      name: MARK,
      amazonDomain: 'amazon.it',
      pollIntervalMs: 90_000,
      cookie: 'cookie',
      macDms: 'mac',
    })
    expect(kept?.data.integrationId).toBeUndefined()
    expect((await moveBrokerLinksToConnections(ports)).outcome).toBe('already-done')
  })

  it('is in the catalogue, after the rows migration, and runs before anything rewrites a broker', () => {
    const ids = ADDON_MIGRATIONS.map((m) => m.meta.id)
    expect(ids).toContain('import-alexa/2026-11-05-broker-links-to-connections')
    expect(BROKER_RECORD_MIGRATION_IDS).toEqual([
      'import-alexa/2026-11-04-flatten-broker-records',
      'import-alexa/2026-11-05-integration-rows-to-record',
      'import-alexa/2026-11-05-broker-links-to-connections',
    ])
  })
})
