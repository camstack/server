/**
 * The hub-side "clear rows" operation (planning#416) over REAL SQLite: an addon that moved its
 * integration's legacy rows into a record asks the hub to delete the rows AND their keychain
 * values. Only that integration's rows go; another integration of the same addon is untouched.
 */
import {
  createRecordsAccess,
  defineRecordKinds,
  integrationRowsPortsOverApi,
  moveIntegrationRowsToRecords,
  createSecretsAccess,
  isSecretMarker,
  makeSecretMarker,
  type ISettingsStoreProvider,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { integrationRegistryRecordKinds } from '../integration-record-kinds.js'
import { IntegrationRegistry } from '../integration-registry.js'
import { clearIntegrationRows } from '../integration-rows-ports.js'
import {
  clearLegacyIntegrationRows,
  ensureLegacyIntegrationRowsTable,
  patchLegacyIntegrationRows,
  readLegacyIntegrationRows,
} from '../migrations/legacy-integration-rows-door.js'
import { makeFakeKeychain, makeRecordsWorld } from './support/records-world.js'

const ADDON = 'spec-clear'
const CANARY = 'pw-CANARY-clear-9d'

const legacyStore = {
  declareCollection: async () => {},
  query: async () => [],
  insert: async () => {},
  updateWhere: async () => {},
  deleteWhere: async () => {},
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  update: async () => {},
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
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: a no-op legacy store; the records stores serve every call
  const store = legacyStore as unknown as ISettingsStoreProvider
  const registry = new IntegrationRegistry(
    store,
    IntegrationRegistry.recordStoresOf(registryRecords),
  )
  await registry.initialize()
  const secrets = createSecretsAccess({ owner: ADDON, transport: keychain })
  const db = world.settings.db
  const fill = async (integrationId: string): Promise<void> => {
    const ref = secrets.ref({ kind: 'integration', integrationId }, 'password')
    await secrets.put(ref, CANARY)
    patchLegacyIntegrationRows(db, integrationId, {
      region: 'eu',
      password: makeSecretMarker(ref),
    })
  }
  return { registry, secrets, keychain, fill, db }
}

describe('clearIntegrationRows', () => {
  it('deletes the integration rows and their keychain values, and nothing of another integration', async () => {
    const t = await setup()
    const a = await t.registry.createIntegration({ addonId: ADDON, name: 'A' })
    const b = await t.registry.createIntegration({ addonId: ADDON, name: 'B' })
    await t.fill(a.id)
    await t.fill(b.id)
    expect(t.keychain.values.size).toBe(2)

    const result = await clearIntegrationRows(t.db, t.secrets, a.id)

    expect(result).toEqual({ rows: 2, secrets: 1 })
    expect(readLegacyIntegrationRows(t.db, a.id)).toEqual({})
    expect(t.keychain.values.size).toBe(1)
    const other = readLegacyIntegrationRows(t.db, b.id)
    expect(other['region']).toBe('eu')
    expect(isSecretMarker(other['password'])).toBe(true)
    // the integration itself stays
    expect(await t.registry.getIntegration(a.id)).not.toBeNull()
  })

  it('a rerun on cleared rows is a no-op', async () => {
    const t = await setup()
    const a = await t.registry.createIntegration({ addonId: ADDON, name: 'A' })
    await t.fill(a.id)
    await clearIntegrationRows(t.db, t.secrets, a.id)
    const again = await clearIntegrationRows(t.db, t.secrets, a.id)
    expect(again).toEqual({ rows: 0, secrets: 0 })
  })
})

describe('clearIntegrationRows ordering', () => {
  it('a failed keychain delete leaves the rows, so the next run retries and clears both', async () => {
    const t = await setup()
    const a = await t.registry.createIntegration({ addonId: ADDON, name: 'A' })
    await t.fill(a.id)
    const failing = { ...t.secrets, delete: async () => Promise.reject(new Error('keychain down')) }
    await expect(clearIntegrationRows(t.db, failing, a.id)).rejects.toThrow(/keychain down/)
    // the rows still point at the value
    expect(Object.keys(readLegacyIntegrationRows(t.db, a.id))).toContain('password')
    expect(t.keychain.values.size).toBe(1)

    const retry = await clearIntegrationRows(t.db, t.secrets, a.id)
    expect(retry).toEqual({ rows: 2, secrets: 1 })
    expect(t.keychain.values.size).toBe(0)
  })
})

describe('the addon-side ports over the hub API', () => {
  it('move the rows into the addon record and have the hub clear them, secrets included', async () => {
    const t = await setup()
    const world = makeRecordsWorld()
    await world.provider.init()
    const kinds = defineRecordKinds({
      accounts: {
        schema: z.object({
          name: z.string(),
          region: z.string().optional(),
          password: z.string().meta({ secret: true }).optional(),
        }),
        class: 'config',
        writeTrigger: 'an operator saves an account',
        retention: { none: 'config' },
      },
    })
    const addonRecords = createRecordsAccess({
      owner: ADDON,
      transport: world.transportFor(ADDON),
      secrets: t.secrets,
      logger: { warn: () => undefined },
    })
    await addonRecords.declare(kinds)
    const a = await t.registry.createIntegration({ addonId: ADDON, name: 'A' })
    await t.fill(a.id)
    const api = {
      list: () => t.registry.listIntegrations(),
      readLegacyIntegrationRows: async ({ integrationId }: { integrationId: string }) =>
        readLegacyIntegrationRows(t.db, integrationId),
      clearLegacyIntegrationRows: async ({ integrationId }: { integrationId: string }) =>
        clearLegacyIntegrationRows(t.db, integrationId),
    }
    const ports = integrationRowsPortsOverApi({
      api,
      secrets: t.secrets,
      records: addonRecords.kind({
        name: 'accounts',
        declaration: kinds.accounts.declaration,
        schema: z.record(z.string(), z.unknown()),
      }),
      log: { warn: () => undefined },
    })
    const result = await moveIntegrationRowsToRecords(ports, {
      addonId: ADDON,
      secretPaths: kinds.accounts.declaration.secretPaths,
      bodyFrom: (values, _log, integration) => ({
        name: integration.name,
        region: String(values['region']),
        password: String(values['password']),
      }),
    })
    expect(result.outcome).toBe('done')
    const handle = addonRecords.kind(kinds.accounts)
    expect((await handle.getResolved(a.id))?.data).toEqual({
      name: 'A',
      region: 'eu',
      password: CANARY,
    })
    expect(readLegacyIntegrationRows(t.db, a.id)).toEqual({})
  })
})
