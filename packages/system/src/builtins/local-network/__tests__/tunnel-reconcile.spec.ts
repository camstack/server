/**
 * local-network — the public tunnel hostname is pull-reconciled from `network-access.getStatus`
 * (the `NetworkTunnelStarted` event is lossy, D8/D49): a missed event no longer leaves the
 * `publicEndpoint` role on the LAN address.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ILocalNetworkProvider, IScopedLogger, NetworkAccessStatus } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeMigrationsApi } from './migrations-api.js'
import { stubAddonContext } from './addon-context-stub.js'
import { LocalNetworkAddon } from '../local-network.addon.js'

vi.mock('../hub-mdns-ciao.js', () => ({
  createCiaoPublisher: () => ({ publish: async () => ({ stop: async () => undefined }) }),
}))

const osInterfaces = vi.hoisted(() => vi.fn())
const realInterfaces = vi.hoisted(() => ({
  fn: () => ({}) as ReturnType<typeof import('node:os').networkInterfaces>,
}))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  osInterfaces.mockImplementation(actual.networkInterfaces)
  realInterfaces.fn = actual.networkInterfaces
  return {
    ...actual,
    default: { ...actual, networkInterfaces: osInterfaces },
    networkInterfaces: osInterfaces,
  }
})

const TUNNEL_HOST = 'hub.example-tunnel.test'

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

type StatusReader = () => Promise<NetworkAccessStatus>

async function start(dataDir: string, getStatus: StatusReader): Promise<ILocalNetworkProvider> {
  const store: Record<string, unknown> = { 'httpEnabled@hub': false }
  const ctx = stubAddonContext({
    id: 'local-network',
    logger: makeLogger(),
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir,
    kernel: { localNodeId: 'hub' },
    api: { ...makeMigrationsApi(), networkAccess: { getStatus: { query: vi.fn(getStatus) } } },
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
  return registered.provider as ILocalNetworkProvider
}

const connected = (stable: boolean): NetworkAccessStatus => ({
  connected: true,
  endpoint: {
    url: `https://${TUNNEL_HOST}`,
    hostname: TUNNEL_HOST,
    port: 443,
    protocol: 'https',
    stable,
  },
})

async function publicEndpoint(provider: ILocalNetworkProvider): Promise<string | null> {
  const book = await provider.getAddresses({ scheme: 'https' })
  return book.roles.publicEndpoint.resolved
}

describe('local-network tunnel hostname reconcile', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-network-tunnel-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    osInterfaces.mockImplementation(realInterfaces.fn)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a missed start event: a connected stable tunnel becomes the public endpoint', async () => {
    const provider = await start(dir, async () => connected(true))
    expect(await publicEndpoint(provider)).toContain(TUNNEL_HOST)
  })

  it('a failed read keeps the hostname already known', async () => {
    let fail = false
    const provider = await start(dir, async () => {
      if (fail) throw new Error('no provider')
      return connected(true)
    })
    expect(await publicEndpoint(provider)).toContain(TUNNEL_HOST)
    fail = true
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60_000)
    expect(await publicEndpoint(provider)).toContain(TUNNEL_HOST)
  })

  it('a disconnected tunnel clears the hostname', async () => {
    // Pin the host: with no LAN interface (a CI container) the cleared role resolves to null,
    // with one it falls back to the LAN address. Either way the tunnel host must be gone; the
    // empty set makes the null branch the one this spec always exercises.
    osInterfaces.mockReturnValue({})
    let up = true
    const provider = await start(dir, async () =>
      up ? connected(true) : { connected: false, endpoint: null },
    )
    expect(await publicEndpoint(provider)).toContain(TUNNEL_HOST)
    up = false
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60_000)
    expect(await publicEndpoint(provider)).toBeNull()
  })
})
