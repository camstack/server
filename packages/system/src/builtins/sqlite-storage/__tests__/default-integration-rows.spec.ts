/**
 * The S-A catalogue (`defaultIntegrationMigrations`, planning#416) over REAL SQLite: an addon whose
 * integrations hold no settings moves every integration into a name-only record under its registry
 * id and clears the legacy rows; a legacy key nothing reads is named in a warning, not carried over.
 */
import {
  createRecordsAccess,
  defaultIntegrationMigrations,
  defineAddonMigrations,
  defineEntryKind,
  entryBody,
  defaultIntegrationPortsOver,
  resolveSecretMarkers,
  createSecretsAccess,
  type ISettingsStoreProvider,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { integrationRegistryRecordKinds } from '../integration-record-kinds.js'
import { IntegrationRegistry } from '../integration-registry.js'
import { clearIntegrationRows } from '../integration-rows-ports.js'
import { makeFakeKeychain, makeRecordsWorld } from './support/records-world.js'

const ADDON = 'provider-spec-default'
const MARK = 'legacy-key-the-migration-does-not-know'

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
  return { registry, secrets, keychain }
}

const kind = defineEntryKind('connections', {
  title: 'Spec integrations',
  schema: entryBody({}),
})

async function setupWorld() {
  const t = await setup()
  const world = makeRecordsWorld()
  await world.provider.init()
  const addonRecords = createRecordsAccess({
    owner: ADDON,
    transport: world.transportFor(ADDON),
    secrets: t.secrets,
    logger: { warn: () => undefined },
  })
  await addonRecords.declare({ connections: kind })
  const warnings: string[] = []
  const api = {
    list: async () => t.registry.listIntegrations(),
    getSettings: async ({ id }: { id: string }) =>
      (await resolveSecretMarkers(await t.registry.getIntegrationSettings(id), t.secrets)).value,
    clearSettings: ({ id }: { id: string }) =>
      clearIntegrationRows({ registry: t.registry, secrets: t.secrets }, id),
  }
  const ports = defaultIntegrationPortsOver({
    api: {
      ...api,
      listDevices: async () => [],
      setDeviceIntegrationId: async () => undefined,
      readDeviceIntegrationId: async () => null,
    },
    records: addonRecords,
    kind,
    info: () => undefined,
    warn: (m) => warnings.push(m),
  })
  const run = async () => {
    const [rows] = defineAddonMigrations(
      defaultIntegrationMigrations({ addonId: ADDON, date: '2026-11-04' }),
      ports,
    )
    if (rows === undefined) throw new Error('no migration')
    return rows.execute()
  }
  return { t, addonRecords, warnings, run }
}

describe('defaultIntegrationMigrations: integration rows to record', () => {
  it('moves every integration into a name-only record under its registry id and clears the rows', async () => {
    const w = await setupWorld()
    const a = await w.t.registry.createIntegration({ addonId: ADDON, name: 'Default' })
    const b = await w.t.registry.createIntegration({ addonId: ADDON, name: 'Second' })
    const other = await w.t.registry.createIntegration({ addonId: 'another-addon', name: 'X' })
    await w.t.registry.setIntegrationSetting(a.id, 'unknownLegacyKey', MARK)

    const first = await w.run()

    expect(first).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const handle = w.addonRecords.kind(kind)
    expect((await handle.get(a.id))?.data).toEqual({ name: 'Default' })
    expect((await handle.get(b.id))?.data).toEqual({ name: 'Second' })
    expect(await handle.get(other.id)).toBeNull()
    expect(await w.t.registry.getIntegrationSettings(a.id)).toEqual({})
    expect(w.warnings.join('\n')).toContain('unknownLegacyKey')
    expect(w.warnings.join('\n')).not.toContain(MARK)

    // a rerun is a no-op
    const again = await w.run()
    expect(again).toMatchObject({ result: { outcome: 'already-done' } })
  })
})
