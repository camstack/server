/**
 * Credential redaction, asserted through the CAP SURFACE the operator's admin
 * UI actually calls — not through the helpers in `location-secrets.ts`.
 *
 * `location-secrets.spec.ts` already pins the helpers, and every one of those
 * assertions stays green if somebody deletes the `this.redacted(...)` call from
 * `listLocations` or the `restoreRedactedSecrets(...)` call from
 * `upsertLocation`. A helper that is never reached is a leak with a passing
 * test suite next to it. So this file builds the real `StorageOrchestratorAddon`
 * over a fake registry and drives the four sequences that matter:
 *
 *  1. a session reads the location list — the password must not be on it;
 *  2. the operator renames a location and saves it back — the password must
 *     still REACH THE PROVIDER afterwards, which is asserted at the provider,
 *     not at the store, because "the stored string looks right" is not the same
 *     claim as "the share still authenticates";
 *  3. the operator clears an optional password — `''` must survive, so
 *     "leave it alone" and "set it to empty" stay distinguishable;
 *  4. the row is read back BEFORE its provider has registered — the boot
 *     window, and the permanent state of a runner the CrashSupervisor gave up
 *     on. Redaction is schema-driven, and the schema arrives with the
 *     provider, so this is the one direction the mechanism can fail OPEN in.
 *
 * The literal below is a fixture, not a credential; the live hub has no SMB
 * location yet, which is the whole reason this lands first.
 */
import type {
  AddonContext,
  IScopedLogger,
  ISettingsStoreProvider,
  IStorageCapProvider,
  IStorageProviderImpl,
  SettingsRecord,
  StorageLocationDeclaration,
} from '@camstack/types'
import { REDACTED_SECRET, storageCapability } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageOrchestratorAddon } from '../storage-orchestrator.addon.js'

/** Fixture password. Never a real one — see the file docblock. */
const REAL_PASSWORD = 'fixture-not-a-real-password'
const PROVIDER_ID = 'smb-storage'
const LOCATION_ID = 'backups:nas'

/** Shaped like the real `smb-config-schema.ts`: one `type: 'password'` field. */
const SMB_LIKE_SCHEMA = {
  sections: [
    {
      id: 'connection',
      title: 'Connection',
      fields: [
        { type: 'text', key: 'host', label: 'Host' },
        { type: 'text', key: 'share', label: 'Share' },
        { type: 'text', key: 'username', label: 'Username' },
        { type: 'password', key: 'password', label: 'Password' },
        { type: 'text', key: 'basePath', label: 'Base path' },
      ],
    },
  ],
}

const DECLARATIONS: readonly StorageLocationDeclaration[] = [
  { id: 'backups', displayName: 'Backups', cardinality: 'multi', access: 'cap-mediated' },
]

function makeLogger(): IScopedLogger {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  logger.withTags.mockReturnValue(logger)
  // Documented type boundary: the addon only ever calls these six.
  return logger as unknown as IScopedLogger
}

interface FakeProvider {
  readonly impl: IStorageProviderImpl
  /** Every config the provider was handed, in call order. */
  readonly seenConfigs: Array<Readonly<Record<string, unknown>>>
}

/**
 * A remote, credential-carrying provider. `testLocation` is the seam that
 * proves the secret still works: it answers `ok` only when the password it was
 * handed is the one the operator originally typed.
 */
function makeProvider(): FakeProvider {
  const seenConfigs: Array<Readonly<Record<string, unknown>>> = []
  const impl = {
    getProviderInfo: async () => ({
      providerId: PROVIDER_ID,
      displayName: 'SMB / CIFS',
      configSchema: SMB_LIKE_SCHEMA,
      nodeLocal: false,
      shouldSaveDiskSpace: false,
    }),
    testLocation: async ({ config }: { config: Readonly<Record<string, unknown>> }) => {
      seenConfigs.push({ ...config })
      return config['password'] === REAL_PASSWORD
        ? { ok: true }
        : { ok: false, error: 'authentication failed' }
    },
  }
  // Documented type boundary: the orchestrator reaches only these two methods
  // on the paths under test; every other one throws if it is ever called.
  return { impl: impl as unknown as IStorageProviderImpl, seenConfigs }
}

/** In-memory `data-store-provider` engine — the four methods the store uses. */
function makeEngine(seed: readonly SettingsRecord[]): ISettingsStoreProvider {
  const rows = new Map<string, SettingsRecord>(seed.map((r) => [r.id, r]))
  const engine = {
    declareCollection: async () => {},
    query: async () => [...rows.values()],
    insert: async ({ record }: { record: SettingsRecord }) => {
      rows.set(record.id, record)
    },
    deleteWhere: async ({ filter }: { filter: { where?: Record<string, unknown> } }) => {
      const id = filter.where?.['id']
      if (typeof id === 'string' && rows.delete(id)) return { deleted: 1 }
      return { deleted: 0 }
    },
  }
  // Documented type boundary: `SqliteLocationStore` calls exactly these four.
  return engine as unknown as ISettingsStoreProvider
}

interface Harness {
  readonly addon: StorageOrchestratorAddon
  readonly storage: IStorageCapProvider
  readonly provider: FakeProvider
  readonly engine: ISettingsStoreProvider
}

/**
 * Boot the real addon. `providerRegistered: false` reproduces the window
 * before the `remote-storage` runner has come up (and the permanent state of
 * one that never will).
 */
async function boot(options: {
  readonly seedRows?: readonly SettingsRecord[]
  /** Reuse a previous boot's engine so what was PERSISTED is what is re-read. */
  readonly engine?: ISettingsStoreProvider
  readonly providerRegistered: boolean
}): Promise<Harness> {
  const provider = makeProvider()
  const engine = options.engine ?? makeEngine(options.seedRows ?? [])
  const collections: Record<string, readonly unknown[]> = {
    'storage-provider': options.providerRegistered ? [provider.impl] : [],
    'data-store-provider': [engine],
    'storage-evictable': [],
  }
  const ctx = {
    logger: makeLogger(),
    nodeDataDir: '/tmp/camstack-test-data',
    kernel: {
      localNodeId: 'hub',
      capabilityRegistry: {
        getCollection: (name: string): readonly unknown[] => collections[name] ?? [],
      },
      listStorageLocationDeclarations: (): readonly (readonly StorageLocationDeclaration[])[] => [
        DECLARATIONS,
      ],
    },
  }
  const addon = new StorageOrchestratorAddon()
  // Documented type boundary: `AddonContext` is the kernel's full injection
  // surface; the orchestrator reads the five fields assembled above.
  const result = await addon.initialize(ctx as unknown as AddonContext)
  const registrations =
    result && 'providers' in result && result.providers ? result.providers : undefined
  const entry = registrations?.find((r) => r.capability.name === storageCapability.name)
  if (!entry) throw new Error('storage capability was not registered')
  // Documented type boundary: the registration erases the provider type.
  return { addon, storage: entry.provider as IStorageCapProvider, provider, engine }
}

/** The row a previous boot persisted, as `location-store.ts` writes it. */
function storedRow(
  config: Readonly<Record<string, unknown>>,
  overrides: { readonly id?: string; readonly providerId?: string } = {},
): SettingsRecord {
  const id = overrides.id ?? LOCATION_ID
  return {
    id,
    data: {
      id,
      type: 'backups',
      display_name: 'Unraid backup share',
      provider_id: overrides.providerId ?? PROVIDER_ID,
      config: { ...config },
      is_default: 0,
      is_system: 0,
      created_at: 1,
      updated_at: 1,
    },
  }
}

const STORED_CONFIG = {
  host: 'nas.local',
  share: 'backup',
  username: 'camstack',
  password: REAL_PASSWORD,
  basePath: 'camstack',
}

describe('the storage cap surface never hands a credential to a caller', () => {
  let harness: Harness | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await harness?.addon.shutdown()
    harness = null
    vi.useRealTimers()
  })

  it('redacts the password on listLocations — the surface every authenticated session reads', async () => {
    harness = await boot({ seedRows: [storedRow(STORED_CONFIG)], providerRegistered: true })
    const rows = await harness.storage.listLocations({})
    const row = rows.find((l) => l.id === LOCATION_ID)
    expect(row).toBeDefined()
    expect(row?.config['password']).toBe(REDACTED_SECRET)
    expect(JSON.stringify(rows)).not.toContain(REAL_PASSWORD)
    // The non-credential fields still travel — a redaction that blanked the
    // whole config would break the Data screen and the backup destinations
    // table, which is a worse trade than the leak.
    expect(row?.config['host']).toBe('nas.local')
    expect(row?.config['basePath']).toBe('camstack')
  })

  // Deleted (D383): "redacts the password on getDefaultLocation too" — the
  // `storage.getDefaultLocation` cap method is retired along with the default
  // flag; there is no per-type single-location read left on the cap surface.
  // `listLocations({ type })` is the replacement read path and it goes
  // through the SAME `this.redacted(...)` call, covered above.

  it('redacts the password on the record upsertLocation echoes back', async () => {
    harness = await boot({ seedRows: [storedRow(STORED_CONFIG)], providerRegistered: true })
    const saved = await harness.storage.upsertLocation({
      id: LOCATION_ID,
      type: 'backups',
      displayName: 'Unraid backup share',
      providerId: PROVIDER_ID,
      config: { ...STORED_CONFIG, password: REDACTED_SECRET },
      isSystem: false,
    })
    expect(saved.config['password']).toBe(REDACTED_SECRET)
    expect(JSON.stringify(saved)).not.toContain(REAL_PASSWORD)
  })
})

describe('the operator edit round trip', () => {
  let harness: Harness | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await harness?.addon.shutdown()
    harness = null
    vi.useRealTimers()
  })

  /**
   * The load-bearing test. This is `EditLocationModal` verbatim: it seeds its
   * form state from what `listLocations` returned, the operator changes the
   * display name, and `handleSave` posts that whole object back. Nothing here
   * knows the password exists.
   */
  it('renaming a location leaves the share still authenticating', async () => {
    harness = await boot({ seedRows: [storedRow(STORED_CONFIG)], providerRegistered: true })

    // 1. read — this is what the modal is handed
    const before = (await harness.storage.listLocations({})).find((l) => l.id === LOCATION_ID)
    expect(before).toBeDefined()
    if (!before) throw new Error('unreachable')

    // 2. change ONE unrelated field, exactly as the modal does
    await harness.storage.upsertLocation({
      id: before.id,
      type: before.type,
      displayName: 'Unraid — nightly',
      providerId: before.providerId,
      config: before.config,
      isSystem: before.isSystem,
    })

    // 3. read again — the rename landed, the secret is still hidden
    const after = (await harness.storage.listLocations({})).find((l) => l.id === LOCATION_ID)
    expect(after?.displayName).toBe('Unraid — nightly')
    expect(after?.config['password']).toBe(REDACTED_SECRET)

    // 4. and the secret STILL WORKS — asserted at the provider, because the
    //    only question that matters is whether the share authenticates.
    const result = await harness.storage.testLocation({ id: LOCATION_ID })
    expect(result).toEqual({ ok: true })
    expect(harness.provider.seenConfigs.at(-1)?.['password']).toBe(REAL_PASSWORD)
  })

  it('an empty string CLEARS the password — "leave it" and "clear it" stay distinct', async () => {
    harness = await boot({ seedRows: [storedRow(STORED_CONFIG)], providerRegistered: true })
    const before = (await harness.storage.listLocations({})).find((l) => l.id === LOCATION_ID)
    if (!before) throw new Error('unreachable')

    await harness.storage.upsertLocation({
      id: before.id,
      type: before.type,
      displayName: before.displayName,
      providerId: before.providerId,
      config: { ...before.config, password: '' },
      isSystem: before.isSystem,
    })

    await harness.storage.testLocation({ id: LOCATION_ID })
    expect(harness.provider.seenConfigs.at(-1)?.['password']).toBe('')
  })

  it('a newly typed password replaces the stored one', async () => {
    harness = await boot({ seedRows: [storedRow(STORED_CONFIG)], providerRegistered: true })
    const before = (await harness.storage.listLocations({})).find((l) => l.id === LOCATION_ID)
    if (!before) throw new Error('unreachable')

    await harness.storage.upsertLocation({
      id: before.id,
      type: before.type,
      displayName: before.displayName,
      providerId: before.providerId,
      config: { ...before.config, password: 'a-new-fixture-password' },
      isSystem: before.isSystem,
    })

    await harness.storage.testLocation({ id: LOCATION_ID })
    expect(harness.provider.seenConfigs.at(-1)?.['password']).toBe('a-new-fixture-password')
  })
})

describe('the Test button on an existing location', () => {
  let harness: Harness | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await harness?.addon.shutdown()
    harness = null
    vi.useRealTimers()
  })

  /**
   * `EditLocationModal.handleTest` posts the form's CURRENT config — which
   * holds the sentinel for every untouched secret — to `storage.testConfig`.
   * Without a `locationId` the orchestrator has nothing to resolve the
   * sentinel against, so the provider is handed the literal
   * `__camstack_redacted__` and answers "authentication failed". That tells an
   * operator their credential is wrong when it is not, which is the same
   * confused-operator outcome as destroying it, minus the outage.
   */
  it('resolves the sentinel against the stored location before testing', async () => {
    harness = await boot({ seedRows: [storedRow(STORED_CONFIG)], providerRegistered: true })
    const before = (await harness.storage.listLocations({})).find((l) => l.id === LOCATION_ID)
    if (!before) throw new Error('unreachable')

    const result = await harness.storage.testConfig({
      providerId: PROVIDER_ID,
      locationId: LOCATION_ID,
      config: { ...before.config, basePath: 'camstack/nightly' },
    })
    expect(result).toEqual({ ok: true })
    expect(harness.provider.seenConfigs.at(-1)?.['password']).toBe(REAL_PASSWORD)
    // The edited field still reaches the provider — this is a preflight of the
    // UNSAVED form, not a re-run of `testLocation`.
    expect(harness.provider.seenConfigs.at(-1)?.['basePath']).toBe('camstack/nightly')
  })

  /**
   * `testConfig` is `auth: 'admin'`, but "resolve this sentinel from whichever
   * row I name" would still be a credential-borrowing primitive: point it at
   * another location and choose a provider that reports what it was given.
   * The stored config is consulted only when the named row belongs to the
   * SAME provider.
   */
  it('refuses to resolve a sentinel against a location of a different provider', async () => {
    harness = await boot({
      seedRows: [
        storedRow(STORED_CONFIG),
        storedRow(
          { host: 'other.local', password: 'a-different-fixture-secret' },
          { id: 'backups:sftp', providerId: 'sftp-storage' },
        ),
      ],
      providerRegistered: true,
    })

    const result = await harness.storage.testConfig({
      providerId: PROVIDER_ID,
      locationId: 'backups:sftp',
      config: { host: 'nas.local', password: REDACTED_SECRET },
    })
    expect(result.ok).toBe(false)
    const seen = harness.provider.seenConfigs.at(-1)
    expect(seen?.['password']).toBeUndefined()
    expect(JSON.stringify(seen)).not.toContain('a-different-fixture-secret')
  })

  it('leaves a wizard call with no locationId exactly as the operator typed it', async () => {
    harness = await boot({ seedRows: [], providerRegistered: true })
    const result = await harness.storage.testConfig({
      providerId: PROVIDER_ID,
      config: { host: 'nas.local', share: 'backup', password: REAL_PASSWORD },
    })
    expect(result).toEqual({ ok: true })
  })
})

describe('a location whose provider has not registered', () => {
  let harness: Harness | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await harness?.addon.shutdown()
    harness = null
    vi.useRealTimers()
  })

  /**
   * Redaction reads the provider's own `configSchema`, so a provider that has
   * not registered contributes no secret keys. `listLocations` needs no
   * provider at all — it reads the store and statfs's — so the row is served
   * either way. The gap is the boot window on every hub restart, and it is
   * PERMANENT for a `remote-storage` runner the CrashSupervisor marked failed.
   */
  it('withholds every provider-owned value rather than guessing which one is the credential', async () => {
    harness = await boot({ seedRows: [storedRow(STORED_CONFIG)], providerRegistered: false })
    const row = (await harness.storage.listLocations({})).find((l) => l.id === LOCATION_ID)
    expect(row).toBeDefined()
    expect(JSON.stringify(row)).not.toContain(REAL_PASSWORD)
    expect(row?.config['password']).toBe(REDACTED_SECRET)
    // `username` is a credential half and this provider's schema is unreadable,
    // so it is withheld too.
    expect(row?.config['username']).toBe(REDACTED_SECRET)
    // The four keys the ORCHESTRATOR itself owns and reads survive, so the
    // Data screen, the capacity guard and the recorder's root resolution keep
    // working while the provider is down.
    expect(row?.config['basePath']).toBe('camstack')
  })

  /**
   * Fail-closed must not become the destructive path. Withholding by sentinel
   * (rather than by deletion) is what makes the round trip non-destructive
   * even in the degraded state.
   */
  it('and a save in that state still does not destroy anything', async () => {
    harness = await boot({ seedRows: [storedRow(STORED_CONFIG)], providerRegistered: false })
    const before = (await harness.storage.listLocations({})).find((l) => l.id === LOCATION_ID)
    if (!before) throw new Error('unreachable')

    const saved = await harness.storage.upsertLocation({
      id: before.id,
      type: before.type,
      displayName: 'Renamed while the provider was down',
      providerId: before.providerId,
      config: before.config,
      isSystem: before.isSystem,
    })
    expect(saved.displayName).toBe('Renamed while the provider was down')

    // Once the runner comes back the share must still authenticate — asserted
    // against the row THIS degraded save persisted, re-read through the same
    // engine. Seeding a fresh row here would prove nothing.
    const engine = harness.engine
    await harness.addon.shutdown()
    harness = await boot({ engine, providerRegistered: true })
    const revived = (await harness.storage.listLocations({})).find((l) => l.id === LOCATION_ID)
    expect(revived?.displayName).toBe('Renamed while the provider was down')
    const result = await harness.storage.testLocation({ id: LOCATION_ID })
    expect(result).toEqual({ ok: true })
    expect(harness.provider.seenConfigs.at(-1)?.['password']).toBe(REAL_PASSWORD)
  })
})
