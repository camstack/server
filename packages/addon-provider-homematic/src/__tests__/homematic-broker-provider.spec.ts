import { it, expect, vi } from 'vitest'
import { buildHmBrokerProvider, type HmBrokerProviderDeps } from '../homematic-broker-provider.js'
import type { HmBrokerEntry, HomematicConfig } from '../config.js'
import type { HmBrokerInfo } from '../homematic-integration-manager.js'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_CONN: HomematicConfig = {
  host: 'ccu.local',
  enableHmipRf: true,
  enableBidcosRf: false,
  enableGroups: true,
  enableBidcosWired: false,
  username: 'admin',
  password: 'secret',
  callbackHost: '192.168.10.10',
  callbackPort: 2128,
  tls: false,
}

const REDACTED_CONN = { ...BASE_CONN, password: '' }

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
  withTags: vi.fn(),
}

// ---------------------------------------------------------------------------
// Fake registry
// ---------------------------------------------------------------------------

type FakeRegistryEntry = {
  entry: HmBrokerEntry
  info: HmBrokerInfo
}

function makeInfo(
  entry: HmBrokerEntry,
  status: HmBrokerInfo['status'] = 'connected',
): HmBrokerInfo {
  return {
    id: entry.id,
    name: entry.name,
    kind: 'homematic',
    status,
    info: {},
    lastCheckedAt: 1000,
    error: null,
  }
}

function makeFakeRegistry(initial: FakeRegistryEntry[] = []) {
  const store: FakeRegistryEntry[] = [...initial]
  let nextNum = initial.length + 1

  return {
    list: (): HmBrokerInfo[] => store.map((e) => e.info),
    get: (id: string): HmBrokerInfo | null => store.find((e) => e.entry.id === id)?.info ?? null,
    createEntry: vi.fn(
      async (name: string, connection: HomematicConfig): Promise<HmBrokerEntry> => {
        const id = `hm_${String(nextNum).padStart(3, '0')}`
        nextNum++
        const entry: HmBrokerEntry = { id, name, connection }
        store.push({ entry, info: makeInfo(entry) })
        return entry
      },
    ),
    removeEntry: vi.fn(async (id: string): Promise<void> => {
      const idx = store.findIndex((e) => e.entry.id === id)
      if (idx !== -1) store.splice(idx, 1)
    }),
    updateEntry: vi.fn(async (id: string, connection: HomematicConfig): Promise<HmBrokerEntry> => {
      const item = store.find((e) => e.entry.id === id)
      if (!item) throw new Error(`unknown broker id "${id}"`)
      item.entry = { ...item.entry, connection }
      item.info = makeInfo(item.entry, item.info.status)
      return item.entry
    }),
    size: (): number => store.length,
    connectedCount: (): number => store.filter((e) => e.info.status === 'connected').length,
  }
}

// ---------------------------------------------------------------------------
// Dep builder
// ---------------------------------------------------------------------------

function makeDeps(
  overrides: Partial<HmBrokerProviderDeps> = {},
): HmBrokerProviderDeps & { brokers: HmBrokerEntry[]; cascadeCalls: string[] } {
  const brokers: HmBrokerEntry[] = []
  const cascadeCalls: string[] = []

  const defaults: HmBrokerProviderDeps = {
    ownerAddonId: 'addon-provider-homematic',
    registry: makeFakeRegistry(),
    getBrokers: () => brokers,
    persistBrokers: vi.fn(async (next: readonly HmBrokerEntry[]) => {
      brokers.splice(0, brokers.length, ...next)
    }),
    cascadeRemoveDevices: vi.fn(async (brokerId: string) => {
      cascadeCalls.push(brokerId)
    }),
    logger,
  }

  return { ...defaults, ...overrides, brokers, cascadeCalls }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it('add → list → get round-trip works', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  const result = await provider.add({ kind: 'homematic', name: 'MyCCU', settings: BASE_CONN })
  expect(typeof result.id).toBe('string')
  expect(result.id.length).toBeGreaterThan(0)

  const listed = await provider.list({})
  expect(listed).toHaveLength(1)
  expect(listed[0]?.name).toBe('MyCCU')
  expect(listed[0]?.addonId).toBe('addon-provider-homematic')
  expect(listed[0]?.kind).toBe('homematic')

  const fetched = await provider.get({ id: result.id })
  expect(fetched?.id).toBe(result.id)
  expect(fetched?.addonId).toBe('addon-provider-homematic')
})

it('remove calls cascadeRemoveDevices and drops the broker', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  const { id } = await provider.add({ kind: 'homematic', name: 'CCU', settings: BASE_CONN })
  expect(deps.brokers).toHaveLength(1)

  await provider.remove({ id })

  expect(deps.cascadeCalls).toContain(id)
  expect(deps.brokers).toHaveLength(0)

  const listed = await provider.list({})
  expect(listed).toHaveLength(0)
})

it('remove is a no-op for unknown ids (does not throw)', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  await expect(provider.remove({ id: 'hm_999' })).resolves.toBeUndefined()
  expect(deps.cascadeCalls).toHaveLength(0)
})

it('add rejects non-homematic kind', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  await expect(provider.add({ kind: 'mqtt', name: 'Broker', settings: {} })).rejects.toThrow(
    "only kind 'homematic' is handled here",
  )
})

it('getSettingsSchema returns a schema for homematic kind and null otherwise', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  const schema = await provider.getSettingsSchema({ kind: 'homematic' })
  expect(schema).not.toBeNull()
  // The schema is a ConfigUISchema — check it has at least a sections array.
  expect((schema as { sections: unknown[] }).sections).toBeInstanceOf(Array)

  const other = await provider.getSettingsSchema({ kind: 'mqtt' })
  expect(other).toBeNull()
})

it('getSettings redacts the password', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  const { id } = await provider.add({ kind: 'homematic', name: 'CCU', settings: BASE_CONN })
  const settings = await provider.getSettings({ id })

  expect(settings).not.toBeNull()
  expect(settings?.['password']).toBe('')
  // Other fields are preserved.
  expect(settings?.['host']).toBe(BASE_CONN.host)
})

it('getSettings returns null for unknown id', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  const result = await provider.getSettings({ id: 'hm_999' })
  expect(result).toBeNull()
})

it('setSettings with empty password preserves the stored password', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  const { id } = await provider.add({ kind: 'homematic', name: 'CCU', settings: BASE_CONN })

  // Simulate a round-trip with the redacted (empty) password.
  await provider.setSettings({ id, settings: REDACTED_CONN })

  // The stored entry should keep the original secret.
  const stored = deps.brokers.find((b) => b.id === id)
  expect(stored?.connection.password).toBe('secret')
})

it('setSettings with a non-empty password updates the stored password', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  const { id } = await provider.add({ kind: 'homematic', name: 'CCU', settings: BASE_CONN })
  await provider.setSettings({ id, settings: { ...BASE_CONN, password: 'newpass' } })

  const stored = deps.brokers.find((b) => b.id === id)
  expect(stored?.connection.password).toBe('newpass')
})

it('setSettings is a no-op for unknown ids', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  await expect(provider.setSettings({ id: 'hm_999', settings: BASE_CONN })).resolves.toBeUndefined()
})

it('getStatus returns brokerCount and connectedCount', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  await provider.add({ kind: 'homematic', name: 'A', settings: BASE_CONN })
  await provider.add({ kind: 'homematic', name: 'B', settings: { ...BASE_CONN, host: 'b.local' } })

  const status = await provider.getStatus()
  expect(status.brokerCount).toBe(2)
  expect(typeof status.connectedCount).toBe('number')
})

it('list filters by kind — non-homematic kind returns empty array', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  await provider.add({ kind: 'homematic', name: 'CCU', settings: BASE_CONN })
  const listed = await provider.list({ kind: 'mqtt' })
  expect(listed).toHaveLength(0)
})

it('listProviders returns the homematic kind with correct addonId', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  const providers = await provider.listProviders()
  expect(providers).toHaveLength(1)
  expect(providers[0]?.addonId).toBe('addon-provider-homematic')
  expect(providers[0]?.kinds).toEqual([{ kind: 'homematic', label: 'Homematic' }])
})

it('testSettings returns ok:true for valid homematic settings', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  const result = await provider.testSettings({ kind: 'homematic', settings: BASE_CONN })
  expect(result).toEqual({ ok: true })
})

it('testSettings returns ok:false for non-homematic kind', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  const result = await provider.testSettings({ kind: 'mqtt', settings: {} })
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error).toContain('unsupported kind')
  }
})

it('testSettings returns ok:false for invalid settings (missing required host)', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  const result = await provider.testSettings({
    kind: 'homematic',
    settings: { host: '', enableHmipRf: true },
  })
  expect(result.ok).toBe(false)
})

it('pub/sub no-ops return safe values without throwing', async () => {
  const deps = makeDeps()
  const provider = buildHmBrokerProvider(deps)

  const pub = await provider.publish({
    brokerId: 'hm_001',
    target: { topic: 'test' },
  })
  expect(pub).toBeNull()

  const sub = await provider.subscribe({ brokerId: 'hm_001', filter: { topic: 'test' } })
  expect(sub).toHaveProperty('subscriptionId')
  expect(typeof sub.subscriptionId).toBe('string')

  const unsub = await provider.unsubscribe({
    brokerId: 'hm_001',
    subscriptionId: sub.subscriptionId,
  })
  expect(unsub).toBeUndefined()

  const state = await provider.getState({ brokerId: 'hm_001', key: 'whatever' })
  expect(state).toBeNull()
})
