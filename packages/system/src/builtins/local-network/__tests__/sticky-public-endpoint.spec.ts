/**
 * The automatic `publicEndpoint` is sticky (D1085): once it resolved to the tunnel it keeps
 * answering that address while the tunnel's row is absent (boot, a restarting tunnel), until the
 * integration that supplied it is removed. A flag always wins; a LAN-only hub is unchanged; a
 * read of the integration list that failed never clears the memory (D49).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ILocalNetworkProvider, IScopedLogger, NetworkAccessStatus } from '@dominevo/types'
import { EventCategory } from '@dominevo/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeMigrationsApi } from './migrations-api.js'
import { stubAddonContext } from './addon-context-stub.js'
import { LocalNetworkAddon } from '../local-network.addon.js'

vi.mock('../hub-mdns-ciao.js', () => ({
  createCiaoPublisher: () => ({ publish: async () => ({ stop: async () => undefined }) }),
}))

const TUNNEL = 'https://hub.example-tunnel.test'
const ADDON = 'cloudflare-tunnel'

function makeLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

type Handler = (event: {
  readonly data: unknown
  readonly source: { readonly type: string; readonly id: string }
}) => void

interface Harness {
  readonly provider: ILocalNetworkProvider
  readonly store: Record<string, unknown>
  readonly tunnelStarted: () => void
}

type IntegrationRows = () => Promise<readonly { readonly id: string }[]>

async function boot(
  dir: string,
  store: Record<string, unknown>,
  rows: IntegrationRows,
): Promise<Harness> {
  const handlers = new Map<string, Handler>()
  const noTunnel: NetworkAccessStatus = { connected: false, endpoint: null }
  const ctx = stubAddonContext({
    id: 'local-network',
    logger: makeLogger(),
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn((filter: { category: string }, handler: Handler) => {
        handlers.set(filter.category, handler)
        return () => undefined
      }),
    },
    addonConfig: {},
    dataDir: dir,
    kernel: { localNodeId: 'hub' },
    api: {
      ...makeMigrationsApi(),
      networkAccess: { getStatus: { query: vi.fn(async () => noTunnel) } },
      integrations: { listByAddon: { query: vi.fn(rows) } },
    },
    settings: {
      readAddonStore: vi.fn(async () => ({ ...store })),
      writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(store, patch)
      }),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({ port: 4443 })),
      setSection: vi.fn(async () => undefined),
    },
  })
  const result = await new LocalNetworkAddon().initialize(ctx)
  const registrations = result && 'providers' in result && result.providers ? result.providers : []
  const registered = registrations.find((r) => r.capability.name === 'local-network')
  if (registered === undefined) throw new Error('local-network provider not registered')
  // Documented type boundary: the registration carries the provider untyped.
  const provider = registered.provider as ILocalNetworkProvider
  return {
    provider,
    store,
    tunnelStarted: () =>
      handlers.get(EventCategory.NetworkTunnelStarted)?.({
        data: { url: TUNNEL },
        source: { type: 'addon', id: ADDON },
      }),
  }
}

async function publicRole(provider: ILocalNetworkProvider) {
  return (await provider.getAddresses({ scheme: 'https' })).roles.publicEndpoint
}

const exists: IntegrationRows = async () => [{ id: 'row-1' }]
const REMEMBERED = {
  rememberedPublicEndpointUrl: TUNNEL,
  rememberedPublicEndpointAddon: ADDON,
}

describe('sticky automatic publicEndpoint', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-network-sticky-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('remembers the tunnel when automatic resolves to it', async () => {
    const h = await boot(dir, { 'httpEnabled@hub': false }, exists)
    h.tunnelStarted()
    expect((await publicRole(h.provider)).resolved).toBe(TUNNEL)
    expect(h.store['rememberedPublicEndpointUrl']).toBe(TUNNEL)
    expect(h.store['rememberedPublicEndpointAddon']).toBe(ADDON)
  })

  it('(a) boot with the tunnel row absent and a remembered pick resolves to the tunnel', async () => {
    const h = await boot(dir, { 'httpEnabled@hub': false, ...REMEMBERED }, exists)
    const role = await publicRole(h.provider)
    expect(role.resolved).toBe(TUNNEL)
    expect(role.source).toBe('auto-remembered')
  })

  it('(b) the integration removed: live automatic, the memory cleared', async () => {
    const h = await boot(dir, { 'httpEnabled@hub': false, ...REMEMBERED }, async () => [])
    const role = await publicRole(h.provider)
    expect(role.resolved).not.toBe(TUNNEL)
    expect(role.source).not.toBe('auto-remembered')
    expect(h.store['rememberedPublicEndpointUrl']).toBe('')
  })

  it('(c) a flag beats the memory', async () => {
    const flag = 'https://other.example.org'
    const h = await boot(
      dir,
      { 'httpEnabled@hub': false, publicEndpointUrl: flag, ...REMEMBERED },
      exists,
    )
    const role = await publicRole(h.provider)
    expect(role.resolved).toBe(flag)
    expect(role.source).toBe('flagged')
  })

  it('(d) a LAN-only hub is unchanged', async () => {
    const h = await boot(dir, { 'httpEnabled@hub': false }, exists)
    const role = await publicRole(h.provider)
    expect(role.source).not.toBe('auto-remembered')
    expect(role.resolved).not.toBe(TUNNEL)
    expect(h.store['rememberedPublicEndpointUrl'] ?? '').toBe('')
  })

  it('(e) an unreadable integration list keeps the memory', async () => {
    const h = await boot(dir, { 'httpEnabled@hub': false, ...REMEMBERED }, async () => {
      throw new Error('registry unavailable')
    })
    const role = await publicRole(h.provider)
    expect(role.resolved).toBe(TUNNEL)
    expect(role.source).toBe('auto-remembered')
    expect(h.store['rememberedPublicEndpointUrl']).toBe(TUNNEL)
  })
})
