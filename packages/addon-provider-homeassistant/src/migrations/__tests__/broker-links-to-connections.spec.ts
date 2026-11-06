import {
  type AddonMigrationHost,
  defineAddonMigrations,
  type IScopedLogger,
  makeInMemoryRecords,
  type MigrationOwnerResult,
  moveBrokerLinksToConnections,
  runAddonMigrations,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { haBrokersEntryKind, haConnectionsEntryKind } from '../../broker-record-kinds.js'
import { NO_CALENDAR_PORTS, NO_NOTIFY_PORTS } from '../../__tests__/no-link-ports.js'
import { rawBrokers } from '../../__tests__/raw-brokers.js'
import {
  BROKER_LINKS_TO_CONNECTIONS_ID,
  haBrokerLinkPorts,
} from '../broker-links-to-connections.js'
import {
  ADDON_MIGRATIONS,
  type HaMigrationPorts,
  INSTANCE_SETTINGS_TO_RECORD_ID,
} from '../index.js'

describe('Home Assistant broker links to connections', () => {
  it('moves the link onto the integration record and keeps the connection and its calendars intact', async () => {
    const world = makeInMemoryRecords('provider-homeassistant')
    await world.records.declare({
      brokers: haBrokersEntryKind,
      connections: haConnectionsEntryKind,
    })
    const brokers = rawBrokers(world.records)
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
    expect(kept?.data['integrationId']).toBeUndefined()
    expect((await moveBrokerLinksToConnections(ports)).outcome).toBe('already-done')
  })

  it('runs after the instance-settings move that writes the link', () => {
    const ids = ADDON_MIGRATIONS.map((m) => m.meta.id)
    expect(ids.indexOf(BROKER_LINKS_TO_CONNECTIONS_ID)).toBe(ids.length - 3)
    expect(ids.indexOf(INSTANCE_SETTINGS_TO_RECORD_ID)).toBeLessThan(
      ids.indexOf(BROKER_LINKS_TO_CONNECTIONS_ID),
    )
  })

  it('a link that does not read back stays on the broker, is reported, and does not block the addon', async () => {
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
          integrationId: 'int_0061',
        },
      },
      { ifRev: 0 },
    )
    const real = haBrokerLinkPorts(world.records, () => undefined)
    const notInThisRun = async (): Promise<never> => {
      throw new Error('not part of this run')
    }
    const ports: HaMigrationPorts = {
      ...real,
      ...NO_CALENDAR_PORTS,
      ...NO_NOTIFY_PORTS,
      readConnection: async () => null,
      readStored: notInThisRun,
      listInstances: notInThisRun,
      patchInstanceSettings: notInThisRun,
      listNested: notInThisRun,
      readResolved: notInThisRun,
      patch: notInThisRun,
      readInstance: notInThisRun,
      patchInstance: notInThisRun,
      clearInstanceSettingsKeys: notInThisRun,
    }
    const logged: string[] = []
    const logger: IScopedLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message) => {
        logged.push(message)
      },
      child: () => logger,
      withTags: () => logger,
    }
    const results: MigrationOwnerResult[] = []
    const host: AddonMigrationHost = {
      declareOwner: async ({ metas }) => ({
        bootId: 'b1',
        snapshot: 'none',
        steps: metas.map((m) => ({
          id: m.id,
          action: 'run',
          state: 'pending',
        })),
      }),
      startMigration: async () => ({
        proceed: true,
        state: 'pending',
        reason: null,
      }),
      finishMigration: async ({ result }) => {
        results.push(result)
        return result.kind === 'failed'
          ? { status: 'failed', error: result.error, rowsChanged: 0 }
          : { status: 'applied', error: null, rowsChanged: 0 }
      },
    }
    const report = await runAddonMigrations(
      host,
      defineAddonMigrations(ADDON_MIGRATIONS, ports),
      logger,
      { only: [BROKER_LINKS_TO_CONNECTIONS_ID] },
    )
    expect(report.failed).toEqual([BROKER_LINKS_TO_CONNECTIONS_ID])
    expect(report.blockOwner).toEqual([])
    expect(results[0]).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('did not read back'),
    })
    expect(logged).toContain('migration failed')
    expect((await brokers.get('ha_003'))?.data['integrationId']).toBe('int_0061')
  })
})
