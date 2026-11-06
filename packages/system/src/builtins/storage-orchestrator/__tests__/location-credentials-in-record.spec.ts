/**
 * A location's credential lives in the location's OWN record (planning#440 step 6, D879), driven
 * through the surfaces an operator uses: the instance provider and the storage cap. The real
 * addon, the real records engine and a keychain double; what the PROVIDER is handed after a
 * restart is the claim ("the share still authenticates"), not what the row looks like.
 */
import {
  type AddonContext,
  createRecordsAccess,
  createSecretsAccess,
  type IIntegrationInstancesProvider,
  type IScopedLogger,
  type ISettingsStoreProvider,
  type IStorageCapProvider,
  type IStorageProviderImpl,
  integrationInstancesCapability,
  type RecordsAccess,
  type SecretsAccess,
  storageCapability,
  type StorageLocationDeclaration,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FakeKeychain,
  makeFakeKeychain,
  makeRecordsWorld,
} from '../../sqlite-storage/__tests__/support/records-world.js'
import { locationSecretRef, legacyLocationSecretRef } from '../location-secret-refs.js'
import { storageOrchestratorRecordKinds } from '../record-kinds.js'
import { StorageOrchestratorAddon } from '../storage-orchestrator.addon.js'
import { SqliteLocationStore } from '../location-store.js'

const OWNER = 'storage-orchestrator'
const PASSWORD = 'fixture-not-a-real-password'
const PROVIDER_ID = 'sftp-like'
const SCHEMA = {
  sections: [
    {
      id: 'c',
      title: 'Connection',
      fields: [
        { type: 'text', key: 'host', label: 'Host' },
        { type: 'password', key: 'password', label: 'Password' },
      ],
    },
  ],
}
const DECLARATIONS: readonly StorageLocationDeclaration[] = [
  {
    id: 'backups',
    displayName: 'Backups',
    cardinality: 'multi',
    access: 'cap-mediated',
  },
]

function logger(): IScopedLogger {
  const l = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  l.child.mockReturnValue(l)
  l.withTags.mockReturnValue(l)
  // Documented type boundary: the addon calls only these.
  return l as unknown as IScopedLogger
}

function providerImpl(seen: Array<Record<string, unknown>>): IStorageProviderImpl {
  const impl = {
    getProviderInfo: async () => ({
      providerId: PROVIDER_ID,
      displayName: 'SFTP-like',
      configSchema: SCHEMA,
      nodeLocal: false,
      shouldSaveDiskSpace: false,
    }),
    testLocation: async ({ config }: { config: Record<string, unknown> }) => {
      seen.push({ ...config })
      return config['password'] === PASSWORD
        ? { ok: true }
        : { ok: false, error: 'authentication failed' }
    },
  }
  // Documented type boundary: only these two are reached.
  return impl as unknown as IStorageProviderImpl
}

function engine(): ISettingsStoreProvider {
  const e = {
    declareCollection: async () => {},
    query: async () => [],
    insert: async () => {},
    deleteWhere: async () => ({ deleted: 0 }),
  }
  // Documented type boundary: the readiness gate only.
  return e as unknown as ISettingsStoreProvider
}

interface World {
  readonly records: RecordsAccess
  readonly kc: FakeKeychain
  readonly secrets: SecretsAccess
}

async function world(): Promise<World> {
  const w = makeRecordsWorld()
  await w.provider.init()
  const kc = makeFakeKeychain()
  const secrets = createSecretsAccess({ owner: OWNER, transport: kc })
  const records = createRecordsAccess({
    owner: OWNER,
    transport: w.transportFor(OWNER),
    secrets,
  })
  await records.declare(storageOrchestratorRecordKinds)
  return { records, kc, secrets }
}

interface Booted {
  readonly addon: StorageOrchestratorAddon
  readonly instances: IIntegrationInstancesProvider
  readonly storage: IStorageCapProvider
  readonly seen: Array<Record<string, unknown>>
  readonly forceDelete: (id: string) => Promise<unknown>
}

const live: StorageOrchestratorAddon[] = []

async function boot(w: World): Promise<Booted> {
  const seen: Array<Record<string, unknown>> = []
  const collections: Record<string, readonly unknown[]> = {
    'storage-provider': [providerImpl(seen)],
    'data-store-provider': [engine()],
    'storage-evictable': [],
  }
  const ctx = {
    logger: logger(),
    nodeDataDir: '/tmp/camstack-test-data',
    records: w.records,
    secrets: w.secrets,
    kernel: {
      localNodeId: 'hub',
      capabilityRegistry: {
        getCollection: (n: string): readonly unknown[] => collections[n] ?? [],
      },
      listStorageLocationDeclarations: (): readonly (readonly StorageLocationDeclaration[])[] => [
        DECLARATIONS,
      ],
    },
  }
  const addon = new StorageOrchestratorAddon()
  live.push(addon)
  // Documented type boundary: the addon reads only the fields assembled above.
  const result = await addon.initialize(ctx as unknown as AddonContext)
  if (result === undefined || !('providers' in result) || result.providers === undefined) {
    throw new Error('no registrations')
  }
  const reg = (name: string) => result.providers?.find((r) => r.capability.name === name)?.provider
  const instances = reg(integrationInstancesCapability.name)
  const storage = reg(storageCapability.name)
  if (instances === undefined || storage === undefined) throw new Error('capability not registered')
  const handler = result.actionHandlers?.['forceDeleteLocation']
  if (handler === undefined) throw new Error('forceDeleteLocation is not offered')
  // Documented type boundary: the registration erases the provider type.
  return {
    addon,
    instances: instances as IIntegrationInstancesProvider,
    storage: storage as IStorageCapProvider,
    seen,
    forceDelete: (id) => handler({ id }),
  }
}

afterEach(async () => {
  while (live.length > 0) await live.pop()?.shutdown()
})

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20))
}

describe('a location credential kept in its own record', () => {
  it('create stores it under the record ref; no read shows it; a restart still authenticates', async () => {
    const w = await world()
    const first = await boot(w)
    const { id } = await first.instances.createInstance({
      name: 'NAS',
      kind: 'backups',
      values: {
        providerId: PROVIDER_ID,
        [`${PROVIDER_ID}.host`]: 'nas.lan',
        [`${PROVIDER_ID}.password`]: PASSWORD,
      },
    })
    await settle()
    expect(id).toBe('backups:nas')
    expect(w.kc.values.get(locationSecretRef(id, 'password'))).toBe(PASSWORD)
    expect(w.kc.values.has(legacyLocationSecretRef(id, 'password'))).toBe(false)
    expect(JSON.stringify(await first.storage.listLocations({}))).not.toContain(PASSWORD)
    const [view] = await first.instances.listInstances()
    expect(JSON.stringify(view)).not.toContain(PASSWORD)
    const kind = SqliteLocationStore.recordStoresOf(w.records)
    expect(JSON.stringify(await kind.get(id))).not.toContain(PASSWORD)

    // A restart over the same records and keychain: the provider is handed the real password.
    const second = await boot(w)
    const tested = await second.instances.testInstance?.({ id, values: {} })
    expect(tested).toMatchObject({ success: true, status: 'validated' })
    expect(second.seen.at(-1)?.['password']).toBe(PASSWORD)
  })

  it('a rename sending the view back keeps it; clearing removes it; the forced delete releases it', async () => {
    const w = await world()
    const b = await boot(w)
    const { id } = await b.instances.createInstance({
      name: 'NAS',
      kind: 'backups',
      values: {
        providerId: PROVIDER_ID,
        [`${PROVIDER_ID}.password`]: PASSWORD,
      },
    })
    await settle()
    const stored = await b.instances.getInstance({ id })
    await b.instances.updateInstance({
      id,
      name: 'Renamed',
      values: { password: stored?.formValues['password'] },
    })
    await settle()
    expect(w.kc.values.get(locationSecretRef(id, 'password'))).toBe(PASSWORD)
    expect((await b.instances.testInstance?.({ id, values: {} }))?.success).toBe(true)

    await b.instances.updateInstance({
      id,
      values: { password: { $secretClear: true } },
    })
    await settle()
    expect(w.kc.values.has(locationSecretRef(id, 'password'))).toBe(false)
    expect((await b.instances.testInstance?.({ id, values: {} }))?.success).toBe(false)

    await b.instances.updateInstance({ id, values: { password: PASSWORD } })
    await settle()
    expect(w.kc.values.get(locationSecretRef(id, 'password'))).toBe(PASSWORD)
    // A type keeps one writable location: the delete needs a sibling that is writing.
    await b.instances.createInstance({
      name: 'Second',
      kind: 'backups',
      values: { providerId: PROVIDER_ID, mode: 'active' },
    })
    await settle()
    await b.forceDelete(id)
    await settle()
    expect(w.kc.values.has(locationSecretRef(id, 'password'))).toBe(false)
  })

  it('the legacy cap upsert stores it the same way', async () => {
    const w = await world()
    const b = await boot(w)
    const saved = await b.storage.upsertLocation({
      id: 'backups:old-door',
      type: 'backups',
      displayName: 'Old door',
      providerId: PROVIDER_ID,
      config: { host: 'h', password: PASSWORD },
      isSystem: false,
    })
    await settle()
    expect(JSON.stringify(saved)).not.toContain(PASSWORD)
    expect(w.kc.values.get(locationSecretRef('backups:old-door', 'password'))).toBe(PASSWORD)
  })
})
