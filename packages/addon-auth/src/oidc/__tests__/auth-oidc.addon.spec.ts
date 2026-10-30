/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- test harness mocks values across typed boundaries (fetch responses, jose verify result, AddonContext stubs). Pre-existing pattern in this project. */
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// jose is mocked at the module level so we can drive `jwtVerify` directly
// without spinning up an IdP or generating a real RSA keypair. The
// real production behaviour (signature check + iss + aud + exp) is
// covered indirectly through "verify rejects" cases below.
//
// `vi.hoisted` is required because `vi.mock` is hoisted above all
// top-level statements — the factory cannot capture a regular `const`
// declared below. The hoisted block returns the mock object whose
// references the factory then closes over.
const joseMock = vi.hoisted(() => ({
  jwtVerify: vi.fn(),
  createRemoteJWKSet: vi.fn(),
}))
vi.mock('jose', () => joseMock)

import {
  type AddonContext,
  AUTOMATIC_HUB_ADDRESS_FLAGS,
  type ConnectionEndpoint,
  type IScopedLogger,
  resolveHubAddressRoles,
  type SecretsAccess,
  globalSecretScope,
  arrayItemFieldPath,
} from '@camstack/types'
// Import AFTER the mock declaration so the addon picks up our stub.
import { makeInMemoryRecords, buildSecretRef, type SecretScope } from '@camstack/types'
import { AuthOidcAddon } from '../auth-oidc.addon.js'
import { oidcProviderEntryKind } from '../oidc-provider-record-kinds.js'

// ---------------------------------------------------------------------------
// Test harness — minimal AddonContext stub
// ---------------------------------------------------------------------------

interface SsoBridgeMock {
  readonly signBridgeToken: ReturnType<typeof vi.fn>
  readonly verifyBridgeToken: ReturnType<typeof vi.fn>
}

interface TestCtxOptions {
  readonly config?: Partial<Record<string, unknown>>
  readonly ssoBridge?: SsoBridgeMock
  readonly logger?: IScopedLogger
  /** The hub's `local-network` palette. Default: empty (nothing advertised). */
  readonly endpoints?: readonly ConnectionEndpoint[]
  /** The address flagged "Sign-in" on the Network page. */
  readonly publicEndpointFlag?: string
  /** Where the hub's listeners answer (the address book's `listenerOrigins`). */
  readonly listenerOrigins?: readonly string[]
  /** The addon's keychain handle (`ctx.secrets`). */
  readonly secrets?: SecretsAccess
  /** A pre-built records world, so a spec can seed or inspect rows. */
  readonly recordsWorld?: ReturnType<typeof makeInMemoryRecords>
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

function makeSsoBridgeMock(): SsoBridgeMock {
  return {
    signBridgeToken: vi.fn(async ({ claims }) => ({
      token: `mock-bridge-token:${claims.userId}:${claims.isAdmin ? 'admin' : 'appConnections'}`,
    })),
    verifyBridgeToken: vi.fn(async () => null),
  }
}

function makeCtx(opts: TestCtxOptions = {}): AddonContext {
  const settings = {
    readAddonStore: vi.fn(async () => opts.config ?? {}),
    writeAddonStore: vi.fn(async () => undefined),
    readDeviceStore: vi.fn(async () => ({})),
    writeDeviceStore: vi.fn(async () => undefined),
    getSection: vi.fn(async () => ({})),
    setSection: vi.fn(async () => undefined),
  }
  const ssoBridge = opts.ssoBridge ?? makeSsoBridgeMock()
  const capabilities = {
    get: vi.fn(<T>(name: string): T | undefined => {
      if (name === 'sso-bridge') return ssoBridge as unknown as T
      return undefined
    }),
    getCollection: vi.fn(() => undefined),
    getCollectionEntries: vi.fn(() => undefined),
  }
  // The addon resolves `sso-bridge` through `ctx.api` (the tRPC link
  // chain), NOT `ctx.capabilities`. `ctx.api.ssoBridge.<method>` is a
  // tRPC procedure handle — invoked as `.query(input)`. Wrap the bare
  // `vi.fn()` mocks behind a `.query` so assertions on call count /
  // arguments keep working against the same spy instances.
  const api = {
    ssoBridge: {
      signBridgeToken: { query: ssoBridge.signBridgeToken },
      verifyBridgeToken: { query: ssoBridge.verifyBridgeToken },
    },
    localNetwork: {
      getAddresses: {
        query: vi.fn(async () => ({
          rows: [],
          roles: resolveHubAddressRoles(opts.endpoints ?? [], opts.endpoints ?? [], {
            ...AUTOMATIC_HUB_ADDRESS_FLAGS,
            publicEndpoint: opts.publicEndpointFlag ?? null,
          }),
          appLinkHub: null,
          ...(opts.listenerOrigins !== undefined ? { listenerOrigins: opts.listenerOrigins } : {}),
        })),
      },
    },
  }
  const recordsWorld = opts.recordsWorld ?? makeInMemoryRecords('auth')
  const ctx = {
    id: 'auth-oidc',
    records: recordsWorld.records,
    secrets: opts.secrets,
    logger: opts.logger ?? makeLogger(),
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir: '/tmp/oidc-test',
    nodeDataDir: '/tmp',
    kernel: { localNodeId: 'hub', devices: {} as never },
    settings,
    api: api as never,
    capabilities,
    deps: {} as never,
    useCapability: vi.fn(),
    acquireCapability: vi.fn(),
    onCapabilityStateChange: vi.fn(),
  } as unknown as AddonContext
  return ctx
}

interface CapturedReply {
  status: number | null
  headers: Map<string, string>
  body: unknown
  redirectUrl: string | null
}
function makeReply(): { reply: any; captured: CapturedReply } {
  const captured: CapturedReply = {
    status: null,
    headers: new Map(),
    body: undefined,
    redirectUrl: null,
  }
  const reply = {
    status(code: number) {
      captured.status = code
      return reply
    },
    code(code: number) {
      captured.status = code
      return reply
    },
    send(data: unknown) {
      captured.body = data
    },
    redirect(url: string) {
      captured.redirectUrl = url
    },
    header(name: string, value: string) {
      captured.headers.set(name.toLowerCase(), value)
      return reply
    },
    type(_mime: string) {
      return reply
    },
  }
  return { reply, captured }
}

// ---------------------------------------------------------------------------
// Default fixtures
// ---------------------------------------------------------------------------

// Per-provider config. After the multi-provider refactor the addon
// config is `{providers: Array<...>}`. Tests use a single-provider
// `{providers: [VIEWER_PROVIDER]}` shape unless they're exercising
// multi-instance fan-out explicitly.
const VIEWER_PROVIDER = {
  id: 'acme',
  displayName: 'Acme SSO',
  icon: 'shield-check',
  issuerUrl: 'https://idp.example.com',
  clientId: 'cs-client-1',
  clientSecret: 'cs-secret-1',
  redirectUri: 'https://camstack.example.com/addon/auth-oidc/acme/callback',
  scopes: 'openid profile email',
  usernameClaim: 'preferred_username' as const,
  defaultRole: 'appConnections' as const,
}

const ADMIN_PROVIDER = { ...VIEWER_PROVIDER, defaultRole: 'admin' as const }

const VIEWER_CONFIG = { providers: [VIEWER_PROVIDER] }
const ADMIN_CONFIG = { providers: [ADMIN_PROVIDER] }

const DISCOVERY_DOC = {
  issuer: 'https://idp.example.com',
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  jwks_uri: 'https://idp.example.com/.well-known/jwks.json',
  userinfo_endpoint: 'https://idp.example.com/userinfo',
}

function makeFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/.well-known/openid-configuration')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => DISCOVERY_DOC,
        text: async () => JSON.stringify(DISCOVERY_DOC),
      } as Response
    }
    throw new Error(`unexpected fetch: ${u}`)
  })
}

async function bootAddon(opts: TestCtxOptions = {}): Promise<{
  addon: AuthOidcAddon
  ctx: AddonContext
  ssoBridge: SsoBridgeMock
  registrations: ReadonlyArray<{ capability: { name: string }; provider: unknown }>
}> {
  const ssoBridge = opts.ssoBridge ?? makeSsoBridgeMock()
  const ctx = makeCtx({ ...opts, ssoBridge })
  const addon = new AuthOidcAddon()
  const result = await addon.initialize(ctx)
  const list = Array.isArray(result) ? result : (result?.providers ?? [])
  return {
    addon,
    ctx,
    ssoBridge,
    registrations: list as ReadonlyArray<{ capability: { name: string }; provider: unknown }>,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // `vi.clearAllMocks` keeps queued `mockResolvedValueOnce` entries —
  // a test that doesn't consume its enqueued return would leak it into
  // the next test (the "consumes pending state" case below sets two
  // returns and only consumes one). Hard-reset the implementation queue
  // for the two jose stubs we drive per-test.
  joseMock.jwtVerify.mockReset()
  joseMock.createRemoteJWKSet.mockReset()
  // Default: createRemoteJWKSet returns a stub handle — addon never
  // invokes it directly, it just stores the reference for jwtVerify.
  joseMock.createRemoteJWKSet.mockReturnValue('mock-jwks-handle' as never)
  // Reset global fetch — tests opt-in by reassigning.
  ;(globalThis as { fetch?: unknown }).fetch = makeFetchMock()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Initialization + provider registration
// ---------------------------------------------------------------------------

describe('AuthOidcAddon — initialization', () => {
  it('registers auth-provider, addon-routes, login-method, and oidc-connections', async () => {
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const names = registrations.map((r) => r.capability.name).toSorted()
    expect(names).toEqual(['addon-routes', 'auth-provider', 'login-method', 'oidc-connections'])
  })

  it('login-method exposes a redirect contribution per configured provider', async () => {
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const loginMethod = registrations.find((r) => r.capability.name === 'login-method')
      ?.provider as { getLoginMethods: () => Promise<readonly Record<string, unknown>[]> }
    const methods = await loginMethod.getLoginMethods()
    expect(methods.length).toBeGreaterThan(0)
    for (const m of methods) {
      expect(m.kind).toBe('redirect')
      expect(m.stage).toBe('primary')
      expect(typeof m.startUrl).toBe('string')
      expect(String(m.startUrl)).toContain('/addon/auth-oidc/')
      // D782: every OIDC instance is offered for linking by contract, not by id.
      expect(m.linkable).toBe(true)
    }
  })

  it('login-method draws a catalog icon, and falls back to shield-check for one outside it (D780, D854)', async () => {
    const { registrations } = await bootAddon({
      config: {
        providers: [
          { ...VIEWER_PROVIDER, id: 'a', icon: 'key' },
          // Any catalog icon is drawn now, not only a curated few; `log-in` was free text before D854.
          { ...VIEWER_PROVIDER, id: 'b', icon: 'log-in' },
          { ...VIEWER_PROVIDER, id: 'c', icon: '' },
          { ...VIEWER_PROVIDER, id: 'd', icon: 'not-an-icon' },
        ],
      },
    })
    const loginMethod = registrations.find((r) => r.capability.name === 'login-method')
      ?.provider as { getLoginMethods: () => Promise<readonly Record<string, unknown>[]> }
    const icons = (await loginMethod.getLoginMethods()).map((m) => [m.id, m.icon])
    expect(icons).toEqual([
      ['auth-oidc/a', 'key'],
      ['auth-oidc/b', 'log-in'],
      ['auth-oidc/c', 'shield-check'],
      ['auth-oidc/d', 'shield-check'],
    ])
  })

  it('the connection form declares an icon picker and a masked client secret (D780/D830)', async () => {
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const connections = registrations.find((r) => r.capability.name === 'oidc-connections')
      ?.provider as {
      connectionFormSchema: () => Promise<{
        sections: readonly { fields: readonly { key: string; type: string; default?: unknown }[] }[]
      }>
    }
    const schema = await connections.connectionFormSchema()
    const byKey = new Map(schema.sections.flatMap((s) => s.fields).map((f) => [f.key, f]))
    expect(byKey.get('icon')).toMatchObject({ type: 'icon', default: 'shield-check' })
    expect(byKey.get('clientSecret')?.type).toBe('password')
    // D782: no role is granted by the IdP instance — the linked user's record decides.
    expect(byKey.has('defaultRole')).toBe(false)
    // Settings schema itself is blurb-only (no providers editable-array).
    const { addon } = await bootAddon({ config: VIEWER_CONFIG })
    const settings = await addon.getGlobalSettings()
    expect(settings?.sections.flatMap((s) => s.fields)).toEqual([])
  })

  it('auth-provider exposes the four IAuthProvider methods', async () => {
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')
      ?.provider as Record<string, unknown>
    expect(typeof authProvider.validateCredentials).toBe('function')
    expect(typeof authProvider.validateToken).toBe('function')
    expect(typeof authProvider.getLoginUrl).toBe('function')
    expect(typeof authProvider.handleCallback).toBe('function')
  })

  it('addon-routes exposes /start and /callback (both public)', async () => {
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const routeProvider = registrations.find((r) => r.capability.name === 'addon-routes')
      ?.provider as {
      id: string
      getRoutes(): ReadonlyArray<{ method: string; path: string; access: string }>
    }
    expect(routeProvider.id).toBe('auth-oidc')
    const routes = routeProvider.getRoutes()
    expect(routes).toHaveLength(2)
    expect(routes.map((r) => `${r.method} ${r.path}`).toSorted()).toEqual([
      'GET /:providerId/callback',
      'GET /:providerId/start',
    ])
    expect(routes.every((r) => r.access === 'public')).toBe(true)
  })

  it('falls back to defaults when no config persisted', async () => {
    const { registrations } = await bootAddon({ config: {} })
    expect(registrations).toHaveLength(4)
    // No throw — onInitialize succeeds even with empty issuerUrl
  })
})

// ---------------------------------------------------------------------------
// buildLoginUrl + state / PKCE / nonce lifecycle
// ---------------------------------------------------------------------------

describe('AuthOidcAddon — buildLoginUrl', () => {
  it('builds an authorize URL with response_type, client_id, scope, state, PKCE S256, and nonce', async () => {
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
    }
    const url = await authProvider.getLoginUrl({ state: 'state-abc' })
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://idp.example.com/authorize')
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('client_id')).toBe('cs-client-1')
    expect(parsed.searchParams.get('scope')).toBe('openid profile email')
    expect(parsed.searchParams.get('state')).toBe('state-abc')
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy()
    expect(parsed.searchParams.get('nonce')).toBeTruthy()
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://camstack.example.com/addon/auth-oidc/acme/callback',
    )
  })

  it('uses the operator-configured redirectUri when set', async () => {
    const { registrations } = await bootAddon({
      config: { providers: [{ ...VIEWER_PROVIDER, redirectUri: 'https://override.example/cb' }] },
    })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
    }
    const url = await authProvider.getLoginUrl({ state: 's' })
    expect(new URL(url).searchParams.get('redirect_uri')).toBe('https://override.example/cb')
  })

  it("falls back to the hub's browser address from Network when redirectUri is unset", async () => {
    const prior = process.env['CAMSTACK_HUB_PUBLIC_URL']
    // The retired variable must be ignored even when present.
    process.env['CAMSTACK_HUB_PUBLIC_URL'] = 'https://env.example.com'
    try {
      const { registrations } = await bootAddon({
        config: { providers: [{ ...VIEWER_PROVIDER, redirectUri: '' }] },
        endpoints: [
          {
            label: 'LAN — eth0',
            baseUrl: 'https://192.0.2.10:4443',
            kind: 'lan-ipv4',
            interfaceKind: 'lan',
            plausible: true,
            plausibleReason: '',
            priority: 0,
          },
          {
            label: 'Public tunnel',
            baseUrl: 'https://cams.example.com',
            kind: 'public',
            interfaceKind: 'public',
            plausible: true,
            plausibleReason: '',
            priority: 100,
          },
        ],
      })
      const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
        .provider as {
        getLoginUrl(args: { state: string }): Promise<string>
      }
      const url = await authProvider.getLoginUrl({ state: 's' })
      expect(new URL(url).searchParams.get('redirect_uri')).toBe(
        'https://cams.example.com/addon/auth-oidc/acme/callback',
      )
    } finally {
      if (prior === undefined) delete process.env['CAMSTACK_HUB_PUBLIC_URL']
      else process.env['CAMSTACK_HUB_PUBLIC_URL'] = prior
    }
  })

  it("uses the Network page's public endpoint over the detected one", async () => {
    const { registrations } = await bootAddon({
      config: { providers: [{ ...VIEWER_PROVIDER, redirectUri: '' }] },
      publicEndpointFlag: 'https://login.example.net',
      endpoints: [
        {
          label: 'LAN — eth0',
          baseUrl: 'https://192.0.2.10:4443',
          kind: 'lan-ipv4',
          interfaceKind: 'lan',
          plausible: true,
          plausibleReason: '',
          priority: 0,
        },
      ],
    })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
    }
    const url = await authProvider.getLoginUrl({ state: 's' })
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(
      'https://login.example.net/addon/auth-oidc/acme/callback',
    )
  })

  it('throws when issuerUrl is empty', async () => {
    const { registrations } = await bootAddon({
      config: { providers: [{ ...VIEWER_PROVIDER, issuerUrl: '' }] },
    })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
    }
    await expect(authProvider.getLoginUrl({ state: 's' })).rejects.toThrow(
      'issuerUrl not configured',
    )
  })

  it('throws when discovery doc is missing required endpoints', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ issuer: 'https://idp.example.com' }), // missing endpoints
        }) as Response,
    )
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
    }
    await expect(authProvider.getLoginUrl({ state: 's' })).rejects.toThrow(
      'missing required endpoints',
    )
  })

  it('strips trailing slashes from issuerUrl when building the discovery URL', async () => {
    const { registrations } = await bootAddon({
      config: { providers: [{ ...VIEWER_PROVIDER, issuerUrl: 'https://idp.example.com///' }] },
    })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
    }
    await authProvider.getLoginUrl({ state: 's' })
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    const calledWith = fetchMock.mock.calls[0]?.[0]
    expect(String(calledWith)).toBe('https://idp.example.com/.well-known/openid-configuration')
  })

  it('caches the discovery doc across calls within the 1-hour TTL', async () => {
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
    }
    await authProvider.getLoginUrl({ state: 's1' })
    await authProvider.getLoginUrl({ state: 's2' })
    await authProvider.getLoginUrl({ state: 's3' })
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('initializes the JWKS handle from discovery jwks_uri', async () => {
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
    }
    await authProvider.getLoginUrl({ state: 's' })
    expect(joseMock.createRemoteJWKSet).toHaveBeenCalledWith(new URL(DISCOVERY_DOC.jwks_uri))
  })
})

// ---------------------------------------------------------------------------
// handleCallback — happy path, claims, role mapping
// ---------------------------------------------------------------------------

describe('AuthOidcAddon — handleCallback (happy path)', () => {
  function tokenEndpointFetch(
    idToken: string = 'mock.id.token',
    extra: Record<string, unknown> = {},
  ): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/.well-known/openid-configuration')) {
        return {
          ok: true,
          status: 200,
          json: async () => DISCOVERY_DOC,
          text: async () => JSON.stringify(DISCOVERY_DOC),
        } as Response
      }
      if (u === DISCOVERY_DOC.token_endpoint) {
        // Sanity: request body must be x-www-form-urlencoded
        expect(init?.method).toBe('POST')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id_token: idToken,
            access_token: 'mock.access.token',
            token_type: 'Bearer',
            expires_in: 3600,
            ...extra,
          }),
          text: async () => '',
        } as Response
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
  }

  it('exchanges code → tokens, verifies id_token, returns mapped claims (viewer)', async () => {
    ;(globalThis as { fetch: unknown }).fetch = tokenEndpointFetch()
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: {
        sub: 'idp-user-1',
        nonce: 'NONCE-FROM-AUTHORIZE',
        preferred_username: 'alice',
        email: 'alice@example.com',
        name: 'Alice Doe',
      },
    } as never)

    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<{
        userId: string
        username: string
        email?: string
        displayName?: string
        isAdmin: boolean
      }>
    }
    // Drive a real authorize → cache the nonce ↔ state pairing inside the addon.
    const url = await authProvider.getLoginUrl({ state: 'STATE-X' })
    const nonce = new URL(url).searchParams.get('nonce')!
    joseMock.jwtVerify.mockReset()
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: {
        sub: 'idp-user-1',
        nonce, // matches what we sent — replay defense passes
        preferred_username: 'alice',
        email: 'alice@example.com',
        name: 'Alice Doe',
      },
    } as never)

    const result = await authProvider.handleCallback({ code: 'AUTH-CODE-1', state: 'STATE-X' })
    expect(result.userId).toBe('oidc:acme:idp-user-1')
    expect(result.username).toBe('alice')
    expect(result.email).toBe('alice@example.com')
    expect(result.displayName).toBe('Alice Doe')
    expect(result.isAdmin).toBe(false)
  })

  it('a stored defaultRole never makes the identity admin — the linked record decides (D782)', async () => {
    ;(globalThis as { fetch: unknown }).fetch = tokenEndpointFetch()
    const { registrations } = await bootAddon({ config: ADMIN_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<{ isAdmin: boolean }>
    }
    const url = await authProvider.getLoginUrl({ state: 'STATE-A' })
    const nonce = new URL(url).searchParams.get('nonce')!
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'idp-2', nonce, preferred_username: 'admin' },
    } as never)
    const result = await authProvider.handleCallback({ code: 'CODE', state: 'STATE-A' })
    expect(result.isAdmin).toBe(false)
  })

  it('picks email as username when usernameClaim=email', async () => {
    ;(globalThis as { fetch: unknown }).fetch = tokenEndpointFetch()
    const { registrations } = await bootAddon({
      config: { providers: [{ ...VIEWER_PROVIDER, usernameClaim: 'email' as const }] },
    })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<{ username: string }>
    }
    const url = await authProvider.getLoginUrl({ state: 'S' })
    const nonce = new URL(url).searchParams.get('nonce')!
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: {
        sub: 'idp-3',
        nonce,
        preferred_username: 'preferred-name',
        email: 'me@example.com',
      },
    } as never)
    const result = await authProvider.handleCallback({ code: 'C', state: 'S' })
    expect(result.username).toBe('me@example.com')
  })

  it('falls back to sub when the configured username claim is missing', async () => {
    ;(globalThis as { fetch: unknown }).fetch = tokenEndpointFetch()
    const { registrations } = await bootAddon({
      config: { providers: [{ ...VIEWER_PROVIDER, usernameClaim: 'preferred_username' as const }] },
    })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<{ username: string }>
    }
    const url = await authProvider.getLoginUrl({ state: 'S' })
    const nonce = new URL(url).searchParams.get('nonce')!
    // No preferred_username, no email — fallback to sub
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'only-sub', nonce },
    } as never)
    const result = await authProvider.handleCallback({ code: 'C', state: 'S' })
    expect(result.username).toBe('only-sub')
  })

  it('omits optional email + displayName when absent from claims', async () => {
    ;(globalThis as { fetch: unknown }).fetch = tokenEndpointFetch()
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<Record<string, unknown>>
    }
    const url = await authProvider.getLoginUrl({ state: 'S' })
    const nonce = new URL(url).searchParams.get('nonce')!
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'no-email-sub', nonce },
    } as never)
    const result = await authProvider.handleCallback({ code: 'C', state: 'S' })
    expect(result['email']).toBeUndefined()
    expect(result['displayName']).toBeUndefined()
  })

  it('passes issuer + audience to jose.jwtVerify (OIDC Core compliance)', async () => {
    ;(globalThis as { fetch: unknown }).fetch = tokenEndpointFetch()
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<unknown>
    }
    const url = await authProvider.getLoginUrl({ state: 'S' })
    const nonce = new URL(url).searchParams.get('nonce')!
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 's', nonce },
    } as never)
    await authProvider.handleCallback({ code: 'C', state: 'S' })
    const callArgs = joseMock.jwtVerify.mock.calls.at(-1)
    expect(callArgs?.[0]).toBe('mock.id.token')
    expect(callArgs?.[2]).toEqual({
      issuer: DISCOVERY_DOC.issuer,
      audience: VIEWER_PROVIDER.clientId,
    })
  })
})

// ---------------------------------------------------------------------------
// handleCallback — error paths (the security-critical surface)
// ---------------------------------------------------------------------------

describe('AuthOidcAddon — handleCallback (errors)', () => {
  function tokenFetchFor(idToken: string): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/openid-configuration')) {
        return { ok: true, status: 200, json: async () => DISCOVERY_DOC } as Response
      }
      if (u === DISCOVERY_DOC.token_endpoint) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id_token: idToken, access_token: 'A' }),
        } as Response
      }
      throw new Error(`unexpected: ${u}`)
    })
  }

  it('rejects unknown state (state token mismatch / expired pending map)', async () => {
    ;(globalThis as { fetch: unknown }).fetch = tokenFetchFor('id')
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      handleCallback(params: Record<string, string>): Promise<unknown>
    }
    await expect(authProvider.handleCallback({ code: 'C', state: 'NEVER-ISSUED' })).rejects.toThrow(
      'Unknown or expired OIDC state',
    )
  })

  it('rejects callback when id_token is missing from token response', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/openid-configuration')) {
        return { ok: true, json: async () => DISCOVERY_DOC } as Response
      }
      if (u === DISCOVERY_DOC.token_endpoint) {
        return { ok: true, json: async () => ({ access_token: 'A' /* no id_token */ }) } as Response
      }
      throw new Error('?')
    })
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<unknown>
    }
    await authProvider.getLoginUrl({ state: 'S' })
    await expect(authProvider.handleCallback({ code: 'C', state: 'S' })).rejects.toThrow(
      'missing id_token',
    )
  })

  it('rejects callback when token endpoint returns non-2xx', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/openid-configuration')) {
        return { ok: true, json: async () => DISCOVERY_DOC } as Response
      }
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => '{"error":"invalid_grant"}',
      } as Response
    })
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<unknown>
    }
    await authProvider.getLoginUrl({ state: 'S' })
    await expect(authProvider.handleCallback({ code: 'C', state: 'S' })).rejects.toThrow(
      'token exchange failed',
    )
  })

  it('rejects when id_token signature verification fails (jose throws)', async () => {
    ;(globalThis as { fetch: unknown }).fetch = tokenFetchFor('id')
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<unknown>
    }
    await authProvider.getLoginUrl({ state: 'S' })
    joseMock.jwtVerify.mockRejectedValueOnce(new Error('signature verification failed'))
    await expect(authProvider.handleCallback({ code: 'C', state: 'S' })).rejects.toThrow(
      'id_token verification failed',
    )
  })

  it('rejects when id_token nonce claim does NOT match the issued nonce (replay defense)', async () => {
    ;(globalThis as { fetch: unknown }).fetch = tokenFetchFor('id')
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<unknown>
    }
    await authProvider.getLoginUrl({ state: 'S' })
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'idp-1', nonce: 'WRONG-NONCE', preferred_username: 'alice' },
    } as never)
    await expect(authProvider.handleCallback({ code: 'C', state: 'S' })).rejects.toThrow(
      'nonce mismatch',
    )
  })

  it('rejects when id_token nonce claim is missing entirely', async () => {
    ;(globalThis as { fetch: unknown }).fetch = tokenFetchFor('id')
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<unknown>
    }
    await authProvider.getLoginUrl({ state: 'S' })
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'idp-1' /* no nonce */ },
    } as never)
    await expect(authProvider.handleCallback({ code: 'C', state: 'S' })).rejects.toThrow(
      'nonce mismatch',
    )
  })

  it('rejects when id_token payload lacks `sub`', async () => {
    ;(globalThis as { fetch: unknown }).fetch = tokenFetchFor('id')
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<unknown>
    }
    const url = await authProvider.getLoginUrl({ state: 'S' })
    const nonce = new URL(url).searchParams.get('nonce')!
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { nonce /* no sub */ },
    } as never)
    await expect(authProvider.handleCallback({ code: 'C', state: 'S' })).rejects.toThrow(
      'missing required `sub`',
    )
  })

  it('rejects when discovery doc lacks jwks_uri (cannot verify signatures)', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/openid-configuration')) {
        return {
          ok: true,
          json: async () => ({
            issuer: DISCOVERY_DOC.issuer,
            authorization_endpoint: DISCOVERY_DOC.authorization_endpoint,
            token_endpoint: DISCOVERY_DOC.token_endpoint,
            // jwks_uri intentionally missing
          }),
        } as Response
      }
      if (u === DISCOVERY_DOC.token_endpoint) {
        return { ok: true, json: async () => ({ id_token: 'id', access_token: 'A' }) } as Response
      }
      throw new Error('?')
    })
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<unknown>
    }
    await authProvider.getLoginUrl({ state: 'S' })
    await expect(authProvider.handleCallback({ code: 'C', state: 'S' })).rejects.toThrow('jwks_uri')
  })

  it('consumes the pending state on success (replay of the same state fails)', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/openid-configuration'))
        return { ok: true, json: async () => DISCOVERY_DOC } as Response
      return { ok: true, json: async () => ({ id_token: 'id', access_token: 'A' }) } as Response
    })
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      getLoginUrl(args: { state: string }): Promise<string>
      handleCallback(params: Record<string, string>): Promise<unknown>
    }
    const url = await authProvider.getLoginUrl({ state: 'S' })
    const nonce = new URL(url).searchParams.get('nonce')!
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'x', nonce, preferred_username: 'u' },
    } as never)
    await authProvider.handleCallback({ code: 'C', state: 'S' })
    // Second attempt with the same state must fail — pending entry was deleted
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'x', nonce, preferred_username: 'u' },
    } as never)
    await expect(authProvider.handleCallback({ code: 'C2', state: 'S' })).rejects.toThrow(
      'Unknown or expired',
    )
  })
})

// ---------------------------------------------------------------------------
// validateCredentials + validateToken (OIDC has no credential flow)
// ---------------------------------------------------------------------------

describe('AuthOidcAddon — IAuthProvider non-redirect surface', () => {
  it('validateCredentials returns null (OIDC is redirect-only)', async () => {
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      validateCredentials(args: unknown): Promise<unknown>
    }
    const out = await authProvider.validateCredentials({ username: 'x', password: 'y' })
    expect(out).toBeNull()
  })

  it('validateToken returns null (local session validation owned by local-auth)', async () => {
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
      .provider as {
      validateToken(args: { token: string }): Promise<unknown>
    }
    const out = await authProvider.validateToken({ token: 'whatever' })
    expect(out).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Route handlers — /start and /callback (Fastify-shape replies)
// ---------------------------------------------------------------------------

describe('AuthOidcAddon — route handlers', () => {
  function getRoutes(
    addon: AuthOidcAddon,
    registrations: ReadonlyArray<{ capability: { name: string }; provider: unknown }>,
  ) {
    void addon
    const routeProvider = registrations.find((r) => r.capability.name === 'addon-routes')!
      .provider as {
      getRoutes(): ReadonlyArray<{
        method: string
        path: string
        handler: (req: any, reply: any) => Promise<void>
      }>
    }
    return routeProvider.getRoutes()
  }

  it('/start redirects (302) to the IdP authorize URL', async () => {
    const { addon, registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const routes = getRoutes(addon, registrations)
    const startRoute = routes.find((r) => r.path === '/:providerId/start')!
    const { reply, captured } = makeReply()
    await startRoute.handler(
      { params: { providerId: 'acme' }, query: {}, body: undefined, headers: {} },
      reply,
    )
    expect(captured.status).toBe(302)
    expect(captured.headers.get('location')).toMatch(/^https:\/\/idp\.example\.com\/authorize\?/)
  })

  it('/start returns 500 when discovery fails', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 500,
          statusText: 'Internal',
        }) as Response,
    )
    const { addon, registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const routes = getRoutes(addon, registrations)
    const startRoute = routes.find((r) => r.path === '/:providerId/start')!
    const { reply, captured } = makeReply()
    await startRoute.handler(
      { params: { providerId: 'acme' }, query: {}, body: undefined, headers: {} },
      reply,
    )
    expect(captured.status).toBe(500)
    expect((captured.body as { error: string }).error).toMatch(/OIDC start failed/)
  })

  it('/callback returns 400 when both code and state are missing', async () => {
    const { addon, registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const routes = getRoutes(addon, registrations)
    const cbRoute = routes.find((r) => r.path === '/:providerId/callback')!
    const { reply, captured } = makeReply()
    await cbRoute.handler(
      { params: { providerId: 'acme' }, query: {}, body: undefined, headers: {} },
      reply,
    )
    expect(captured.status).toBe(400)
    expect(captured.body).toEqual({ error: 'Missing code or state' })
  })

  it('/callback returns 400 with IdP error details when query carries `error`', async () => {
    const { addon, registrations } = await bootAddon({ config: VIEWER_CONFIG })
    const routes = getRoutes(addon, registrations)
    const cbRoute = routes.find((r) => r.path === '/:providerId/callback')!
    const { reply, captured } = makeReply()
    await cbRoute.handler(
      {
        params: { providerId: 'acme' },
        query: { error: 'access_denied', error_description: 'user cancelled' },
        body: undefined,
        headers: {},
      },
      reply,
    )
    expect(captured.status).toBe(400)
    expect(captured.body).toEqual({
      error: 'OIDC error',
      detail: 'access_denied',
      description: 'user cancelled',
    })
  })

  it('/callback on success mints a bridge token via sso-bridge cap + 302s to /api/auth/sso/finish', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/openid-configuration'))
        return { ok: true, json: async () => DISCOVERY_DOC } as Response
      return { ok: true, json: async () => ({ id_token: 'id', access_token: 'A' }) } as Response
    })
    const ssoBridge = makeSsoBridgeMock()
    const { addon, registrations } = await bootAddon({ config: ADMIN_CONFIG, ssoBridge })

    // First drive a /start to register the state ↔ nonce in the pending map
    const routes = getRoutes(addon, registrations)
    const startRoute = routes.find((r) => r.path === '/:providerId/start')!
    const { reply: startReply, captured: startCaptured } = makeReply()
    await startRoute.handler(
      { params: { providerId: 'acme' }, query: {}, body: undefined, headers: {} },
      startReply,
    )
    const authorizeUrl = startCaptured.headers.get('location')!
    const authorizeParams = new URL(authorizeUrl).searchParams
    const state = authorizeParams.get('state')!
    const nonce = authorizeParams.get('nonce')!

    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: {
        sub: 'admin-1',
        nonce,
        preferred_username: 'admin@acme',
        email: 'admin@acme.com',
        name: 'Acme Admin',
      },
    } as never)

    const cbRoute = routes.find((r) => r.path === '/:providerId/callback')!
    const { reply, captured } = makeReply()
    await cbRoute.handler(
      {
        params: { providerId: 'acme' },
        query: { code: 'AUTH-1', state },
        body: undefined,
        headers: {},
      },
      reply,
    )

    expect(captured.status).toBe(302)
    const loc = captured.headers.get('location')!
    // Absolute, on the pinned redirect URI's origin (D791).
    expect(loc).toMatch(/^https:\/\/camstack\.example\.com\/api\/auth\/sso\/finish\?bridge=/)
    expect(ssoBridge!.signBridgeToken).toHaveBeenCalledTimes(1)
    const signCall = ssoBridge!.signBridgeToken.mock.calls[0]?.[0]
    expect(signCall.claims).toEqual({
      userId: 'oidc:acme:admin-1',
      username: 'admin@acme',
      isAdmin: false,
      provider: 'auth-oidc/acme',
      email: 'admin@acme.com',
      displayName: 'Acme Admin',
      issuer: 'https://idp.example.com',
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{16,}$/),
      browserBinding: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  describe('the bridge is bound to the browser that started the sign-in', () => {
    function stateCookieOf(setCookie: string | undefined): string {
      const match = /camstack_sso_state=([^;]+)/.exec(setCookie ?? '')
      if (match === null || match[1] === undefined) throw new Error('no state cookie set')
      return match[1]
    }

    it('/start sets an HttpOnly, SameSite=Lax, 10-minute state cookie on path /', async () => {
      const { addon, registrations } = await bootAddon({ config: ADMIN_CONFIG })
      const startRoute = getRoutes(addon, registrations).find(
        (r) => r.path === '/:providerId/start',
      )!
      const { reply, captured } = makeReply()
      await startRoute.handler(
        { params: { providerId: 'acme' }, query: {}, body: undefined, headers: {} },
        reply,
      )
      const setCookie = captured.headers.get('set-cookie')
      expect(stateCookieOf(setCookie)).toMatch(/^[A-Za-z0-9_-]{40,}$/)
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Lax')
      expect(setCookie).toContain('Path=/')
      expect(setCookie).toContain('Max-Age=600')
      // The pinned redirect URI is https → the cookie is Secure.
      expect(setCookie).toContain('Secure')
    })

    it('the bridge carries the HASH of that cookie — never the cookie — and a fresh jti', async () => {
      ;(globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string | URL) => {
        const u = String(url)
        if (u.endsWith('/openid-configuration'))
          return { ok: true, json: async () => DISCOVERY_DOC } as Response
        return { ok: true, json: async () => ({ id_token: 'id', access_token: 'A' }) } as Response
      })
      const ssoBridge = makeSsoBridgeMock()
      const { addon, registrations } = await bootAddon({ config: ADMIN_CONFIG, ssoBridge })
      const routes = getRoutes(addon, registrations)
      const { reply: startReply, captured: started } = makeReply()
      await routes
        .find((r) => r.path === '/:providerId/start')!
        .handler(
          { params: { providerId: 'acme' }, query: {}, body: undefined, headers: {} },
          startReply,
        )
      const cookie = stateCookieOf(started.headers.get('set-cookie'))
      const params = new URL(started.headers.get('location')!).searchParams
      joseMock.jwtVerify.mockResolvedValueOnce({
        payload: { sub: 's-1', nonce: params.get('nonce') },
      } as never)
      const { reply } = makeReply()
      await routes
        .find((r) => r.path === '/:providerId/callback')!
        .handler(
          {
            params: { providerId: 'acme' },
            query: { code: 'C', state: params.get('state') },
            body: undefined,
            headers: {},
          },
          reply,
        )
      const claims = ssoBridge.signBridgeToken.mock.calls[0]?.[0]?.claims
      expect(claims.browserBinding).toBe(createHash('sha256').update(cookie).digest('hex'))
      expect(JSON.stringify(claims)).not.toContain(cookie)
      expect(typeof claims.jti).toBe('string')
    })
  })

  async function startThenCallback(query: Record<string, string>): Promise<{
    startStatus: number | null
    claims: Record<string, unknown> | undefined
  }> {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/openid-configuration'))
        return { ok: true, json: async () => DISCOVERY_DOC } as Response
      return { ok: true, json: async () => ({ id_token: 'id', access_token: 'A' }) } as Response
    })
    const ssoBridge = makeSsoBridgeMock()
    const { addon, registrations } = await bootAddon({ config: VIEWER_CONFIG, ssoBridge })
    const routes = getRoutes(addon, registrations)
    const startRoute = routes.find((r) => r.path === '/:providerId/start')!
    const { reply: startReply, captured: startCaptured } = makeReply()
    await startRoute.handler(
      { params: { providerId: 'acme' }, query, body: undefined, headers: {} },
      startReply,
    )
    if (startCaptured.status !== 302)
      return { startStatus: startCaptured.status, claims: undefined }
    const params = new URL(startCaptured.headers.get('location')!).searchParams
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'idp-sub-7', nonce: params.get('nonce'), preferred_username: 'alice' },
    } as never)
    const cbRoute = routes.find((r) => r.path === '/:providerId/callback')!
    const { reply } = makeReply()
    await cbRoute.handler(
      {
        params: { providerId: 'acme' },
        query: { code: 'C', state: params.get('state') },
        body: undefined,
        headers: {},
      },
      reply,
    )
    return {
      startStatus: startCaptured.status,
      claims: ssoBridge.signBridgeToken.mock.calls[0]?.[0]?.claims,
    }
  }

  it('/start?link=<intent> carries the hub link intent through to the bridge (D782)', async () => {
    const intent = 'li_0123456789abcdefABCDEF'
    const { claims } = await startThenCallback({ link: intent })
    expect(claims).toMatchObject({
      userId: 'oidc:acme:idp-sub-7',
      provider: 'auth-oidc/acme',
      linkIntent: intent,
    })
  })

  it('the bridge carries the verified issuer (D782)', async () => {
    const { claims } = await startThenCallback({})
    expect(claims?.issuer).toBe('https://idp.example.com')
  })

  it('a callback on a different instance than the login started at is refused', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/openid-configuration'))
        return { ok: true, json: async () => DISCOVERY_DOC } as Response
      return { ok: true, json: async () => ({ id_token: 'id', access_token: 'A' }) } as Response
    })
    const ssoBridge = makeSsoBridgeMock()
    const { addon, registrations } = await bootAddon({
      config: { providers: [VIEWER_PROVIDER, { ...VIEWER_PROVIDER, id: 'other' }] },
      ssoBridge,
    })
    const routes = getRoutes(addon, registrations)
    const { reply: sr, captured: sc } = makeReply()
    await routes
      .find((r) => r.path === '/:providerId/start')!
      .handler({ params: { providerId: 'acme' }, query: {}, body: undefined, headers: {} }, sr)
    const params = new URL(sc.headers.get('location')!).searchParams
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 's', nonce: params.get('nonce') },
    } as never)
    const { reply, captured } = makeReply()
    await routes
      .find((r) => r.path === '/:providerId/callback')!
      .handler(
        {
          params: { providerId: 'other' },
          query: { code: 'C', state: params.get('state') },
          body: undefined,
          headers: {},
        },
        reply,
      )
    expect(captured.status).toBe(400)
    expect(ssoBridge.signBridgeToken).not.toHaveBeenCalled()
  })

  it('an instance id that is not a slug is not served', async () => {
    const { registrations } = await bootAddon({
      config: { providers: [{ ...VIEWER_PROVIDER, id: 'a:b' }] },
    })
    const loginMethod = registrations.find((r) => r.capability.name === 'login-method')
      ?.provider as { getLoginMethods: () => Promise<readonly unknown[]> }
    expect(await loginMethod.getLoginMethods()).toEqual([])
  })

  it('a plain /start carries no link intent', async () => {
    const { claims } = await startThenCallback({})
    expect(claims).toBeDefined()
    expect(claims && 'linkIntent' in claims).toBe(false)
  })

  it('/start refuses a malformed link handle', async () => {
    const { startStatus } = await startThenCallback({ link: 'not a handle!' })
    expect(startStatus).toBe(400)
  })

  it('/callback returns 500 when the sso-bridge cap is not registered (hub boot incomplete)', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/openid-configuration'))
        return { ok: true, json: async () => DISCOVERY_DOC } as Response
      return { ok: true, json: async () => ({ id_token: 'id', access_token: 'A' }) } as Response
    })
    // The addon resolves `sso-bridge` via `ctx.api`. When the cap isn't
    // registered the tRPC link chain rejects the `.query()` with a
    // PRECONDITION_FAILED — model that here so the addon's catch block
    // surfaces it as a 500.
    const ssoBridge = makeSsoBridgeMock()
    ssoBridge.signBridgeToken.mockRejectedValue(
      new Error('Capability "sso-bridge" is not registered on any node'),
    )
    const ctx = makeCtx({ config: VIEWER_CONFIG, ssoBridge })

    const addon = new AuthOidcAddon()
    const result = await addon.initialize(ctx)
    const registrations = (
      Array.isArray(result) ? result : (result?.providers ?? [])
    ) as ReadonlyArray<{
      capability: { name: string }
      provider: unknown
    }>

    const routes = (
      registrations.find((r) => r.capability.name === 'addon-routes')!.provider as {
        getRoutes(): ReadonlyArray<{
          method: string
          path: string
          handler: (req: any, reply: any) => Promise<void>
        }>
      }
    ).getRoutes()

    // Authorize first
    const start = routes.find((r) => r.path === '/:providerId/start')!
    const { reply: startReply, captured: startCaptured } = makeReply()
    await start.handler(
      { params: { providerId: 'acme' }, query: {}, body: undefined, headers: {} },
      startReply,
    )
    const params = new URL(startCaptured.headers.get('location')!).searchParams
    const state = params.get('state')!
    const nonce = params.get('nonce')!

    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'x', nonce, preferred_username: 'u' },
    } as never)

    const cb = routes.find((r) => r.path === '/:providerId/callback')!
    const { reply, captured } = makeReply()
    await cb.handler(
      { params: { providerId: 'acme' }, query: { code: 'C', state }, body: undefined, headers: {} },
      reply,
    )
    expect(captured.status).toBe(500)
    expect((captured.body as { message: string }).message).toMatch(/sso-bridge.*not registered/)
  })
})

// ---------------------------------------------------------------------------
// State expiry / pruning
// ---------------------------------------------------------------------------

describe('AuthOidcAddon — state expiry', () => {
  it('expires state entries older than 5 minutes (STATE_TTL_MS)', async () => {
    vi.useFakeTimers()
    try {
      const { registrations } = await bootAddon({ config: VIEWER_CONFIG })
      const authProvider = registrations.find((r) => r.capability.name === 'auth-provider')!
        .provider as {
        getLoginUrl(args: { state: string }): Promise<string>
        handleCallback(params: Record<string, string>): Promise<unknown>
      }
      await authProvider.getLoginUrl({ state: 'EXPIRES' })
      // Fast-forward past 5min + 1s
      vi.advanceTimersByTime(5 * 60_000 + 1000)
      // The next getLoginUrl triggers pruneExpiredStates() — verifying via callback
      await authProvider.getLoginUrl({ state: 'ANOTHER' })
      await expect(authProvider.handleCallback({ code: 'C', state: 'EXPIRES' })).rejects.toThrow(
        'Unknown or expired',
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// The flow returns to the origin it started at (D791)
// ---------------------------------------------------------------------------

describe('AuthOidcAddon — same-origin return (D791)', () => {
  const LAN = 'https://192.0.2.10:4443'
  const PUBLIC = 'https://cams.example.top'
  const ENDPOINTS = [
    {
      label: 'LAN — eth0',
      baseUrl: LAN,
      kind: 'lan-ipv4' as const,
      interfaceKind: 'lan' as const,
      plausible: true,
      plausibleReason: '',
      priority: 0,
    },
    {
      label: 'Public tunnel',
      baseUrl: PUBLIC,
      kind: 'public' as const,
      interfaceKind: 'public' as const,
      plausible: true,
      plausibleReason: '',
      priority: 100,
    },
  ]
  const UNPINNED = { providers: [{ ...VIEWER_PROVIDER, redirectUri: '' }] }

  /** Drive /start with `headers`, then the callback; report both legs. */
  async function roundTrip(
    headers: Record<string, string>,
    opts: {
      config?: Record<string, unknown>
      query?: Record<string, string>
      logger?: IScopedLogger
      endpoints?: readonly ConnectionEndpoint[]
      listenerOrigins?: readonly string[]
    } = {},
  ): Promise<{
    authorizeRedirectUri: string | null
    tokenRedirectUri: string | null
    finish: string | undefined
  }> {
    const tokenBodies: URLSearchParams[] = []
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(
      async (url: string | URL, init?: RequestInit) => {
        const u = String(url)
        if (u.endsWith('/openid-configuration'))
          return { ok: true, json: async () => DISCOVERY_DOC } as Response
        tokenBodies.push(new URLSearchParams(String(init?.body ?? '')))
        return { ok: true, json: async () => ({ id_token: 'id', access_token: 'A' }) } as Response
      },
    )
    const { registrations } = await bootAddon({
      config: opts.config ?? UNPINNED,
      endpoints: opts.endpoints ?? ENDPOINTS,
      publicEndpointFlag: PUBLIC,
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      ...(opts.listenerOrigins !== undefined ? { listenerOrigins: opts.listenerOrigins } : {}),
    })
    const routes = (
      registrations.find((r) => r.capability.name === 'addon-routes')!.provider as {
        getRoutes(): ReadonlyArray<{
          path: string
          handler: (req: any, reply: any) => Promise<void>
        }>
      }
    ).getRoutes()
    const { reply: sr, captured: sc } = makeReply()
    await routes
      .find((r) => r.path === '/:providerId/start')!
      .handler(
        { params: { providerId: 'acme' }, query: opts.query ?? {}, body: undefined, headers },
        sr,
      )
    const authorize = new URL(sc.headers.get('location')!)
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'sub-1', nonce: authorize.searchParams.get('nonce') },
    } as never)
    const { reply, captured } = makeReply()
    await routes
      .find((r) => r.path === '/:providerId/callback')!
      .handler(
        {
          params: { providerId: 'acme' },
          query: { code: 'C', state: authorize.searchParams.get('state') },
          body: undefined,
          headers,
        },
        reply,
      )
    return {
      authorizeRedirectUri: authorize.searchParams.get('redirect_uri'),
      tokenRedirectUri: tokenBodies[0]?.get('redirect_uri') ?? null,
      finish: captured.headers.get('location'),
    }
  }

  it('a sign-in started on the LAN address returns to the LAN address, both legs alike', async () => {
    const r = await roundTrip({ host: '192.0.2.10:4443' })
    expect(r.authorizeRedirectUri).toBe(`${LAN}/addon/auth-oidc/acme/callback`)
    expect(r.tokenRedirectUri).toBe(r.authorizeRedirectUri)
    expect(r.finish).toMatch(/^https:\/\/192\.0\.2\.10:4443\/api\/auth\/sso\/finish\?bridge=/)
  })

  it('a sign-in started through the public proxy returns to the public address', async () => {
    const r = await roundTrip({
      host: '172.17.0.2:4443',
      'x-forwarded-host': 'cams.example.top',
      'x-forwarded-proto': 'https',
    })
    expect(r.authorizeRedirectUri).toBe(`${PUBLIC}/addon/auth-oidc/acme/callback`)
    expect(r.tokenRedirectUri).toBe(r.authorizeRedirectUri)
    expect(r.finish?.startsWith(`${PUBLIC}/api/auth/sso/finish?`)).toBe(true)
  })

  // LAN HTTP on: the palette carries http://<lan>:4480 only, so the https
  // listener the browser really uses is in no row — `listenerOrigins` names it.
  const LAN_HTTP_ON = [{ ...ENDPOINTS[0]!, baseUrl: 'http://192.0.2.10:4480' }, ENDPOINTS[1]!]
  const LISTENERS = [LAN, 'http://192.0.2.10:4480']

  it('LAN HTTP on: a sign-in started at the https listener returns to it, not to the public endpoint', async () => {
    const logger = makeLogger()
    const r = await roundTrip(
      { host: '192.0.2.10:4443' },
      { endpoints: LAN_HTTP_ON, listenerOrigins: LISTENERS, logger },
    )
    expect(r.authorizeRedirectUri).toBe(`${LAN}/addon/auth-oidc/acme/callback`)
    expect(r.tokenRedirectUri).toBe(r.authorizeRedirectUri)
    expect(r.finish?.startsWith(`${LAN}/api/auth/sso/finish?bridge=`)).toBe(true)
    expect(logger.info).toHaveBeenCalledWith(
      'OIDC: sign-in returns to',
      expect.objectContaining({
        meta: expect.objectContaining({ source: 'request', returnBase: LAN }),
      }),
    )
  })

  it('LAN HTTP on, an older hub without listenerOrigins: the https listener falls back to public', async () => {
    const r = await roundTrip({ host: '192.0.2.10:4443' }, { endpoints: LAN_HTTP_ON })
    expect(r.authorizeRedirectUri).toBe(`${PUBLIC}/addon/auth-oidc/acme/callback`)
  })

  it('LAN HTTP on: a forged Host still falls back to the public endpoint', async () => {
    const r = await roundTrip(
      { host: 'evil.example:4443', 'x-forwarded-proto': 'https' },
      { endpoints: LAN_HTTP_ON, listenerOrigins: LISTENERS },
    )
    expect(r.authorizeRedirectUri).toBe(`${PUBLIC}/addon/auth-oidc/acme/callback`)
    expect(r.finish?.startsWith(`${PUBLIC}/`)).toBe(true)
  })

  it('a forged Host the hub does not advertise never reaches the IdP', async () => {
    const r = await roundTrip({ host: 'evil.example', 'x-forwarded-proto': 'https' })
    expect(r.authorizeRedirectUri).toBe(`${PUBLIC}/addon/auth-oidc/acme/callback`)
    expect(r.finish?.startsWith(`${PUBLIC}/`)).toBe(true)
  })

  it('a configured redirect override pins its origin, wherever the sign-in started', async () => {
    const r = await roundTrip(
      { host: '192.0.2.10:4443' },
      {
        config: {
          providers: [
            {
              ...VIEWER_PROVIDER,
              redirectUri: 'https://pinned.example/addon/auth-oidc/acme/callback',
            },
          ],
        },
      },
    )
    expect(r.authorizeRedirectUri).toBe('https://pinned.example/addon/auth-oidc/acme/callback')
    expect(r.tokenRedirectUri).toBe(r.authorizeRedirectUri)
    expect(r.finish?.startsWith('https://pinned.example/api/auth/sso/finish?')).toBe(true)
  })

  it('says which address a sign-in returns to, and why — the only trace of a cross-origin popup finish', async () => {
    const logger = makeLogger()
    await roundTrip({ host: '192.0.2.10:4443' }, { logger })
    expect(logger.info).toHaveBeenCalledWith(
      'OIDC: sign-in returns to',
      expect.objectContaining({
        meta: expect.objectContaining({
          provider: 'acme',
          source: 'request',
          returnBase: LAN,
          claimed: [LAN, 'http://192.0.2.10:4443'],
        }),
      }),
    )
    const pinned = makeLogger()
    await roundTrip(
      { host: '192.0.2.10:4443' },
      {
        logger: pinned,
        config: {
          providers: [
            {
              ...VIEWER_PROVIDER,
              redirectUri: 'https://pinned.example/addon/auth-oidc/acme/callback',
            },
          ],
        },
      },
    )
    expect(pinned.info).toHaveBeenCalledWith(
      'OIDC: sign-in returns to',
      expect.objectContaining({
        meta: expect.objectContaining({ source: 'override', returnBase: 'https://pinned.example' }),
      }),
    )
    const forged = makeLogger()
    await roundTrip({ host: 'evil.example', 'x-forwarded-proto': 'https' }, { logger: forged })
    expect(forged.info).toHaveBeenCalledWith(
      'OIDC: sign-in returns to',
      expect.objectContaining({
        meta: expect.objectContaining({
          source: 'public-endpoint',
          claimed: ['https://evil.example'],
          advertised: expect.arrayContaining([LAN, PUBLIC]),
        }),
      }),
    )
  })

  it('keeps the relay mount prefix on the callback and the finish', async () => {
    const r = await roundTrip({ host: '192.0.2.10:4443', 'x-forwarded-prefix': '/relay/p/g1' })
    expect(r.authorizeRedirectUri).toBe(`${LAN}/relay/p/g1/addon/auth-oidc/acme/callback`)
    expect(r.finish?.startsWith(`${LAN}/relay/p/g1/api/auth/sso/finish?`)).toBe(true)
  })

  it('a popup sign-in carries popup=1 to the finish; a page sign-in does not', async () => {
    const popup = await roundTrip({ host: '192.0.2.10:4443' }, { query: { popup: '1' } })
    expect(new URL(popup.finish!).searchParams.get('popup')).toBe('1')
    const page = await roundTrip({ host: '192.0.2.10:4443' })
    expect(new URL(page.finish!).searchParams.get('popup')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Native app flow (D858)
// ---------------------------------------------------------------------------

describe('AuthOidcAddon — native app flow (D858)', () => {
  const CHALLENGE = createHash('sha256').update('app-verifier').digest('base64url')
  const APP_QUERY = {
    app: '1',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'app-state-0123456789',
    purpose: 'new-session',
  }

  async function boot(config: Record<string, unknown> = VIEWER_CONFIG) {
    const ssoBridge = makeSsoBridgeMock()
    const { registrations } = await bootAddon({ config, ssoBridge })
    const routes = (
      registrations.find((r) => r.capability.name === 'addon-routes')!.provider as {
        getRoutes(): ReadonlyArray<{
          path: string
          handler: (req: any, reply: any) => Promise<void>
        }>
      }
    ).getRoutes()
    const start = async (query: Record<string, string>) => {
      const { reply, captured } = makeReply()
      await routes
        .find((r) => r.path === '/:providerId/start')!
        .handler({ params: { providerId: 'acme' }, query, body: undefined, headers: {} }, reply)
      return captured
    }
    const callback = async (query: Record<string, string>) => {
      const { reply, captured } = makeReply()
      await routes
        .find((r) => r.path === '/:providerId/callback')!
        .handler({ params: { providerId: 'acme' }, query, body: undefined, headers: {} }, reply)
      return captured
    }
    return { registrations, ssoBridge, start, callback }
  }

  function stubIdp(): void {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/openid-configuration'))
        return { ok: true, json: async () => DISCOVERY_DOC } as Response
      return { ok: true, json: async () => ({ id_token: 'id', access_token: 'A' }) } as Response
    })
  }

  it('login-method tells a native app where to start the flow', async () => {
    const { registrations } = await boot()
    const provider = registrations.find((r) => r.capability.name === 'login-method')?.provider as {
      getLoginMethods: () => Promise<readonly Record<string, unknown>[]>
    }
    const [method] = await provider.getLoginMethods()
    expect(method?.app).toEqual({ kind: 'browser', startPath: '/addon/auth-oidc/acme/start' })
  })

  it('a valid app start redirects to the IdP and never sends the app parameters there', async () => {
    stubIdp()
    const { start } = await boot()
    const res = await start(APP_QUERY)
    expect(res.status).toBe(302)
    const location = res.headers.get('location')!
    expect(location).toMatch(/^https:\/\/idp\.example\.com\/authorize\?/)
    const params = new URL(location).searchParams
    expect(params.get('state')).toMatch(/^a\.[A-Za-z0-9_-]+$/)
    expect(params.get('code_challenge')).not.toBe(CHALLENGE)
    expect(location).not.toContain('camstack://')
    expect(location).not.toContain('app-state-0123456789')
    expect(res.headers.get('set-cookie')).toContain('camstack_sso_state=')
  })

  it.each([
    ['no challenge', { code_challenge: '' }],
    ['a short challenge', { code_challenge: 'abc' }],
    ['a plain method', { code_challenge_method: 'plain' }],
    ['no state', { state: '' }],
    ['a state with markup', { state: '<script>' }],
    ['an unknown purpose', { purpose: 'renew' }],
    ['a foreign redirect', { redirect: 'https://evil.example/cb' }],
    ['a redirect with a rider', { redirect: 'camstack://auth-callback?x=1' }],
    ['a look-alike scheme', { redirect: 'camstack.evil://auth-callback' }],
    ['a link intent', { link: 'abcdefghijklmnopqrstuvwx' }],
    ['a popup', { popup: '1' }],
  ])('an app start with %s is refused with a page, before anything is stored', async (_n, patch) => {
    stubIdp()
    const { start } = await boot()
    const query: Record<string, string> = { ...APP_QUERY }
    for (const [k, v] of Object.entries(patch)) {
      if (v === '') delete query[k]
      else query[k] = v
    }
    const res = await start(query)
    // The hub renders the sentence in its own styled page; only a reason code travels.
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toMatch(/^\/auth\/app\/refused\?reason=[a-z-]+$/)
    expect(res.headers.get('set-cookie')).toBeUndefined()
    // The refusal never echoes the app's parameters back.
    expect(String(res.headers.get('location'))).not.toContain('app-state-0123456789')
    expect(String(res.body)).not.toContain('app-state-0123456789')
  })

  it('accepts the dev client scheme when the app names it', async () => {
    stubIdp()
    const { start, callback, ssoBridge } = await boot()
    const started = await start({ ...APP_QUERY, redirect: 'camstack.dev:///auth-callback' })
    expect(started.status).toBe(302)
    const authorize = new URL(started.headers.get('location')!)
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'sub-1', nonce: authorize.searchParams.get('nonce') },
    } as never)
    await callback({ code: 'C', state: authorize.searchParams.get('state')! })
    expect(ssoBridge.signBridgeToken.mock.calls[0]?.[0].claims.app.redirect).toBe(
      'camstack.dev://auth-callback',
    )
  })

  it('the callback signs the app parameters into the bridge and finishes at finish-app', async () => {
    stubIdp()
    const { start, callback, ssoBridge } = await boot()
    const started = await start(APP_QUERY)
    const authorize = new URL(started.headers.get('location')!)
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'sub-1', nonce: authorize.searchParams.get('nonce') },
    } as never)
    const res = await callback({ code: 'C', state: authorize.searchParams.get('state')! })
    expect(res.status).toBe(302)
    const location = res.headers.get('location')!
    expect(location).toMatch(
      /^https:\/\/camstack\.example\.com\/api\/auth\/sso\/finish-app\?bridge=/,
    )
    expect(new URL(location).searchParams.get('popup')).toBeNull()
    const claims = ssoBridge.signBridgeToken.mock.calls[0]?.[0].claims
    expect(claims.app).toEqual({
      codeChallenge: CHALLENGE,
      state: 'app-state-0123456789',
      purpose: 'new-session',
      redirect: 'camstack://auth-callback',
    })
    expect(claims.browserBinding).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the app page language travels pending state -> bridge claim, and a junk value is dropped', async () => {
    stubIdp()
    const { start, callback, ssoBridge } = await boot()
    for (const [lang, expected] of [
      ['it', 'it'],
      ['<script>', undefined],
    ] as const) {
      const started = await start({ ...APP_QUERY, lang })
      const authorize = new URL(started.headers.get('location')!)
      joseMock.jwtVerify.mockResolvedValueOnce({
        payload: { sub: 'sub-1', nonce: authorize.searchParams.get('nonce') },
      } as never)
      await callback({ code: 'C', state: authorize.searchParams.get('state')! })
      const claims = ssoBridge.signBridgeToken.mock.calls.at(-1)?.[0].claims
      expect(claims.app.lang).toBe(expected)
    }
  })

  it('a refused start carries the allow-listed lang to the refusal page, never a raw value', async () => {
    stubIdp()
    const { start } = await boot()
    const it = await start({ ...APP_QUERY, state: '', lang: 'it' })
    expect(it.headers.get('location')).toBe('/auth/app/refused?reason=bad-state&lang=it')
    const junk = await start({ ...APP_QUERY, state: '', lang: '<b>' })
    expect(junk.headers.get('location')).toBe('/auth/app/refused?reason=bad-state')
  })

  it('a web sign-in carries no app claim and still finishes at /sso/finish', async () => {
    stubIdp()
    const { start, callback, ssoBridge } = await boot()
    const started = await start({})
    const authorize = new URL(started.headers.get('location')!)
    expect(authorize.searchParams.get('state')).not.toMatch(/^a\./)
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'sub-1', nonce: authorize.searchParams.get('nonce') },
    } as never)
    const res = await callback({ code: 'C', state: authorize.searchParams.get('state')! })
    expect(res.headers.get('location')).toMatch(/\/api\/auth\/sso\/finish\?bridge=/)
    expect(ssoBridge.signBridgeToken.mock.calls[0]?.[0].claims.app).toBeUndefined()
  })

  it('an IdP error is answered at the app with the app state', async () => {
    stubIdp()
    const { start, callback } = await boot()
    const started = await start(APP_QUERY)
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!
    const res = await callback({ error: 'access_denied', state })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'camstack://auth-callback?error=idp-error&state=app-state-0123456789',
    )
  })

  it('a failed token exchange is answered at the app, not on a hub error page', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/openid-configuration'))
        return { ok: true, json: async () => DISCOVERY_DOC } as Response
      return { ok: false, status: 400, statusText: 'Bad', text: async () => '' } as Response
    })
    const { start, callback } = await boot()
    const started = await start(APP_QUERY)
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!
    const res = await callback({ code: 'C', state })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'camstack://auth-callback?error=idp-failed&state=app-state-0123456789',
    )
  })

  it('a replayed app state is refused at the fixed default callback', async () => {
    stubIdp()
    const { start, callback } = await boot()
    const started = await start(APP_QUERY)
    const authorize = new URL(started.headers.get('location')!)
    const state = authorize.searchParams.get('state')!
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'sub-1', nonce: authorize.searchParams.get('nonce') },
    } as never)
    await callback({ code: 'C', state })
    const replay = await callback({ code: 'C', state })
    expect(replay.status).toBe(302)
    expect(replay.headers.get('location')).toBe('camstack://auth-callback?error=state-expired')
  })

  it('an expired app state is refused at the default callback', async () => {
    stubIdp()
    const { start, callback } = await boot()
    const started = await start(APP_QUERY)
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000)
    const res = await callback({ code: 'C', state })
    expect(res.headers.get('location')).toBe('camstack://auth-callback?error=state-expired')
  })

  it('an unknown NON-app state keeps the web behaviour (a JSON error, never the app)', async () => {
    stubIdp()
    const { callback } = await boot()
    const res = await callback({ code: 'C', state: 'plain-unknown-state' })
    expect(res.status).toBe(500)
    expect(res.headers.get('location')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Step-up freshness and the pending-state bound (D858)
// ---------------------------------------------------------------------------

describe('AuthOidcAddon — step-up freshness and bounded pending states (D858)', () => {
  const CHALLENGE = createHash('sha256').update('app-verifier').digest('base64url')
  const APP = {
    app: '1',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'app-state-0123456789',
  }

  async function boot() {
    const ssoBridge = makeSsoBridgeMock()
    const { registrations } = await bootAddon({ config: VIEWER_CONFIG, ssoBridge })
    const routes = (
      registrations.find((r) => r.capability.name === 'addon-routes')!.provider as {
        getRoutes(): ReadonlyArray<{
          path: string
          handler: (req: any, reply: any) => Promise<void>
        }>
      }
    ).getRoutes()
    const call = async (
      path: string,
      query: Record<string, string>,
      headers: Record<string, string> = {},
    ) => {
      const { reply, captured } = makeReply()
      await routes
        .find((r) => r.path === path)!
        .handler({ params: { providerId: 'acme' }, query, body: undefined, headers }, reply)
      return captured
    }
    return {
      ssoBridge,
      start: (q: Record<string, string>, h?: Record<string, string>) =>
        call('/:providerId/start', q, h),
      callback: (q: Record<string, string>) => call('/:providerId/callback', q),
    }
  }

  function stubIdp(): void {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/openid-configuration'))
        return { ok: true, json: async () => DISCOVERY_DOC } as Response
      return { ok: true, json: async () => ({ id_token: 'id', access_token: 'A' }) } as Response
    })
  }

  async function stepUp(extra: Record<string, unknown>) {
    stubIdp()
    const h = await boot()
    const started = await h.start({ ...APP, purpose: 'step-up' })
    const authorize = new URL(started.headers.get('location')!)
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'sub-1', nonce: authorize.searchParams.get('nonce'), ...extra },
    } as never)
    const res = await h.callback({ code: 'C', state: authorize.searchParams.get('state')! })
    return { authorize, res, ...h }
  }

  it('a step-up asks the IdP for a fresh login; a new-session does not', async () => {
    stubIdp()
    const { start } = await boot()
    const up = new URL((await start({ ...APP, purpose: 'step-up' })).headers.get('location')!)
    expect(up.searchParams.get('prompt')).toBe('login')
    expect(up.searchParams.get('max_age')).toBe('0')
    const fresh = new URL(
      (await start({ ...APP, purpose: 'new-session' })).headers.get('location')!,
    )
    expect(fresh.searchParams.has('prompt')).toBe(false)
    expect(fresh.searchParams.has('max_age')).toBe(false)
  })

  it('a step-up id_token with a fresh auth_time goes on to the finish', async () => {
    const { res, ssoBridge } = await stepUp({ auth_time: Math.floor(Date.now() / 1000) })
    expect(res.headers.get('location')).toMatch(/\/api\/auth\/sso\/finish-app\?bridge=/)
    expect(ssoBridge.signBridgeToken).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no auth_time', {}],
    ['an auth_time an hour old', { auth_time: Math.floor(Date.now() / 1000) - 3600 }],
    ['a non-numeric auth_time', { auth_time: 'now' }],
  ])('a step-up id_token with %s is refused at the app, no bridge minted', async (_n, extra) => {
    const { res, ssoBridge } = await stepUp(extra)
    expect(res.headers.get('location')).toBe(
      'camstack://auth-callback?error=step-up-not-fresh&state=app-state-0123456789',
    )
    expect(ssoBridge.signBridgeToken).not.toHaveBeenCalled()
  })

  it('a new-session needs no auth_time', async () => {
    stubIdp()
    const { start, callback, ssoBridge } = await boot()
    const started = await start({ ...APP, purpose: 'new-session' })
    const authorize = new URL(started.headers.get('location')!)
    joseMock.jwtVerify.mockResolvedValueOnce({
      payload: { sub: 'sub-1', nonce: authorize.searchParams.get('nonce') },
    } as never)
    await callback({ code: 'C', state: authorize.searchParams.get('state')! })
    expect(ssoBridge.signBridgeToken).toHaveBeenCalledTimes(1)
  })

  it('one client cannot hold more than its share of pending sign-ins', async () => {
    stubIdp()
    const { start } = await boot()
    const mine = { 'x-real-ip': '203.0.113.7' }
    for (let i = 0; i < 20; i += 1) expect((await start({}, mine)).status).toBe(302)
    const refused = await start({}, mine)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('30')
    // Another client is unaffected.
    expect((await start({}, { 'x-real-ip': '203.0.113.8' })).status).toBe(302)
  })

  it('an app start that is refused for room is answered at the app', async () => {
    stubIdp()
    const { start } = await boot()
    const mine = { 'x-real-ip': '203.0.113.9' }
    for (let i = 0; i < 20; i += 1) await start({}, mine)
    const refused = await start({ ...APP, purpose: 'new-session' }, mine)
    expect(refused.status).toBe(302)
    expect(refused.headers.get('location')).toBe(
      'camstack://auth-callback?error=too-many-requests&state=app-state-0123456789',
    )
  })

  it('a full map refuses new sign-ins; expired ones make room first', async () => {
    stubIdp()
    const { start } = await boot()
    for (let i = 0; i < 1_000; i += 1) await start({}, { 'x-real-ip': `10.1.${i >> 8}.${i & 255}` })
    const refused = await start({}, { 'x-real-ip': '10.9.9.9' })
    expect(refused.status).toBe(429)
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000)
    expect((await start({}, { 'x-real-ip': '10.9.9.9' })).status).toBe(302)
    spy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// A connection whose secret marker is bound to the settings path (issue #4)
// ---------------------------------------------------------------------------

function makeSpecKeychain(owner: string): { readonly access: SecretsAccess } {
  const values = new Map<string, string>()
  const access: SecretsAccess = {
    owner,
    ref: (scope: SecretScope, fieldPath: string) => buildSecretRef({ owner, scope, fieldPath }),
    resolve: async (refs) =>
      Object.fromEntries(
        refs.map((ref) => {
          const value = values.get(ref)
          return [
            ref,
            value === undefined
              ? { kind: 'missing' as const }
              : { kind: 'value' as const, value, version: 1 },
          ]
        }),
      ),
    put: async (ref, value) => {
      values.set(ref, value)
      return 1
    },
    delete: async (refs) => refs.filter((r) => values.delete(r)).length,
    state: async () => ({ state: 'ready' }),
    onChange: () => () => undefined,
    forOwner: null,
  }
  return { access }
}

describe('auth-oidc connections with a settings-bound secret marker', () => {
  interface ConnectionsApi {
    listConnections(): Promise<ReadonlyArray<{ id: string }>>
    createConnection(i: { id: string; displayName: string }): Promise<{ id: string }>
    updateConnection(i: { id: string; displayName: string; clientId?: string }): Promise<unknown>
    deleteConnection(i: { id: string }): Promise<unknown>
  }

  async function bootStuck(opts: { readonly keychainHasValue?: boolean } = {}) {
    const keychain = makeSpecKeychain('auth')
    const settingsRef = keychain.access.ref(
      globalSecretScope(),
      arrayItemFieldPath('providers', 'prod01', 'clientSecret'),
    )
    if (opts.keychainHasValue !== false) await keychain.access.put(settingsRef, 'real-secret')
    const recordsWorld = makeInMemoryRecords('auth')
    const config = {
      providers: [
        {
          ...VIEWER_PROVIDER,
          id: 'prod01',
          clientSecret: { $secret: settingsRef, v: 1 },
        },
      ],
    }
    const { registrations, ctx } = await bootAddon({
      config,
      secrets: keychain.access,
      recordsWorld,
    })
    const api = registrations.find((r) => r.capability.name === 'oidc-connections')!
      .provider as ConnectionsApi
    return { api, ctx, recordsWorld }
  }

  it('edits the row without retyping the secret and keeps the stored secret', async () => {
    const { api, recordsWorld } = await bootStuck()
    await api.updateConnection({ id: 'prod01', displayName: 'Renamed', clientId: 'new-id' })
    const row = await recordsWorld.records.kind(oidcProviderEntryKind).getResolved('prod01')
    expect(row?.data.displayName).toBe('Renamed')
    expect(row?.data.clientSecret).toBe('real-secret')
  })

  it('deletes the row', async () => {
    const { api, recordsWorld } = await bootStuck()
    await api.deleteConnection({ id: 'prod01' })
    expect(await api.listConnections()).toEqual([])
    expect(
      (await recordsWorld.records.kind(oidcProviderEntryKind).query({ limit: 10 })).records,
    ).toHaveLength(0)
  })

  it('creates a connection with another slug next to the stuck one', async () => {
    const { api, recordsWorld } = await bootStuck()
    await api.createConnection({ id: 'second', displayName: 'Second' })
    expect((await api.listConnections()).map((c) => c.id).sort()).toEqual(['prod01', 'second'])
    const kept = await recordsWorld.records.kind(oidcProviderEntryKind).getResolved('prod01')
    expect(kept?.data.clientSecret).toBe('real-secret')
  })

  it('edits and creates next to a row whose settings-bound secret no longer resolves', async () => {
    const { api } = await bootStuck({ keychainHasValue: false })
    await api.updateConnection({ id: 'prod01', displayName: 'Renamed' })
    await api.createConnection({ id: 'second', displayName: 'Second' })
    expect((await api.listConnections()).map((c) => c.id).sort()).toEqual(['prod01', 'second'])
  })

  it('a public client (no secret) is a valid connection', async () => {
    const { api } = await bootStuck()
    await api.createConnection({ id: 'pub', displayName: 'Public' })
    await api.updateConnection({ id: 'pub', displayName: 'Public', clientId: 'pub-client' })
    const listed = await (
      api as unknown as {
        listConnections(): Promise<ReadonlyArray<{ id: string; configured: boolean }>>
      }
    ).listConnections()
    expect(listed.find((c) => c.id === 'pub')?.configured).toBe(true)
  })
})
