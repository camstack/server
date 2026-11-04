/**
 * The VeSync hub -> integration + Gateway procedure (D987, #259), run the way the owner
 * runs it. The ports are an in-memory kernel that cascades a parent's removal, so a
 * migration that retired the hub too early would lose the purifier.
 */
import {
  type AddonMigrationHost,
  type CreateMigrationIntegrationInput,
  DeviceType,
  defineAddonMigrations,
  type IScopedLogger,
  type MigrationIntegration,
  type MigrationMeta,
  type MigrationOwnerResult,
  runAddonMigrations,
  type SavedDevice,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ADDON_MIGRATIONS, VESYNC_HUB_MIGRATION_ID } from '../migrations/index.js'
import type { VeSyncMigrationPorts } from '../migrations/ports.js'
import { gatewayStableId } from '../vesync-discovery.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

const HUB_STABLE = 'vesync:me-example-com'
const PASSWORD = 'vesync-secret'

function row(
  id: number,
  stableId: string,
  type: DeviceType,
  parentDeviceId: number | null,
  name: string,
  config: Record<string, unknown>,
): SavedDevice {
  return { id, stableId, type, name, location: null, disabled: false, parentDeviceId, config }
}

function fixture(password: unknown = PASSWORD): SavedDevice[] {
  return [
    row(10, HUB_STABLE, DeviceType.Hub, null, 'Home', {
      system: 'vesync-account',
      connection: { email: 'me@example.com', password, region: 'EU', pollIntervalMs: 30_000 },
    }),
    row(21, `${HUB_STABLE}:purifier:cid-1`, DeviceType.Fan, 10, 'Living room', {
      purifierNativeId: 'cid-1',
      accountId: HUB_STABLE,
      model: 'Core300S',
      system: 'vesync',
      operatorNote: 'by the window',
    }),
    row(31, `${HUB_STABLE}:purifier:cid-1:child-lock`, DeviceType.Switch, 21, 'Child lock', {
      kind: 'child-lock',
      purifierNativeId: 'cid-1',
      accountId: HUB_STABLE,
      system: 'vesync',
    }),
  ]
}

interface World {
  readonly rows: Map<number, SavedDevice>
  readonly integrations: MigrationIntegration[]
  readonly stamps: Map<number, string>
  readonly records: Map<string, Record<string, unknown>>
  readonly recordKeychain: Map<string, string>
  readonly tombstones: number[]
  readonly created: CreateMigrationIntegrationInput[]
  nextId: number
}

interface Faults {
  keychainThrows?: boolean
  restoreIsNoop?: boolean
  createGatewayThrows?: boolean
}

function world(rows: readonly SavedDevice[]): World {
  return {
    rows: new Map(rows.map((r) => [r.id, r])),
    integrations: [],
    stamps: new Map(),
    records: new Map(),
    recordKeychain: new Map(),
    tombstones: [],
    created: [],
    nextId: 100,
  }
}

function portsFor(w: World, faults: Faults = {}): VeSyncMigrationPorts {
  const removeWithDescendants = (id: number): void => {
    for (const child of [...w.rows.values()].filter((r) => r.parentDeviceId === id)) {
      removeWithDescendants(child.id)
    }
    w.rows.delete(id)
    w.tombstones.push(id)
  }
  return {
    addonId: 'provider-vesync',
    logger: quiet,
    listSavedDevices: async () => [...w.rows.values()],
    listIntegrations: async () => w.integrations,
    createIntegration: async (input) => {
      if (faults.keychainThrows === true && input.secretKeys.length > 0) {
        throw new Error('keychain write failed')
      }
      const id = `int-${w.integrations.length + 1}`
      w.created.push(input)
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
      const stableId = gatewayStableId(integrationId)
      const existing = [...w.rows.values()].find((r) => r.stableId === stableId)
      if (existing !== undefined) return { deviceId: existing.id }
      const id = w.nextId++
      w.rows.set(
        id,
        row(id, stableId, DeviceType.Gateway, null, name, {
          kind: 'account',
          integrationId,
          system: 'vesync',
        }),
      )
      return { deviceId: id }
    },
    removeDevice: async (id) => removeWithDescendants(id),
    restoreRows: async (restored) => {
      if (faults.restoreIsNoop === true) return
      for (const restoredRow of restored) {
        const stored = w.rows.get(restoredRow.id)
        if (stored !== undefined) w.rows.set(restoredRow.id, { ...stored, parentDeviceId: null })
      }
    },
    putAccountRecord: async (integrationId, body) => {
      if (w.records.has(integrationId)) return 'exists'
      const password = body['password']
      const stored: Record<string, unknown> = { ...body }
      delete stored['password']
      w.records.set(integrationId, stored)
      if (typeof password === 'string' && password.length > 0) {
        w.recordKeychain.set(`${integrationId}:password`, password)
      }
      return 'created'
    },
    readAccountRecord: async (integrationId) => {
      const stored = w.records.get(integrationId)
      if (stored === undefined) return null
      const password = w.recordKeychain.get(`${integrationId}:password`)
      return password === undefined ? { ...stored } : { ...stored, password }
    },
  }
}

function ledgerHost(ledger: MigrationOwnerResult[]): AddonMigrationHost {
  return {
    declareOwner: async ({ metas }: { metas: MigrationMeta[] }) => ({
      bootId: 'b1',
      snapshot: 'none',
      steps: metas.map((m) => ({ id: m.id, action: 'run', state: 'pending' })),
    }),
    startMigration: async () => ({ proceed: true, state: 'pending', reason: null }),
    finishMigration: async ({ result }: { result: MigrationOwnerResult }) => {
      ledger.push(result)
      return result.kind === 'failed'
        ? { status: 'failed', error: result.error, rowsChanged: 0 }
        : { status: 'applied', error: null, rowsChanged: 0 }
    },
  } satisfies AddonMigrationHost
}

async function run(w: World, faults: Faults = {}) {
  const ledger: MigrationOwnerResult[] = []
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, portsFor(w, faults))
  const report = await runAddonMigrations(ledgerHost(ledger), bound, quiet)
  return { report, ledger }
}

describe('VeSync hub -> integration + Gateway', () => {
  it('keeps the purifier deviceId, stableId and marked field; the Gateway is a sibling', async () => {
    const before = fixture()
    const w = world(before)
    const { report, ledger } = await run(w)

    expect(report.applied).toEqual([VESYNC_HUB_MIGRATION_ID])
    expect(ledger[0]).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    expect(w.created[0]).toMatchObject({
      addonId: 'provider-vesync',
      name: 'Home',
      originStableId: HUB_STABLE,
      secretKeys: ['password'],
    })
    expect(w.recordKeychain.get('int-1:password')).toBe(PASSWORD)
    expect(w.records.get('int-1')).toMatchObject({
      name: 'Home',
      email: 'me@example.com',
      region: 'EU',
    })
    expect(JSON.stringify(w.records.get('int-1'))).not.toContain(PASSWORD)

    const purifier = w.rows.get(21)
    expect(purifier?.id).toBe(21)
    expect(purifier?.stableId).toBe(`${HUB_STABLE}:purifier:cid-1`)
    expect(purifier?.parentDeviceId).toBeNull()
    expect(purifier?.config['integrationId']).toBe('int-1')
    expect(purifier?.config['operatorNote']).toBe('by the window')
    expect(purifier?.config['accountId']).toBe(HUB_STABLE)
    expect(w.stamps.get(21)).toBe('int-1')
    expect(w.rows.get(31)?.parentDeviceId).toBe(21)
    expect(w.rows.get(31)?.config['integrationId']).toBe('int-1')

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
    const again = await run(w)
    expect(again.ledger[0]).toMatchObject({
      kind: 'procedure',
      result: { outcome: 'already-done' },
    })
    expect(w.created).toHaveLength(1)
    expect(JSON.stringify([...w.rows.entries()])).toBe(snapshot)
  })

  it('a locked password is not read as an empty one', async () => {
    const w = world(fixture({ $secret: 'locked-ref', v: 1 }))
    const { report } = await run(w)
    expect(report.failed).toEqual([VESYNC_HUB_MIGRATION_ID])
    expect(w.integrations).toHaveLength(0)
    expect(w.records.size).toBe(0)
    expect(w.tombstones).toEqual([])
    expect(w.rows.has(21)).toBe(true)
  })

  it('a keychain failure leaves the hub and the purifier untouched', async () => {
    const w = world(fixture())
    const { report } = await run(w, { keychainThrows: true })
    expect(report.failed).toEqual([VESYNC_HUB_MIGRATION_ID])
    expect(w.tombstones).toEqual([])
    expect(w.rows.get(21)?.parentDeviceId).toBe(10)
    expect(w.rows.get(21)?.config['operatorNote']).toBe('by the window')
    expect(w.stamps.size).toBe(0)
  })

  it('never retires a hub that still has a child', async () => {
    const w = world(fixture())
    const { report } = await run(w, { restoreIsNoop: true })
    expect(report.failed).toEqual([VESYNC_HUB_MIGRATION_ID])
    expect(w.tombstones).toEqual([])
    expect(w.rows.has(10)).toBe(true)
    expect(w.rows.has(21)).toBe(true)
    expect(w.rows.get(21)?.id).toBe(21)
  })
})
