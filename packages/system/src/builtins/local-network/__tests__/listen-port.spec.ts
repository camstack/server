/**
 * local-network — the hub's LISTEN PORT is the hub's fact.
 *
 * `getConnectionEndpoints` used to take a port from the caller and echo it onto
 * every LAN/loopback URL it advertised. A viewer configured with a port-less
 * public URL inferred 443 from `https:`, asked with 443, and was handed
 * `https://192.168.10.9:443` for a hub listening on 4443 — a candidate born dead.
 * These tests pin the correction: the port comes from the hub, the caller's
 * value is only a fallback hint, and the answer says which of the two it was.
 */
import { describe, it, expect, vi } from 'vitest'
import type { AddonContext, IScopedLogger, ILocalNetworkProvider } from '@camstack/types'
import { LocalNetworkAddon, resolveAdvertisedPort } from '../local-network.addon.js'

// The addon would start a real mDNS responder on the host; specs never do.
vi.mock('../hub-mdns-ciao.js', () => ({
  createCiaoPublisher: () => ({ publish: async () => ({ stop: async () => undefined }) }),
}))

// ── resolveAdvertisedPort ────────────────────────────────────────────

describe('resolveAdvertisedPort', () => {
  it('prefers the hub live `server.port` over every other source', () => {
    expect(resolveAdvertisedPort({ configured: 4443, env: 9000, callerHint: 443 })).toEqual({
      port: 4443,
      source: 'server-config',
    })
  })

  it('falls back to CAMSTACK_PORT when the config section is unreadable', () => {
    expect(resolveAdvertisedPort({ configured: null, env: 9000, callerHint: 443 })).toEqual({
      port: 9000,
      source: 'server-env',
    })
  })

  it("echoes the caller's hint only when the hub knows nothing about itself", () => {
    expect(resolveAdvertisedPort({ configured: null, env: null, callerHint: 443 })).toEqual({
      port: 443,
      source: 'caller-hint',
    })
  })

  it('falls back to the boot default when there is no hint either', () => {
    expect(resolveAdvertisedPort({ configured: null, env: null, callerHint: null })).toEqual({
      port: 4443,
      source: 'default',
    })
  })

  it('ignores out-of-range and non-integer values instead of advertising them', () => {
    expect(resolveAdvertisedPort({ configured: 0, env: 70_000, callerHint: 4443 })).toEqual({
      port: 4443,
      source: 'caller-hint',
    })
    expect(resolveAdvertisedPort({ configured: Number.NaN, env: 1.5, callerHint: null })).toEqual({
      port: 4443,
      source: 'default',
    })
  })
})

// ── the provider path ────────────────────────────────────────────────

interface CtxHarness {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
}

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

/**
 * Minimal hub-side context. `getSection('server')` is the ONE thing under test
 * here — it is the hub's live boot config (`CAMSTACK_PORT` is merged into it by
 * the boot loader), so a stub that answers it is a stub of the real authority.
 */
function makeCtx(serverSection: Record<string, unknown>): CtxHarness {
  const logger = makeLogger()
  const addonStore: Record<string, unknown> = {}
  // Documented type boundary: `AddonContext` is the kernel's full injection
  // surface; this suite exercises the two members the port path reads.
  const ctx = {
    id: 'local-network',
    logger,
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir: '/tmp/local-network-test',
    kernel: { localNodeId: 'hub' },
    settings: {
      readAddonStore: vi.fn(async () => ({ ...addonStore })),
      writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(addonStore, patch)
      }),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async (section: string) => (section === 'server' ? serverSection : {})),
      setSection: vi.fn(async () => undefined),
    },
  } as unknown as AddonContext
  return { ctx, logger }
}

async function startProvider(serverSection: Record<string, unknown>): Promise<{
  readonly provider: ILocalNetworkProvider
  readonly logger: IScopedLogger
}> {
  const addon = new LocalNetworkAddon()
  const { ctx, logger } = makeCtx(serverSection)
  const result = await addon.initialize(ctx)
  const providers = Array.isArray(result) ? result : (result?.providers ?? [])
  const registration = providers[0]
  if (!registration) throw new Error('local-network registered no provider')
  const provider = registration.provider
  if (!isLocalNetworkProvider(provider)) throw new Error('unexpected provider shape')
  return { provider, logger }
}

function isLocalNetworkProvider(value: unknown): value is ILocalNetworkProvider {
  return typeof value === 'object' && value !== null && 'getConnectionEndpoints' in value
}

describe('getConnectionEndpoints — the advertised port', () => {
  it("builds local URLs from the hub's own port, not the caller's", async () => {
    const { provider } = await startProvider({ port: 4443 })
    // 443 is exactly what a client infers from a port-less `https://` URL.
    const res = await provider.getConnectionEndpoints({
      port: 443,
      scheme: 'https',
      includeLoopback: true,
    })
    const loopback = res.endpoints.find((e) => e.kind === 'loopback')
    expect(loopback?.baseUrl).toBe('https://127.0.0.1:4443')
    for (const endpoint of res.endpoints) {
      if (endpoint.kind === 'public') continue
      expect(endpoint.baseUrl).not.toContain(':443/')
      expect(endpoint.baseUrl.endsWith(':443')).toBe(false)
    }
  })

  it('reports the port it used and where the number came from', async () => {
    const { provider } = await startProvider({ port: 4443 })
    const res = await provider.getConnectionEndpoints({ port: 443 })
    expect(res.localPort).toEqual({ port: 4443, source: 'server-config' })
  })

  it('works with no port at all — the caller need not know it', async () => {
    const { provider } = await startProvider({ port: 8443 })
    const res = await provider.getConnectionEndpoints({ includeLoopback: true })
    expect(res.localPort).toEqual({ port: 8443, source: 'server-config' })
    expect(res.endpoints.find((e) => e.kind === 'loopback')?.baseUrl).toBe('http://127.0.0.1:8443')
  })

  it('does not advertise loopback unless the caller asks', async () => {
    const { provider } = await startProvider({ port: 4443 })
    const res = await provider.getConnectionEndpoints({})
    expect(res.endpoints.find((e) => e.kind === 'loopback')).toBeUndefined()
  })

  it('logs the override instead of silently disagreeing with the caller', async () => {
    const { provider, logger } = await startProvider({ port: 4443 })
    await provider.getConnectionEndpoints({ port: 443 })
    const calls = vi.mocked(logger.info).mock.calls
    expect(calls.some(([message]) => String(message).includes('port hint'))).toBe(true)
  })

  it('marks the port as a caller hint when the hub cannot read its own config', async () => {
    vi.stubEnv('CAMSTACK_PORT', '')
    try {
      const { provider } = await startProvider({})
      const res = await provider.getConnectionEndpoints({ port: 5555 })
      expect(res.localPort).toEqual({ port: 5555, source: 'caller-hint' })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
