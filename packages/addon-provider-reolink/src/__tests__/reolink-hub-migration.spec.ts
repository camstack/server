/**
 * D985 — an existing Reolink Hub DEVICE becomes an integration at boot. The children keep their
 * deviceId and stableId and every field they carried; the hub is retired only once nothing is
 * parented under it; a failed step leaves the hub where it was; a second boot changes nothing.
 */
import { DeviceType, type IScopedLogger, type SavedDevice } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type CreateHubIntegrationInput,
  type HubMigrationPorts,
  type MigrationIntegration,
  MIGRATED_FROM_HUB_KEY,
  planHubMigration,
  retireMigratedHubs,
} from '../reolink-hub-migration.js'
import { reolinkHubStableId } from '../reolink-discovery-map.js'

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const HUB: SavedDevice = {
  id: 10,
  stableId: 'mac-aa-bb',
  type: DeviceType.Hub,
  name: 'Garage Hub',
  location: null,
  disabled: false,
  parentDeviceId: null,
  config: {
    host: '192.168.1.10',
    port: 9000,
    rtspPort: 8554,
    username: 'admin',
    password: 'hub-secret',
    transport: 'tcp',
    uid: 'HUBUID1',
    debugGeneral: true,
  },
}

/** A child whose blob lost its connection fields and carries a marker the migration must keep. */
const CHILD: SavedDevice = {
  id: 11,
  stableId: 'hub-aa-bb-cam-UID1',
  type: DeviceType.Camera,
  name: 'Driveway',
  location: 'Outside',
  disabled: false,
  parentDeviceId: 10,
  config: {
    channel: 2,
    uid: 'UID1',
    marker: 'survives-the-migration',
    deviceCache: { model: 'RLC' },
  },
}

const STANDALONE: SavedDevice = {
  id: 5,
  stableId: 'mac-cc',
  type: DeviceType.Camera,
  name: 'Porch',
  location: null,
  disabled: false,
  parentDeviceId: null,
  config: { host: '192.168.1.50', password: 'cam-secret' },
}

function makePorts(
  over: Partial<HubMigrationPorts> = {},
  integrations: MigrationIntegration[] = [],
) {
  const created: CreateHubIntegrationInput[] = []
  const persisted = new Map<string, Record<string, unknown>>()
  const stamped: Array<[number, string]> = []
  const removed: number[] = []
  const ports: HubMigrationPorts = {
    addonId: 'provider-reolink',
    logger: silentLogger(),
    listIntegrations: async () => integrations,
    createIntegration: async (input) => {
      created.push(input)
      const id = `int-${integrations.length + 1}`
      integrations.push({
        id,
        addonId: input.addonId,
        name: input.name,
        info: input.info,
      })
      return { id }
    },
    setIntegrationId: async (deviceId, integrationId) => {
      stamped.push([deviceId, integrationId])
    },
    persistConfig: async (stableId, config) => {
      persisted.set(stableId, config)
    },
    childIdsOf: async () => [],
    removeDevice: async (id) => {
      removed.push(id)
    },
    ...over,
  }
  return { ports, created, persisted, stamped, removed }
}

describe('planHubMigration', () => {
  it('turns the hub into an integration named after it, secret as a settings password', async () => {
    const { ports, created } = makePorts()
    await planHubMigration([HUB, CHILD], ports)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      addonId: 'provider-reolink',
      name: 'Garage Hub',
      secretKeys: ['password'],
      originStableId: reolinkHubStableId({
        uid: 'HUBUID1',
        host: '192.168.1.10',
      }),
      info: { [MIGRATED_FROM_HUB_KEY]: 10 },
      settings: {
        host: '192.168.1.10',
        port: 9000,
        rtspPort: 8554,
        username: 'admin',
        password: 'hub-secret',
      },
    })
  })

  it('falls back to a host-keyed origin when the hub never knew its uid', async () => {
    const { ports, created } = makePorts()
    const { uid: _uid, ...noUid } = HUB.config
    await planHubMigration([{ ...HUB, config: noUid }, CHILD], ports)
    expect(created[0]?.originStableId).toBe('reolink-hub-host-192-168-1-10')
  })

  it('keeps every child field, stamps the integration, un-parents, and fills the lost host', async () => {
    const { ports, persisted, stamped } = makePorts()
    const plan = await planHubMigration([HUB, CHILD, STANDALONE], ports)
    const child = plan.rows.find((r) => r.id === 11)
    expect(child?.parentDeviceId).toBeNull()
    expect(child?.stableId).toBe('hub-aa-bb-cam-UID1')
    expect(child?.config['marker']).toBe('survives-the-migration')
    expect(child?.config['integrationId']).toBe('int-1')
    expect(child?.config['host']).toBe('192.168.1.10')
    expect(child?.config['channel']).toBe(2)
    // the PERSISTED blob carries it too: restore re-reads the store, not this row
    expect(persisted.get('hub-aa-bb-cam-UID1')).toMatchObject({
      marker: 'survives-the-migration',
      integrationId: 'int-1',
      host: '192.168.1.10',
    })
    expect(stamped).toEqual([[11, 'int-1']])
    expect(plan.rows.find((r) => r.id === 10)).toBeUndefined()
    expect(plan.rows.find((r) => r.id === 5)).toEqual(STANDALONE)
    expect(plan.retirements).toEqual([
      { hubDeviceId: 10, hubName: 'Garage Hub', integrationId: 'int-1' },
    ])
  })

  it('never overwrites a field a child deliberately carries', async () => {
    const { ports } = makePorts()
    const own = { ...CHILD, config: { ...CHILD.config, host: '10.9.9.9' } }
    const plan = await planHubMigration([HUB, own], ports)
    expect(plan.rows.find((r) => r.id === 11)?.config['host']).toBe('10.9.9.9')
  })

  it('is idempotent: a re-run reuses the integration it made, and a migrated store has no hub row', async () => {
    const integrations: MigrationIntegration[] = []
    await planHubMigration([HUB, CHILD], makePorts({}, integrations).ports)
    const again = makePorts({}, integrations)
    await planHubMigration([HUB, CHILD], again.ports)
    expect(again.created).toHaveLength(0)

    const migrated: readonly SavedDevice[] = [
      {
        ...CHILD,
        parentDeviceId: null,
        config: { ...CHILD.config, integrationId: 'int-1' },
      },
      STANDALONE,
    ]
    const third = makePorts({}, integrations)
    const plan = await planHubMigration(migrated, third.ports)
    expect(third.created).toHaveLength(0)
    expect(third.stamped).toEqual([])
    expect(third.persisted.size).toBe(0)
    expect(plan.retirements).toEqual([])
    expect(plan.rows).toEqual(migrated)
  })

  it('a failed step leaves the hub in place: nothing rewritten, nothing to retire', async () => {
    const { ports } = makePorts({
      setIntegrationId: async () => {
        throw new Error('device-manager down')
      },
    })
    const plan = await planHubMigration([HUB, CHILD], ports)
    expect(plan.retirements).toEqual([])
    expect(plan.rows.find((r) => r.id === 11)).toEqual(CHILD)
  })

  it('a locked password is never read as empty and never replaced', async () => {
    const { ports, created } = makePorts()
    const locked = {
      ...HUB,
      config: { ...HUB.config, password: { $secret: 'ref', v: 1 } },
    }
    const plan = await planHubMigration([locked, CHILD], ports)
    expect(created).toHaveLength(0)
    expect(plan.retirements).toEqual([])
  })
})

describe('retireMigratedHubs', () => {
  const retirement = {
    hubDeviceId: 10,
    hubName: 'Garage Hub',
    integrationId: 'int-1',
  }

  it('retires the hub once nothing is parented under it', async () => {
    const { ports, removed } = makePorts()
    expect(await retireMigratedHubs([retirement], ports)).toBe(1)
    expect(removed).toEqual([10])
  })

  it('keeps the hub while a child is still parented under it (removal would cascade it away)', async () => {
    const { ports, removed } = makePorts({ childIdsOf: async () => [11] })
    expect(await retireMigratedHubs([retirement], ports)).toBe(0)
    expect(removed).toEqual([])
  })

  it('a failing removal is retried next boot, not thrown', async () => {
    const { ports } = makePorts({
      removeDevice: async () => {
        throw new Error('boom')
      },
    })
    expect(await retireMigratedHubs([retirement], ports)).toBe(0)
  })
})
