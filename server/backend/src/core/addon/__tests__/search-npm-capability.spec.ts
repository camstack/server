/**
 * `searchNpm` carries each package's declared capabilities (its published
 * manifest, D4) so the Addons page can offer an UNINSTALLED addon for a
 * capability (D860). A lookup that failed is `null` — unknown, never `[]` —
 * and an unknown package is never a match for a capability filter.
 */
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddonPackageService } from '../addon-package.service.js'

vi.mock('../../lifecycle/lifecycle-runner.singleton.js', () => ({
  getLifecycleRunner: () => ({
    startJob: async () => ({ jobId: 'job-1' }),
    getJob: () => null,
    listJobs: () => [],
    cancelJob: () => ({ cancelled: false }),
    reconcile: async () => ({ resumed: 0, failed: 0 }),
  }),
}))

interface LogCall {
  readonly message: string
  readonly meta: unknown
}

const TAILSCALE = '@camstack/addon-tailscale'
const CLOUDFLARE = '@camstack/addon-cloudflare'
const BROKEN = '@camstack/addon-broken'

const SEARCH_BODY = {
  objects: [TAILSCALE, CLOUDFLARE, BROKEN].map((name) => ({
    package: { name, version: '1.0.0', description: name, keywords: ['camstack', 'addon'] },
  })),
}

const MANIFESTS: Readonly<Record<string, unknown>> = {
  [TAILSCALE]: {
    version: '1.0.0',
    camstack: {
      addons: [
        {
          id: 'tailscale-client',
          capabilities: [{ name: 'mesh-network' }, { name: 'network-access' }],
        },
        { id: 'tailscale-ingress', capabilities: ['network-access'] },
      ],
    },
  },
  [CLOUDFLARE]: {
    version: '1.0.0',
    camstack: { addons: [{ id: 'cloudflare-tunnel', capabilities: [{ name: 'network-access' }] }] },
  },
}

function buildService(warnings: LogCall[]): AddonPackageService {
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string, meta?: unknown) => {
      warnings.push({ message, meta })
    },
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  const stub = {}
  return new AddonPackageService(
    { createLogger: () => logger } as never,
    { emit: () => undefined } as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
  )
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

let latestRequests: string[] = []

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input)
  if (url.includes('/-/v1/search')) return Promise.resolve(jsonResponse(SEARCH_BODY))
  const name = decodeURIComponent(url.replace(/^https:\/\/registry\.npmjs\.org\//, '')).replace(
    /\/latest$/,
    '',
  )
  latestRequests.push(name)
  const manifest = MANIFESTS[name]
  if (manifest === undefined) return Promise.resolve(jsonResponse({ error: 'boom' }, 500))
  return Promise.resolve(jsonResponse(manifest))
}

describe('searchNpm — capabilities', () => {
  beforeEach(() => {
    latestRequests = []
    vi.stubGlobal('fetch', vi.fn(fakeFetch))
    delete process.env['CAMSTACK_NPM_REGISTRY']
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns only the packages declaring the capability, and drops unknown ones', async () => {
    const warnings: LogCall[] = []
    const results = await buildService(warnings).searchNpm(undefined, 'network-access')
    expect(results.map((r) => r.name).sort()).toEqual([CLOUDFLARE, TAILSCALE])
    const tailscale = results.find((r) => r.name === TAILSCALE)
    expect(tailscale?.capabilities).toEqual(['mesh-network', 'network-access'])
  })

  it('filters on the capability asked for', async () => {
    const results = await buildService([]).searchNpm(undefined, 'mesh-network')
    expect(results.map((r) => r.name)).toEqual([TAILSCALE])
  })

  it('a failed lookup is null (never []), excluded from a filter, and logged once', async () => {
    const warnings: LogCall[] = []
    const service = buildService(warnings)
    const all = await service.searchNpm()
    expect(all.find((r) => r.name === BROKEN)?.capabilities).toBeNull()
    const lookupWarnings = warnings.filter((w) => w.message.includes('capability lookup'))
    expect(lookupWarnings).toHaveLength(1)
    expect(lookupWarnings[0]?.meta).toMatchObject({ meta: { failed: 1, total: 3 } })

    const filtered = await service.searchNpm(undefined, 'network-access')
    expect(filtered.map((r) => r.name)).not.toContain(BROKEN)
  })

  it('caches a good answer for the TTL but retries a failed one', async () => {
    const service = buildService([])
    await service.searchNpm()
    await service.searchNpm()
    expect(latestRequests.filter((n) => n === TAILSCALE)).toHaveLength(1)
    expect(latestRequests.filter((n) => n === BROKEN)).toHaveLength(2)
  })
})
