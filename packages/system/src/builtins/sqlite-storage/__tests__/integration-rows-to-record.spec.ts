/**
 * `moveIntegrationRowsToRecords` over REAL SQLite (planning#416): the registry's legacy
 * `integration-settings` rows (secrets as keychain markers) and the addon's own record kind both
 * live in the real engine; the keychain is a fake with a lock switch. The fixture marks a field
 * the migration does not know about and a secret at two depths (a top-level one and one inside a
 * map), so a copy that only moves the obvious field fails.
 */
import {
  createRecordsAccess,
  createSecretsAccess,
  defineRecordKinds,
  type IntegrationRowsPorts,
  isSecretMarker,
  makeSecretMarker,
  moveIntegrationRowsToRecords,
  type RowsToRecordSpec,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { integrationRegistryRecordKinds } from '../integration-record-kinds.js'
import { IntegrationRegistry } from '../integration-registry.js'
import { integrationRowsPortsOver } from '../integration-rows-ports.js'
import {
  ensureLegacyIntegrationRowsTable,
  patchLegacyIntegrationRows,
  readLegacyIntegrationRows,
} from '../migrations/legacy-integration-rows-door.js'
import { makeFakeKeychain, makeRecordsWorld } from './support/records-world.js'

const ADDON = 'spec-bosch'
const CANARY_PASSWORD = 'pw-CANARY-1f2e'
const CANARY_FRIDGE = 'k-fridge-CANARY-77'
const CANARY_OVEN = 'k-oven-CANARY-88'

const kinds = defineRecordKinds({
  accounts: {
    schema: z.object({
      name: z.string().min(1),
      region: z.string().optional(),
      pollSeconds: z.number().optional(),
      password: z.string().meta({ secret: true }).optional(),
      applianceSecrets: z.record(z.string(), z.string().meta({ secret: true })).optional(),
    }),
    class: 'config',
    writeTrigger: 'an operator saves an account',
    retention: { none: 'config' },
  },
})
type Body = {
  name: string
  region?: string
  pollSeconds?: number
  password?: string
  applianceSecrets?: Record<string, string>
}

async function setup() {
  const world = makeRecordsWorld()
  await world.provider.init()
  ensureLegacyIntegrationRowsTable(world.settings.db)
  const keychain = makeFakeKeychain()
  const registryRecords = createRecordsAccess({
    owner: 'integration-registry',
    transport: world.transportFor('integration-registry'),
    secrets: null,
  })
  await registryRecords.declare(integrationRegistryRecordKinds)
  const registry = new IntegrationRegistry(IntegrationRegistry.recordStoresOf(registryRecords))
  await registry.initialize()
  const secrets = createSecretsAccess({ owner: ADDON, transport: keychain })
  const addonRecords = createRecordsAccess({
    owner: ADDON,
    transport: world.transportFor(ADDON),
    secrets,
    logger: { warn: () => undefined },
  })
  await addonRecords.declare(kinds)
  const handle = addonRecords.kind(kinds.accounts)
  const warnings: string[] = []
  // The migration reads through its OWN handle, a cold cache like a fresh boot: the writer's
  // handle above already holds every value it put.
  const door = world.settings.db
  const ports = integrationRowsPortsOver({
    db: door,
    secrets: createSecretsAccess({ owner: ADDON, transport: keychain }),
    listIntegrations: async (addonId) =>
      (await registry.listIntegrations())
        .filter((i) => i.addonId === addonId)
        .map((i) => ({ id: i.id, name: i.name })),
    records: addonRecords.kind({
      name: 'accounts',
      declaration: kinds.accounts.declaration,
      schema: z.record(z.string(), z.unknown()),
    }),
    log: { warn: (m) => warnings.push(m) },
  })

  const putSecretRow = async (integrationId: string, key: string, value: string) => {
    const ref = secrets.ref({ kind: 'integration', integrationId }, key)
    await secrets.put(ref, value)
    patchLegacyIntegrationRows(door, integrationId, { [key]: makeSecretMarker(ref) })
  }
  const legacyRows = async (integrationId: string): Promise<void> => {
    patchLegacyIntegrationRows(door, integrationId, {
      region: 'eu',
      pollSeconds: 30,
      unknownLegacyKey: 'ignored',
    })
    await putSecretRow(integrationId, 'password', CANARY_PASSWORD)
    const fridge = secrets.ref({ kind: 'integration', integrationId }, 'applianceSecrets.fridge')
    const oven = secrets.ref({ kind: 'integration', integrationId }, 'applianceSecrets.oven')
    await secrets.put(fridge, CANARY_FRIDGE)
    await secrets.put(oven, CANARY_OVEN)
    patchLegacyIntegrationRows(door, integrationId, {
      applianceSecrets: {
        fridge: makeSecretMarker(fridge),
        oven: makeSecretMarker(oven),
      },
    })
  }
  return { world, keychain, registry, ports, handle, warnings, legacyRows, secrets }
}

const spec: RowsToRecordSpec<Body> = {
  addonId: ADDON,
  secretPaths: kinds.accounts.declaration.secretPaths,
  bodyFrom: (values, _log, integration) => {
    const apps = values['applianceSecrets']
    return {
      name: integration.name,
      ...(typeof values['region'] === 'string' ? { region: values['region'] } : {}),
      ...(typeof values['pollSeconds'] === 'number' ? { pollSeconds: values['pollSeconds'] } : {}),
      ...(typeof values['password'] === 'string' ? { password: values['password'] } : {}),
      ...(typeof apps === 'object' && apps !== null
        ? {
            applianceSecrets: Object.fromEntries(
              Object.entries(apps).filter((e): e is [string, string] => typeof e[1] === 'string'),
            ),
          }
        : {}),
    }
  },
}

const sqliteText = (world: Awaited<ReturnType<typeof setup>>['world']): string =>
  JSON.stringify(world.settings.db.prepare('SELECT json(data) AS d FROM records').all())

describe('moveIntegrationRowsToRecords', () => {
  it('moves the rows into one record under the registry id: both secrets read back, the rows and their keychain values are gone', async () => {
    const t = await setup()
    const a = await t.registry.createIntegration({ addonId: ADDON, name: 'Home' })
    await t.legacyRows(a.id)

    const result = await moveIntegrationRowsToRecords(t.ports, spec)

    expect(result.outcome).toBe('done')
    const record = (await t.handle.getResolved(a.id))?.data
    expect(record).toEqual({
      name: 'Home',
      region: 'eu',
      pollSeconds: 30,
      password: CANARY_PASSWORD,
      applianceSecrets: { fridge: CANARY_FRIDGE, oven: CANARY_OVEN },
    })
    expect(await readLegacyIntegrationRows(t.world.settings.db, a.id)).toEqual({})
    // the plaintext lives only in the keychain: never in a row of the engine
    expect(sqliteText(t.world)).not.toContain(CANARY_PASSWORD)
    expect(sqliteText(t.world)).not.toContain(CANARY_FRIDGE)
    // the legacy refs were released; only the record's own refs remain (3 secrets)
    expect(t.keychain.values.size).toBe(3)
    expect([...t.keychain.values.keys()].every((r) => r.includes('record'))).toBe(true)
  })

  it('a rerun is a no-op: nothing is put, nothing cleared', async () => {
    const t = await setup()
    const a = await t.registry.createIntegration({ addonId: ADDON, name: 'Home' })
    await t.legacyRows(a.id)
    await moveIntegrationRowsToRecords(t.ports, spec)
    const puts = t.keychain.puts.length
    const again = await moveIntegrationRowsToRecords(t.ports, spec)
    expect(again.outcome).toBe('already-done')
    expect(t.keychain.puts.length).toBe(puts)
    expect((await t.handle.getResolved(a.id))?.data.password).toBe(CANARY_PASSWORD)
  })

  it('a locked keychain throws before anything is written: no record, the rows untouched', async () => {
    const t = await setup()
    const a = await t.registry.createIntegration({ addonId: ADDON, name: 'Home' })
    await t.legacyRows(a.id)
    t.keychain.locked = true
    await expect(moveIntegrationRowsToRecords(t.ports, spec)).rejects.toThrow(
      new RegExp(`'${a.id}'.*cannot be read`),
    )
    t.keychain.locked = false
    expect(await t.handle.get(a.id)).toBeNull()
    const rows = await readLegacyIntegrationRows(t.world.settings.db, a.id)
    expect(isSecretMarker(rows['password'])).toBe(true)
    // and the next pass, with the keychain open, succeeds
    expect((await moveIntegrationRowsToRecords(t.ports, spec)).outcome).toBe('done')
  })

  it('a secret that does not read back from the record removes the record and keeps the rows', async () => {
    const t = await setup()
    const a = await t.registry.createIntegration({ addonId: ADDON, name: 'Home' })
    await t.legacyRows(a.id)
    // the read-back disagrees with what was put: a secret did not land in the record
    const lying: IntegrationRowsPorts = {
      ...t.ports,
      readRecord: async (id) => {
        const row = await t.ports.readRecord(id)
        return row === null ? null : { ...row, applianceSecrets: { fridge: CANARY_FRIDGE } }
      },
    }
    await expect(moveIntegrationRowsToRecords(lying, spec)).rejects.toThrow(
      /applianceSecrets\{oven\} did not read back/,
    )
    expect(await t.handle.get(a.id)).toBeNull()
    expect(
      isSecretMarker((await readLegacyIntegrationRows(t.world.settings.db, a.id))['password']),
    ).toBe(true)
  })

  it('an existing record that holds no password keeps the rows and says so', async () => {
    const t = await setup()
    const a = await t.registry.createIntegration({ addonId: ADDON, name: 'Home' })
    await t.legacyRows(a.id)
    await t.handle.put({ id: a.id, data: { name: 'Home', region: 'us' } }, { ifRev: 0 })
    const result = await moveIntegrationRowsToRecords(t.ports, spec)
    expect(result.summary).toMatchObject({ kept: 1 })
    expect((await t.handle.get(a.id))?.data.region).toBe('us')
    expect(
      isSecretMarker((await readLegacyIntegrationRows(t.world.settings.db, a.id))['password']),
    ).toBe(true)
    expect(t.warnings.join('\n')).toMatch(/password/)
    expect(t.warnings.join('\n')).not.toContain(CANARY_PASSWORD)
  })

  it('an integration with no rows (a default one) still gets its record, and nothing is cleared', async () => {
    const t = await setup()
    const a = await t.registry.createIntegration({ addonId: ADDON, name: 'Default' })
    const other = await t.registry.createIntegration({ addonId: 'another-addon', name: 'X' })
    const result = await moveIntegrationRowsToRecords(t.ports, spec)
    expect(result.outcome).toBe('done')
    expect((await t.handle.get(a.id))?.data).toEqual({ name: 'Default' })
    expect(await t.handle.get(other.id)).toBeNull()
  })
})
