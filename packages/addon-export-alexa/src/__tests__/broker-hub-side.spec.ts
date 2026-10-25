/**
 * The hub's half of the skill token broker (D753): it holds no LWA client
 * secret, renews Event Gateway tokens through the broker, migrates a pre-D753
 * refresh token away from itself, and believes a broker advertisement only on
 * a directive whose bearer verified.
 */
import { snapshotsOff } from './helpers/allow-all-access.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddonContext, AddonHttpReply, AddonHttpRequest } from '@camstack/types'

import {
  BrokerError,
  fetchBrokerAccessToken,
  migrateLegacyGrant,
  normaliseBrokerUrl,
} from '../broker-client.js'
import { handleBrokerLinkCallback } from '../handlers/broker-link-callback.js'
import type { LwaTokensCallbackDeps } from '../handlers/lwa-tokens-callback.js'
import { BROKER_HEADER, buildRoutes, type HttpRouteDeps } from '../http-server.js'
import { LwaEventGateway, type LwaEventGatewayDeps } from '../lwa-event-gateway.js'
import type { LwaTokenEntry, UpsertLwaTokenInput } from '../types.js'

const BROKER = 'https://broker.example.test'
const CRED = 'csb1.linkidlinkidlinkid.secretsecretsecretsecretsecretsecret'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  withTags: () => noopLogger,
} as unknown as LwaEventGatewayDeps['logger']

// ── broker-client ────────────────────────────────────────────────────

describe('normaliseBrokerUrl', () => {
  it('keeps an https origin and drops everything else', () => {
    expect(normaliseBrokerUrl('https://broker.example.test/token?x=1')).toBe(BROKER)
    expect(normaliseBrokerUrl('http://broker.example.test')).toBeNull()
    expect(normaliseBrokerUrl('https://user:pw@broker.example.test')).toBeNull()
    expect(normaliseBrokerUrl('not a url')).toBeNull()
    expect(normaliseBrokerUrl(42)).toBeNull()
  })
})

describe('broker client', () => {
  it('sends the credential as a bearer to /broker/token and parses the answer', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, { accessToken: 'AT', expiresAt: 123 }),
    )
    const out = await fetchBrokerAccessToken(fetchImpl, BROKER, CRED)
    expect(out).toEqual({ accessToken: 'AT', expiresAt: 123 })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe(`${BROKER}/broker/token`)
    const headers = init?.headers as Record<string, string> | undefined
    expect(headers?.authorization).toBe(`Bearer ${CRED}`)
  })

  it('classifies failures so the caller can tell re-link from retry', async () => {
    const cases: Array<[number, string]> = [
      [401, 'unauthorized'],
      [410, 'revoked'],
      [400, 'rejected'],
      [503, 'unavailable'],
    ]
    for (const [status, kind] of cases) {
      const err = await fetchBrokerAccessToken(
        async () => jsonResponse(status, { error: 'x' }),
        BROKER,
        CRED,
      ).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BrokerError)
      expect((err as BrokerError).kind).toBe(kind)
      expect(String(err)).not.toContain(CRED)
    }
  })

  it('refuses to send a credential to a non-https broker', async () => {
    const fetchImpl = vi.fn()
    const err = await fetchBrokerAccessToken(fetchImpl, 'http://evil.test', CRED).catch(
      (e: unknown) => e,
    )
    expect((err as BrokerError).kind).toBe('rejected')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('migrates a refresh token in the request body only', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, {
        brokerCredential: CRED,
        brokerUrl: BROKER,
        accessToken: 'AT',
        expiresAt: 1,
      }),
    )
    await migrateLegacyGrant(fetchImpl, BROKER, { refreshToken: 'RT' })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe(`${BROKER}/broker/migrate`)
    expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'RT' })
  })
})

// ── Gateway renewal ──────────────────────────────────────────────────

function gatewayHarness(opts: {
  tokens: LwaTokenEntry[]
  advertised?: string | null
  fetchImpl: LwaEventGatewayDeps['fetchImpl']
}) {
  let tokens = [...opts.tokens]
  const upserts: UpsertLwaTokenInput[] = []
  const removed: string[] = []
  const deps: LwaEventGatewayDeps = {
    ctx: {
      eventBus: { subscribe: () => () => {} },
      api: {},
    } as unknown as LwaEventGatewayDeps['ctx'],
    logger: noopLogger,
    listExposed: () => [],
    listLinkedAccounts: () => [{ userId: 'u1', username: 'u1', linkedAt: 0 }],
    listTokens: () => tokens,
    upsertToken: async (input) => {
      upserts.push(input)
      tokens = [
        ...tokens.filter((t) => t.userId !== input.userId),
        { ...input, receivedAt: Date.now() },
      ]
    },
    removeLinkedAccount: async (userId) => {
      removed.push(userId)
      tokens = tokens.filter((t) => t.userId !== userId)
    },
    getAdvertisedBrokerUrl: () => opts.advertised ?? null,
    getRegion: () => 'EU',
    getExportedSignature: () => null,
    accountMaySee: () => true,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }
  return { gateway: new LwaEventGateway(deps), upserts, removed, tokens: () => tokens }
}

const brokerGrant = (over: Partial<LwaTokenEntry> = {}): LwaTokenEntry => ({
  userId: 'u1',
  accessToken: 'AT-old',
  expiresAt: Date.now() + 3_600_000,
  receivedAt: 0,
  brokerUrl: BROKER,
  brokerCredential: CRED,
  ...over,
})

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(1_800_000_000_000)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('gateway renewal through the broker', () => {
  it('on a gateway 401, renews via the broker and retries with the new token', async () => {
    const brokerFetch = vi.fn(async () =>
      jsonResponse(200, { accessToken: 'AT-new', expiresAt: 9 }),
    )
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const auth = (init.headers as Record<string, string>).Authorization ?? ''
        sent.push(auth)
        return new Response('', { status: auth === 'Bearer AT-old' ? 401 : 202 })
      }),
    )
    const h = gatewayHarness({ tokens: [brokerGrant()], fetchImpl: brokerFetch })
    const ok = await h.gateway.postReport('u1', (t) => ({ token: t }), 'x')
    expect(ok).toBe(true)
    expect(sent).toEqual(['Bearer AT-old', 'Bearer AT-new'])
    expect(h.upserts[0]).toEqual({
      userId: 'u1',
      accessToken: 'AT-new',
      expiresAt: 9,
      brokerUrl: BROKER,
      brokerCredential: CRED,
    })
  })

  it('drops the link when the broker no longer recognises the credential', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    )
    const h = gatewayHarness({
      tokens: [brokerGrant()],
      fetchImpl: async () => jsonResponse(401, { error: 'invalid_credential' }),
    })
    await h.gateway.postReport('u1', () => ({}), 'x')
    expect(h.removed).toEqual(['u1'])
  })

  it('keeps the link on a transient broker failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    )
    const h = gatewayHarness({
      tokens: [brokerGrant()],
      fetchImpl: async () => jsonResponse(503, { error: 'lwa_unavailable' }),
    })
    await h.gateway.postReport('u1', () => ({}), 'x')
    expect(h.removed).toEqual([])
  })
})

describe('legacy (pre-D753) grant migration', () => {
  const legacy: LwaTokenEntry = {
    userId: 'u1',
    accessToken: 'AT-legacy',
    refreshToken: 'RT-legacy',
    expiresAt: Date.now() + 3_600_000,
    receivedAt: 0,
  }

  it('waits, without any network call, until the broker is advertised', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    )
    const h = gatewayHarness({ tokens: [legacy], advertised: null, fetchImpl })
    await h.gateway.postReport('u1', () => ({}), 'x')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(h.tokens()[0]?.refreshToken).toBe('RT-legacy')
  })

  it('migrates on the next scan and deletes the refresh token from the hub', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, {
        brokerCredential: CRED,
        brokerUrl: BROKER,
        accessToken: 'AT-migrated',
        expiresAt: Date.now() + 3_600_000,
      }),
    )
    const h = gatewayHarness({ tokens: [legacy], advertised: BROKER, fetchImpl })
    h.gateway.start()
    await vi.advanceTimersByTimeAsync(60_000)
    h.gateway.stop()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${BROKER}/broker/migrate`)
    const [entry] = h.tokens()
    expect(entry?.refreshToken).toBeUndefined()
    expect(entry).toMatchObject({
      accessToken: 'AT-migrated',
      brokerUrl: BROKER,
      brokerCredential: CRED,
    })
  })

  it('treats a refused migration (dead grant) as an unlink', async () => {
    const h = gatewayHarness({
      tokens: [legacy],
      advertised: BROKER,
      fetchImpl: async () => jsonResponse(400, { error: 'invalid_grant' }),
    })
    h.gateway.start()
    await vi.advanceTimersByTimeAsync(60_000)
    h.gateway.stop()
    expect(h.removed).toEqual(['u1'])
  })
})

// ── /oauth/broker-link ───────────────────────────────────────────────

function reply() {
  const r = {
    status: 0,
    body: undefined as unknown,
    code(n: number) {
      r.status = n
      return { send: (b: unknown) => void (r.body = b) }
    },
  }
  return r
}

function callbackDeps(verified: unknown) {
  const upserts: UpsertLwaTokenInput[] = []
  const linked: string[] = []
  const deps: LwaTokensCallbackDeps = {
    ctx: {
      api: {
        userManagement: { oauthVerifyAccessToken: { query: vi.fn().mockResolvedValue(verified) } },
      },
    } as unknown as AddonContext,
    logger: noopLogger,
    upsertToken: async (i) => void upserts.push(i),
    recordLinkedAccount: async (i) => void linked.push(i.userId),
  }
  return { deps, upserts, linked }
}

const VERIFIED = { userId: 'u1', username: 'op', scopes: [] }

describe('POST /oauth/broker-link', () => {
  const body = {
    brokerUrl: `${BROKER}/token`,
    brokerCredential: CRED,
    lwaAccessToken: 'AT',
    expiresAt: 5,
  }

  it('stores the credential (never a refresh token) and records the link', async () => {
    const c = callbackDeps(VERIFIED)
    const r = reply()
    await handleBrokerLinkCallback(
      { body, headers: { authorization: 'Bearer grantee' } } as unknown as AddonHttpRequest,
      r as unknown as AddonHttpReply,
      c.deps,
    )
    expect(r.status).toBe(200)
    expect(c.upserts).toEqual([
      { userId: 'u1', accessToken: 'AT', expiresAt: 5, brokerUrl: BROKER, brokerCredential: CRED },
    ])
    expect(c.linked).toEqual(['u1'])
  })

  it('refuses a non-https broker URL', async () => {
    const c = callbackDeps(VERIFIED)
    const r = reply()
    await handleBrokerLinkCallback(
      {
        body: { ...body, brokerUrl: 'http://broker.example.test' },
        headers: { authorization: 'Bearer grantee' },
      } as unknown as AddonHttpRequest,
      r as unknown as AddonHttpReply,
      c.deps,
    )
    expect(r.status).toBe(400)
    expect(c.upserts).toEqual([])
  })

  it('refuses a caller whose bearer does not verify', async () => {
    const c = callbackDeps(null)
    const r = reply()
    await handleBrokerLinkCallback(
      { body, headers: { authorization: 'Bearer forged' } } as unknown as AddonHttpRequest,
      r as unknown as AddonHttpReply,
      c.deps,
    )
    expect(r.status).toBe(401)
    expect(c.upserts).toEqual([])
  })
})

// ── Broker advertisement on /directive ───────────────────────────────

describe('broker advertisement', () => {
  function routeDeps(verified: unknown, onBrokerAdvertised: (u: string) => void): HttpRouteDeps {
    const c = callbackDeps(verified)
    return {
      ctx: c.deps.ctx,
      logger: noopLogger,
      getSettings: () =>
        ({ enforceIngressToken: false, ingressToken: '', expectedAudience: 'skill' }) as never,
      directiveDeps: {} as HttpRouteDeps['directiveDeps'],
      snapshotRoute: snapshotsOff().route,
      lwaTokensCallbackDeps: c.deps,
      redetectPublicHubUrl: async () => ({ publicHubUrl: '' }),
      onBrokerAdvertised,
    }
  }

  async function postDirective(deps: HttpRouteDeps) {
    const route = buildRoutes(deps).find((r) => r.path === '/directive')
    const r = reply()
    await route?.handler(
      {
        body: { directive: { payload: { scope: { token: 'bearer' } } } },
        headers: { [BROKER_HEADER]: BROKER },
      } as unknown as AddonHttpRequest,
      r as unknown as AddonHttpReply,
    )
  }

  it('is believed only after the directive bearer verified', async () => {
    const seen: string[] = []
    await postDirective(routeDeps(null, (u) => seen.push(u)))
    expect(seen).toEqual([])
    await postDirective(
      routeDeps(
        { ...VERIFIED, scopes: [{ type: 'category', target: 'device', access: ['view'] }] },
        (u) => seen.push(u),
      ),
    )
    expect(seen).toEqual([BROKER])
  })

  it('exposes the broker-link route', () => {
    const paths = buildRoutes(routeDeps(null, () => {})).map((r) => r.path)
    expect(paths).toContain('/oauth/broker-link')
    expect(paths).toContain('/oauth/lwa-tokens')
  })
})
