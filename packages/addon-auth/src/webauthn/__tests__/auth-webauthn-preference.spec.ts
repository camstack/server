/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- test harness mocks values across typed boundaries (AddonContext stubs). Pre-existing pattern in this project (mirrors the discoverable spec). */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// `@simplewebauthn/server` mocked at module level — the preference
// surface never touches it, but the addon module imports it at load.
const swanMock = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}))
vi.mock('@simplewebauthn/server', () => swanMock)

import { AuthWebauthnAddon } from '../auth-webauthn.addon.js'
import { makeInMemoryRecords } from '@camstack/types'
import { authWebauthnRecordKinds } from '../record-kinds.js'
import { makeWebauthnTestRecords } from './webauthn-test-records.js'
import type {
  AddonContext,
  IScopedLogger,
  IUserPasskeysProvider,
  RecordsAccess,
} from '@camstack/types'

// ---------------------------------------------------------------------------
// Test harness — minimal AddonContext stub + in-memory settings-store.
// Extends the discoverable spec's mock with the KV-style `get`/`set`
// surface the preference store uses (structured upsert-by-key).
// ---------------------------------------------------------------------------

interface StoredRow {
  readonly id: string
  readonly data: Record<string, unknown>
}

interface SettingsStoreMock {
  readonly rows: Map<string, StoredRow>
  /** Per-collection keyed values written through `set`. */
  readonly kv: Map<string, Map<string, unknown>>
  readonly declareCollection: { mutate: ReturnType<typeof vi.fn> }
  readonly insert: { mutate: ReturnType<typeof vi.fn> }
  readonly query: { query: ReturnType<typeof vi.fn> }
  readonly update: { mutate: ReturnType<typeof vi.fn> }
  readonly delete: { mutate: ReturnType<typeof vi.fn> }
  readonly get: { query: ReturnType<typeof vi.fn> }
  readonly set: { mutate: ReturnType<typeof vi.fn> }
}

function makeSettingsStore(): SettingsStoreMock {
  const rows = new Map<string, StoredRow>()
  const kv = new Map<string, Map<string, unknown>>()
  const bucket = (collection: string): Map<string, unknown> => {
    const existing = kv.get(collection)
    if (existing) return existing
    const created = new Map<string, unknown>()
    kv.set(collection, created)
    return created
  }
  return {
    rows,
    kv,
    declareCollection: { mutate: vi.fn(async () => undefined) },
    insert: {
      mutate: vi.fn(async (input: { record: StoredRow }) => {
        rows.set(input.record.id, input.record)
      }),
    },
    query: {
      query: vi.fn(async (input: { filter?: { where?: Record<string, unknown> } }) => {
        const where = input.filter?.where ?? {}
        return [...rows.values()].filter((r) =>
          Object.entries(where).every(([k, v]) => r.data[k] === v),
        )
      }),
    },
    update: {
      mutate: vi.fn(async (input: { id: string; data: Record<string, unknown> }) => {
        rows.set(input.id, { id: input.id, data: input.data })
      }),
    },
    delete: { mutate: vi.fn(async (input: { key: string }) => rows.delete(input.key)) },
    get: {
      query: vi.fn(async (input: { collection: string; key: string }) =>
        bucket(input.collection).get(input.key),
      ),
    },
    set: {
      mutate: vi.fn(async (input: { collection: string; key: string; value: unknown }) => {
        bucket(input.collection).set(input.key, input.value)
      }),
    },
  }
}

function makeLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

function makeCtx(store: SettingsStoreMock): AddonContext {
  const settings = {
    readAddonStore: vi.fn(async () => ({})),
    writeAddonStore: vi.fn(async () => undefined),
    readDeviceStore: vi.fn(async () => ({})),
    writeDeviceStore: vi.fn(async () => undefined),
    getSection: vi.fn(async () => ({})),
    setSection: vi.fn(async () => undefined),
  }
  return {
    id: 'auth-webauthn',
    logger: makeLogger(),
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir: '/tmp/webauthn-test',
    nodeDataDir: '/tmp',
    kernel: { localNodeId: 'hub', devices: {} as never },
    settings,
    api: { settingsStore: store } as never,
    capabilities: {
      get: vi.fn(() => undefined),
      getCollection: vi.fn(() => undefined),
      getCollectionEntries: vi.fn(() => undefined),
    },
    deps: {} as never,
    useCapability: vi.fn(),
    acquireCapability: vi.fn(),
    onCapabilityStateChange: vi.fn(),
  } as unknown as AddonContext
}

async function bootAddon(
  store: SettingsStoreMock,
  records?: RecordsAccess,
): Promise<IUserPasskeysProvider> {
  const rec = records ?? (await makeWebauthnTestRecords())
  const ctx = makeCtx(store)
  const addon = new AuthWebauthnAddon()
  const result = await addon.initialize({ ...ctx, records: rec })
  const list: ReadonlyArray<{ capability: { name: string }; provider: unknown }> = Array.isArray(
    result,
  )
    ? result
    : ((result as any)?.providers ?? [])
  const registration = list.find((r) => r.capability.name === 'user-passkeys')
  if (!registration) throw new Error('user-passkeys provider not registered')
  return registration.provider as IUserPasskeysProvider
}

describe('user-passkeys second-factor preference', () => {
  let store: SettingsStoreMock
  let records: RecordsAccess
  let provider: IUserPasskeysProvider

  beforeEach(async () => {
    vi.clearAllMocks()
    store = makeSettingsStore()
    records = await makeWebauthnTestRecords()
    provider = await bootAddon(store, records)
  })

  it('defaults to disabled when no preference was ever set', async () => {
    const result = await provider.getSecondFactorPreference({ userId: 'u-1' })
    expect(result).toEqual({ enabled: false })
  })

  it('round-trips enable → get → disable → get', async () => {
    const set = await provider.setSecondFactorPreference({ userId: 'u-1', enabled: true })
    expect(set).toEqual({ success: true })
    await expect(provider.getSecondFactorPreference({ userId: 'u-1' })).resolves.toEqual({
      enabled: true,
    })

    await provider.setSecondFactorPreference({ userId: 'u-1', enabled: false })
    await expect(provider.getSecondFactorPreference({ userId: 'u-1' })).resolves.toEqual({
      enabled: false,
    })
  })

  it('persists the preference through the settings store (survives a re-boot)', async () => {
    await provider.setSecondFactorPreference({ userId: 'u-1', enabled: true })
    // Fresh addon instance over the SAME records world — mirrors a runner respawn.
    const rebooted = await bootAddon(store, records)
    await expect(rebooted.getSecondFactorPreference({ userId: 'u-1' })).resolves.toEqual({
      enabled: true,
    })
  })

  it('keeps preferences independent per user', async () => {
    await provider.setSecondFactorPreference({ userId: 'u-1', enabled: true })
    await expect(provider.getSecondFactorPreference({ userId: 'u-2' })).resolves.toEqual({
      enabled: false,
    })
  })

  it('treats a malformed stored value as disabled (fail-safe)', async () => {
    const world = makeInMemoryRecords('auth-webauthn')
    await world.records.declare(authWebauthnRecordKinds)
    const isolated = await bootAddon(makeSettingsStore(), world.records)
    await isolated.setSecondFactorPreference({ userId: 'u-1', enabled: true })
    world.seed('passkey-prefs', { id: 'u-1', data: { bogus: 'shape' } })
    await expect(isolated.getSecondFactorPreference({ userId: 'u-1' })).resolves.toEqual({
      enabled: false,
    })
  })
})
