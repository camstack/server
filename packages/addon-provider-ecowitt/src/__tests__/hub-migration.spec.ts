/**
 * The Ecowitt hub -> integration + Gateway procedure (D987, #259 L3b), run the way the owner runs
 * it: the catalogue bound to ports and driven by `runAddonMigrations` against a ledger fake. The
 * ports are a small in-memory kernel that cascades a parent's removal exactly like the real one,
 * so a migration that retired the hub too early would lose the children and the spec would see it.
 */
import {
  type AddonMigrationHost,
  type CreateMigrationIntegrationInput,
  DeviceType,
  defineAddonMigrations,
  type IScopedLogger,
  type MigrationMeta,
  type MigrationOwnerResult,
  type MigrationIntegration,
  runAddonMigrations,
  type SavedDevice,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { gatewayKeyOf } from '../config.js'
import { gatewayDeviceNativeId } from '../ecowitt-discovery.js'
import { ADDON_MIGRATIONS } from '../migrations/index.js'
import type { EcowittMigrationPorts } from '../migrations/ports.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

const HUB_STABLE = 'ecowitt:192-168-1-50'
const MIGRATION_ID = 'provider-ecowitt/2026-11-01-hub-to-integration-gateway'

function row(
  id: number,
  stableId: string,
  type: DeviceType,
  parentDeviceId: number | null,
  name: string,
  config: Record<string, unknown>,
): SavedDevice {
  return {
    id,
    stableId,
    type,
    name,
    location: null,
    disabled: false,
    parentDeviceId,
    config,
  }
}

/** The station the live hub holds: a hub, two group containers, three sensors. */
function fixture(password: unknown = 'hunter2'): SavedDevice[] {
  const gatewayId = HUB_STABLE
  return [
    row(10, HUB_STABLE, DeviceType.Hub, null, 'Weather station', {
      system: 'ecowitt-gateway',
      connection: {
        transport: 'local',
        host: '192.168.1.50',
        port: 80,
        password,
        pollIntervalMs: 30_000,
        mappingIntervalMs: 600_000,
        stationId: '',
      },
    }),
    row(11, `${HUB_STABLE}:gateway`, DeviceType.Container, 10, 'Gateway group', {
      gatewayId,
      deviceGroup: 'gateway',
      system: 'ecowitt',
      sensors: [],
    }),
    row(12, `${HUB_STABLE}:weather-station`, DeviceType.Container, 10, 'Outdoor', {
      gatewayId,
      deviceGroup: 'weather-station',
      system: 'ecowitt',
      sensors: [],
    }),
    row(21, `${HUB_STABLE}:gateway:indoor-temp`, DeviceType.Sensor, 11, 'Indoor temp', {
      sensorId: 'indoor-temp',
      gatewayId,
      quantity: 'temperature',
      system: 'ecowitt',
    }),
    row(22, `${HUB_STABLE}:weather-station:wind`, DeviceType.Sensor, 12, 'Wind (custom)', {
      sensorId: 'wind',
      gatewayId,
      quantity: 'wind-speed',
      system: 'ecowitt',
      // The MARKED field: not in the sensor schema, set by hand on the live hub.
      operatorNote: 'mast on the north roof',
    }),
    row(23, `${HUB_STABLE}:weather-station:rain`, DeviceType.Sensor, 12, 'Rain', {
      sensorId: 'rain',
      gatewayId,
      quantity: 'rain',
      system: 'ecowitt',
    }),
  ]
}

interface World {
  readonly rows: Map<number, SavedDevice>
  readonly integrations: MigrationIntegration[]
  readonly stamps: Map<number, string>
  readonly keychain: Map<string, string>
  readonly tombstones: number[]
  readonly created: CreateMigrationIntegrationInput[]
  nextId: number
}

interface Faults {
  keychainThrows?: boolean
  /** A container the restore fails to un-parent. */
  stuckContainerId?: number
  /** A restore that reports back without un-parenting anything. */
  restoreIsNoop?: boolean
  /** The Gateway creation dies after the containers were restored. */
  createGatewayThrows?: boolean
}

function world(rows: readonly SavedDevice[]): World {
  return {
    rows: new Map(rows.map((r) => [r.id, r])),
    integrations: [],
    stamps: new Map(),
    keychain: new Map(),
    tombstones: [],
    created: [],
    nextId: 100,
  }
}

function portsFor(w: World, faults: Faults = {}): EcowittMigrationPorts {
  const removeWithDescendants = (id: number): void => {
    for (const child of [...w.rows.values()].filter((r) => r.parentDeviceId === id)) {
      removeWithDescendants(child.id)
    }
    w.rows.delete(id)
    w.tombstones.push(id)
  }
  return {
    addonId: 'provider-ecowitt',
    logger: quiet,
    listSavedDevices: async () => [...w.rows.values()],
    listIntegrations: async () => w.integrations,
    createIntegration: async (input) => {
      if (faults.keychainThrows === true && input.secretKeys.length > 0) {
        throw new Error('keychain write failed')
      }
      const id = `int-${w.integrations.length + 1}`
      w.created.push(input)
      for (const key of input.secretKeys) {
        w.keychain.set(`${id}:${key}`, String(input.settings[key]))
      }
      w.integrations.push({
        id,
        addonId: input.addonId,
        name: input.name,
        info: input.info,
        originStableId: input.originStableId,
      })
      return { id }
    },
    setIntegrationId: async (deviceId, integrationId) => {
      w.stamps.set(deviceId, integrationId)
    },
    persistConfig: async (stableId, config) => {
      const found = [...w.rows.values()].find((r) => r.stableId === stableId)
      if (found === undefined) throw new Error(`no row ${stableId}`)
      w.rows.set(found.id, { ...found, config })
    },
    childIdsOf: async (parent) =>
      [...w.rows.values()].filter((r) => r.parentDeviceId === parent).map((r) => r.id),
    createGateway: async ({ integrationId, name }) => {
      if (faults.createGatewayThrows === true) throw new Error('gateway creation failed')
      const integration = w.integrations.find((i) => i.id === integrationId)
      if (integration === undefined) throw new Error(`no integration ${integrationId}`)
      // Identity is the stableId, as in the kernel: one Gateway row per gateway key.
      const stableId = gatewayDeviceNativeId(gatewayKeyOf(integration))
      const existing = [...w.rows.values()].find((r) => r.stableId === stableId)
      if (existing !== undefined) return { deviceId: existing.id }
      const id = w.nextId++
      w.rows.set(id, row(id, stableId, DeviceType.Gateway, null, name, { integrationId }))
      return { deviceId: id }
    },
    removeDevice: async (id) => removeWithDescendants(id),
    restoreRows: async (restored) => {
      for (const r of restored) {
        if (faults.restoreIsNoop === true || r.id === faults.stuckContainerId) continue
        const stored = w.rows.get(r.id)
        if (stored !== undefined) w.rows.set(r.id, { ...stored, parentDeviceId: null })
      }
    },
  }
}

interface Ledger {
  readonly results: MigrationOwnerResult[]
}

function ledgerHost(ledger: Ledger): AddonMigrationHost {
  return {
    declareOwner: async ({ metas }: { metas: MigrationMeta[] }) => ({
      bootId: 'b1',
      snapshot: 'none',
      steps: metas.map((m) => ({ id: m.id, action: 'run', state: 'pending' })),
    }),
    startMigration: async () => ({
      proceed: true,
      state: 'pending',
      reason: null,
    }),
    finishMigration: async ({ result }: { result: MigrationOwnerResult }) => {
      ledger.results.push(result)
      return result.kind === 'failed'
        ? { status: 'failed', error: result.error, rowsChanged: 0 }
        : { status: 'applied', error: null, rowsChanged: 0 }
    },
  } as AddonMigrationHost
}

async function run(w: World, faults: Faults = {}, ledger: Ledger = { results: [] }) {
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, portsFor(w, faults))
  const report = await runAddonMigrations(ledgerHost(ledger), bound, quiet)
  return { report, ledger }
}

describe('Ecowitt hub -> integration + Gateway', () => {
  it('keeps every deviceId, stableId and marked field; the Gateway is a sibling; the hub is tombstoned', async () => {
    const before = fixture()
    const w = world(before)
    const { report, ledger } = await run(w)

    expect(report.applied).toEqual([MIGRATION_ID])
    expect(ledger.results[0]).toMatchObject({
      kind: 'procedure',
      result: { outcome: 'done' },
    })

    // The integration carries the hub's identity and the password went through the keychain.
    expect(w.created).toHaveLength(1)
    expect(w.created[0]).toMatchObject({
      addonId: 'provider-ecowitt',
      name: 'Weather station',
      originStableId: HUB_STABLE,
      secretKeys: ['password'],
    })
    expect(w.created[0]?.settings).toMatchObject({
      transport: 'local',
      host: '192.168.1.50',
    })
    expect(w.keychain.get('int-1:password')).toBe('hunter2')

    // Same ids, same stableIds, restamped, un-parented containers.
    for (const old of before.filter((r) => r.type !== DeviceType.Hub)) {
      const now = w.rows.get(old.id)
      expect(now, `device ${old.id} survived`).toBeDefined()
      expect(now?.stableId).toBe(old.stableId)
      expect(now?.name).toBe(old.name)
      expect(w.stamps.get(old.id)).toBe('int-1')
      expect(now?.config['integrationId']).toBe('int-1')
    }
    expect(w.rows.get(11)?.parentDeviceId).toBeNull()
    expect(w.rows.get(12)?.parentDeviceId).toBeNull()
    expect(w.rows.get(22)?.parentDeviceId).toBe(12)

    // The marked field of the sensor blob survived the rewrite.
    expect(w.rows.get(22)?.config['operatorNote']).toBe('mast on the north roof')
    expect(w.rows.get(22)?.config['gatewayId']).toBe(HUB_STABLE)

    // Gateway sibling (parent null); hub tombstoned and only the hub.
    const gateway = [...w.rows.values()].find((r) => r.type === DeviceType.Gateway)
    expect(gateway?.parentDeviceId).toBeNull()
    expect(gateway?.config['integrationId']).toBe('int-1')
    expect(w.tombstones).toEqual([10])
    expect(w.rows.has(10)).toBe(false)
  })

  it('a rerun sees the work done and changes nothing', async () => {
    const w = world(fixture())
    await run(w)
    const snapshot = JSON.stringify([...w.rows.entries()])
    const tombstones = [...w.tombstones]

    const again = await run(w)
    expect(again.ledger.results[0]).toMatchObject({
      kind: 'procedure',
      result: { outcome: 'already-done' },
    })
    expect(w.created).toHaveLength(1)
    expect(w.tombstones).toEqual(tombstones)
    expect(JSON.stringify([...w.rows.entries()])).toBe(snapshot)
  })

  it('a run that died before the tombstone reuses the integration and the Gateway', async () => {
    const w = world(fixture())
    // The first run got as far as the integration and a Gateway, then the process died.
    await portsFor(w).createIntegration({
      addonId: 'provider-ecowitt',
      name: 'Weather station',
      info: {},
      originStableId: HUB_STABLE,
      settings: {},
      secretKeys: [],
    })
    await portsFor(w).createGateway({
      integrationId: 'int-1',
      name: 'Weather station',
    })
    w.created.length = 0

    const { report } = await run(w)
    expect(report.applied).toEqual([MIGRATION_ID])
    expect(w.integrations).toHaveLength(1)
    expect(w.created).toHaveLength(0)
    expect([...w.rows.values()].filter((r) => r.type === DeviceType.Gateway)).toHaveLength(1)
    expect(w.tombstones).toEqual([10])
  })

  it('a keychain failure leaves the ledger failed, no tombstone and the children untouched', async () => {
    const before = fixture()
    const w = world(before)
    const { report, ledger } = await run(w, { keychainThrows: true })

    expect(report.failed).toEqual([MIGRATION_ID])
    expect(report.blockOwner).toEqual([MIGRATION_ID])
    expect(ledger.results[0]).toMatchObject({ kind: 'failed' })
    expect(w.tombstones).toEqual([])
    expect(w.rows.has(10)).toBe(true)
    expect(w.integrations).toHaveLength(0)
    for (const old of before) expect(w.rows.get(old.id)).toEqual(old)
    expect(w.stamps.size).toBe(0)
  })

  it('a locked password is not read as an empty one: failed, nothing created', async () => {
    const w = world(fixture({ $secret: 'locked-ref', v: 1 }))
    const { report } = await run(w)
    expect(report.failed).toEqual([MIGRATION_ID])
    expect(w.integrations).toHaveLength(0)
    expect(w.tombstones).toEqual([])
  })

  it('never retires a hub that still has a child: fails, hub and children stay', async () => {
    const w = world(fixture())
    const { report } = await run(w, { stuckContainerId: 12 })
    expect(report.failed).toEqual([MIGRATION_ID])
    expect(w.tombstones).toEqual([])
    expect(w.rows.has(10)).toBe(true)
    expect(w.rows.has(12)).toBe(true)
    expect(w.rows.has(22)).toBe(true)
    expect(w.rows.has(23)).toBe(true)
  })

  it('resumes when the containers are already un-parented and only some sensors are stamped', async () => {
    const before = fixture()
    const w = world(before)
    // The first run stamped sensor 21 and un-parented both containers, then died.
    await portsFor(w).createIntegration({
      addonId: 'provider-ecowitt',
      name: 'Weather station',
      info: {},
      originStableId: HUB_STABLE,
      settings: {},
      secretKeys: [],
    })
    for (const id of [11, 12]) {
      const r = w.rows.get(id)
      if (r !== undefined) w.rows.set(id, { ...r, parentDeviceId: null })
    }
    const s21 = w.rows.get(21)
    if (s21 !== undefined)
      w.rows.set(21, { ...s21, config: { ...s21.config, integrationId: 'int-1' } })
    w.stamps.set(21, 'int-1')

    const { report } = await run(w)
    expect(report.applied).toEqual([MIGRATION_ID])
    // Every sensor is stamped, not just the one the dead run reached.
    for (const id of [21, 22, 23]) {
      expect(w.stamps.get(id), `sensor ${id} stamped`).toBe('int-1')
      expect(w.rows.get(id)?.config['integrationId']).toBe('int-1')
    }
    expect(w.rows.get(22)?.config['operatorNote']).toBe('mast on the north roof')
    expect(w.tombstones).toEqual([10])
    expect(w.integrations).toHaveLength(1)
  })

  it('a failure between the container restore and the tombstone keeps the hub; the retry finishes', async () => {
    const w = world(fixture())
    const first = await run(w, { createGatewayThrows: true })
    expect(first.report.failed).toEqual([MIGRATION_ID])
    expect(w.tombstones).toEqual([])
    expect(w.rows.has(10)).toBe(true)
    expect(w.rows.get(11)?.parentDeviceId).toBeNull()
    expect(w.rows.get(12)?.parentDeviceId).toBeNull()

    const second = await run(w)
    expect(second.report.applied).toEqual([MIGRATION_ID])
    expect(w.tombstones).toEqual([10])
    for (const id of [11, 12, 21, 22, 23]) expect(w.rows.has(id)).toBe(true)
    expect(w.integrations).toHaveLength(1)
  })

  it('a restore that reports back without un-parenting never lets the hub be tombstoned', async () => {
    const w = world(fixture())
    const { report } = await run(w, { restoreIsNoop: true })
    expect(report.failed).toEqual([MIGRATION_ID])
    expect(w.tombstones).toEqual([])
    for (const id of [10, 11, 12, 21, 22, 23]) expect(w.rows.has(id)).toBe(true)
  })

  it('a bad hub never stops a healthy one: B is migrated, the ledger fails naming A', async () => {
    const hubA = fixture({ $secret: 'locked-ref', v: 1 })
    const hubB: SavedDevice[] = [
      row(30, 'ecowitt:10-0-0-2', DeviceType.Hub, null, 'Second station', {
        system: 'ecowitt-gateway',
        connection: { transport: 'listener', listenPort: 8123 },
      }),
      row(31, 'ecowitt:10-0-0-2:gateway', DeviceType.Container, 30, 'Gateway group 2', {
        gatewayId: 'ecowitt:10-0-0-2',
        deviceGroup: 'gateway',
        system: 'ecowitt',
        sensors: [],
      }),
      row(41, 'ecowitt:10-0-0-2:gateway:t', DeviceType.Sensor, 31, 'Temp 2', {
        sensorId: 't',
        gatewayId: 'ecowitt:10-0-0-2',
        quantity: 'temperature',
        system: 'ecowitt',
      }),
    ]
    const w = world([...hubA, ...hubB])
    const { report, ledger } = await run(w)

    expect(report.failed).toEqual([MIGRATION_ID])
    expect(w.tombstones).toEqual([30])
    expect(w.rows.get(31)?.parentDeviceId).toBeNull()
    expect(w.rows.get(41)?.config['integrationId']).toBe('int-1')
    expect(w.rows.has(10)).toBe(true)
    const failure = ledger.results[0]
    expect(failure?.kind).toBe('failed')
    expect(JSON.stringify(failure)).toContain('hub 10')
    expect(JSON.stringify(failure)).not.toContain('hub 30:')
  })

  it('a hub with no connection and no children is retired; one with children is kept', async () => {
    const empty = world([row(50, 'ecowitt:empty', DeviceType.Hub, null, 'Empty shell', {})])
    const done = await run(empty)
    expect(done.report.applied).toEqual([MIGRATION_ID])
    expect(empty.tombstones).toEqual([50])
    expect(empty.integrations).toHaveLength(0)

    const hub = row(60, 'ecowitt:noconn', DeviceType.Hub, null, 'No connection', {})
    const child = row(61, 'ecowitt:noconn:gateway', DeviceType.Container, 60, 'Group', {
      gatewayId: 'ecowitt:noconn',
      system: 'ecowitt',
    })
    const kept = world([hub, child])
    const failed = await run(kept)
    expect(failed.report.failed).toEqual([MIGRATION_ID])
    expect(kept.tombstones).toEqual([])
    expect(kept.rows.has(61)).toBe(true)
  })
})
