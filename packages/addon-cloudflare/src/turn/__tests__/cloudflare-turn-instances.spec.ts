/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import {
  type IIntegrationInstancesProvider,
  integrationInstancesCapability,
  makeInMemoryRecords,
  turnProviderCapability,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudflareTurnAddon } from '../cloudflare-turn.addon.js'
import {
  CLOUDFLARE_TURN_RECORD_ID,
  type CloudflareTurnBody,
  cloudflareTurnAccountsKind,
} from '../turn-record-kinds.js'

function logger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

const ICE = {
  iceServers: { urls: ['turn:cf.test:3478'], username: 'u', credential: 'c' },
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(ICE), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

async function boot(seed: Omit<CloudflareTurnBody, 'name'> | null) {
  const world = makeInMemoryRecords('cloudflare-turn')
  await world.records.declare({ accounts: cloudflareTurnAccountsKind })
  const handle = world.records.kind(cloudflareTurnAccountsKind)
  if (seed !== null) {
    await handle.put(
      {
        id: CLOUDFLARE_TURN_RECORD_ID,
        data: { name: 'Cloudflare TURN', ...seed },
      },
      { ifRev: 0 },
    )
  }
  const ctx = {
    id: 'cloudflare-turn',
    logger: logger(),
    records: world.records,
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      readAddonStoreResult: vi.fn(async () => ({
        kind: 'value' as const,
        value: {},
      })),
      writeAddonStore: vi.fn(async () => undefined),
    },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    kernel: { localNodeId: 'hub' },
    api: {
      migrations: {
        declareOwner: {
          mutate: vi.fn(async () => ({
            bootId: 'b',
            snapshot: 'none',
            steps: [],
          })),
        },
        startMigration: { mutate: vi.fn() },
        finishMigration: { mutate: vi.fn() },
      },
    },
  } as unknown as AddonContext
  const addon = new CloudflareTurnAddon()
  const result = await addon.initialize(ctx)
  const registrations = result && 'providers' in result && result.providers ? result.providers : []
  const turn = registrations.find((r) => r.capability.name === turnProviderCapability.name)
  const instances = registrations.find(
    (r) => r.capability.name === integrationInstancesCapability.name,
  )
  if (turn === undefined) throw new Error('the addon registered no turn-provider')
  const provider = turn.provider as {
    getTurnServers(): Promise<readonly unknown[]>
  }
  return {
    addon,
    getTurnServers: async () => provider.getTurnServers(),
    instances: instances?.provider as IIntegrationInstancesProvider,
  }
}

const CONFIGURED = { keyId: 'KEY-1', apiToken: 'tok-SECRET' }

describe('CloudflareTurnAddon: the account is an integration instance (D996)', () => {
  const addons: CloudflareTurnAddon[] = []
  afterEach(async () => {
    for (const a of addons.splice(0)) await a.shutdown()
    vi.unstubAllGlobals()
  })

  it('describes itself as a multiple-instance addon that mints ids, with a connection test', async () => {
    const w = await boot(CONFIGURED)
    addons.push(w.addon)
    await expect(w.instances.describe()).resolves.toEqual({
      instanceMode: 'multiple',
      kind: 'accounts',
      canTest: true,
      mintsId: true,
    })
    expect((await w.instances.listInstances()).map((i) => i.id)).toEqual(['cloudflare-turn'])
  })

  it('serves ICE servers fetched with the record credentials; unconfigured fetches nothing', async () => {
    const w = await boot(CONFIGURED)
    addons.push(w.addon)
    expect(await w.getTurnServers()).toEqual([
      { urls: ['turn:cf.test:3478'], username: 'u', credential: 'c' },
    ])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/keys/KEY-1/credentials/generate-ice-servers')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-SECRET')

    const empty = await boot(null)
    addons.push(empty.addon)
    fetchMock.mockClear()
    expect(await empty.getTurnServers()).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a switched-off record serves nothing and asks nothing; switching it on serves again', async () => {
    const w = await boot(CONFIGURED)
    addons.push(w.addon)
    await w.instances.setInstanceEnabled({
      id: CLOUDFLARE_TURN_RECORD_ID,
      enabled: false,
    })
    fetchMock.mockClear()
    expect(await w.getTurnServers()).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    await w.instances.setInstanceEnabled({
      id: CLOUDFLARE_TURN_RECORD_ID,
      enabled: true,
    })
    expect(await w.getTurnServers()).toHaveLength(1)
  })

  it('a new token in the record reaches the next fetch', async () => {
    const w = await boot(CONFIGURED)
    addons.push(w.addon)
    await w.getTurnServers()
    fetchMock.mockClear()
    await w.instances.updateInstance({
      id: CLOUDFLARE_TURN_RECORD_ID,
      values: { keyId: 'KEY-2', apiToken: 'tok-NEW' },
    })
    await w.getTurnServers()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/keys/KEY-2/')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-NEW')
  })

  it('the token never leaves the record through the instance view', async () => {
    const w = await boot(CONFIGURED)
    addons.push(w.addon)
    expect(JSON.stringify(await w.instances.listInstances())).not.toContain('tok-SECRET')
    expect(
      JSON.stringify(await w.instances.getInstance({ id: CLOUDFLARE_TURN_RECORD_ID })),
    ).not.toContain('tok-SECRET')
  })

  it('testInstance wraps the credential probe, falling back to the stored token', async () => {
    const w = await boot(CONFIGURED)
    addons.push(w.addon)
    fetchMock.mockClear()
    const ok = await w.instances.testInstance?.({
      id: CLOUDFLARE_TURN_RECORD_ID,
      values: { keyId: 'KEY-TYPED' },
    })
    expect(ok).toMatchObject({ success: true, status: 'validated' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/keys/KEY-TYPED/')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-SECRET')

    fetchMock.mockImplementation(async () => new Response('nope', { status: 401 }))
    const bad = await w.instances.testInstance?.({
      id: CLOUDFLARE_TURN_RECORD_ID,
      values: {},
    })
    expect(bad).toMatchObject({ success: false })
    expect(JSON.stringify(bad)).not.toContain('tok-SECRET')
  })

  it('a second account is served next to the first; the new one asks with its own credentials', async () => {
    const w = await boot(CONFIGURED)
    addons.push(w.addon)
    const { id } = await w.instances.createInstance({ name: 'Second app' })
    expect(id).not.toBe(CLOUDFLARE_TURN_RECORD_ID)
    // The record keeps the id it had; the new one is served only once it is configured.
    fetchMock.mockClear()
    expect(await w.getTurnServers()).toHaveLength(1)
    await w.instances.updateInstance({
      id,
      values: { keyId: 'KEY-2', apiToken: 'tok-TWO' },
    })
    fetchMock.mockClear()
    expect(await w.getTurnServers()).toHaveLength(2)
    const askedWithOwnToken = fetchMock.mock.calls.some(([url, init]) => {
      const headers = new Headers(init?.headers)
      return (
        String(url).includes('/keys/KEY-2/') && headers.get('Authorization') === 'Bearer tok-TWO'
      )
    })
    expect(askedWithOwnToken).toBe(true)
    // Deleting the second leaves the first.
    await w.instances.deleteInstance({ id })
    expect(await w.getTurnServers()).toHaveLength(1)
  })
})
