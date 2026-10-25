/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/consistent-type-assertions -- test file, mock typing */
// server/backend/src/__tests__/oauth2-account-linking.spec.ts
//
// Integration test for the OAuth2 account-linking flow.
//
// Approach: in-process Fastify integration test using fastify.inject() —
// no real network, no hub boot required.
//
// The sso-bridge stand-in is a real HMAC-JWT implementation backed by
// Node's `crypto.createHmac` so access_token JWTs are genuine and their
// payloads can be base64url-decoded and inspected (case 5).
//

import * as crypto from 'node:crypto'
import type {
  IOauthIntegrationProvider,
  IScopedLogger,
  ISsoBridgeProvider,
  IUserManagementProvider,
  LogExtras,
  TokenScope,
} from '@camstack/types'
import { OauthIntegrationDescriptorSchema } from '@camstack/types'
import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildAlexaOauthIntegration } from '../../../../packages/addon-export-alexa/src/oauth-integration.js'
import { HOME_ASSISTANT_OAUTH_INTEGRATION } from '../../../../packages/addon-provider-homeassistant/src/ha-export/oauth-integration.js'
import { createOauthGrants } from '../../../../packages/system/src/builtins/local-auth/oauth-grants.js'
import type { OauthSession } from '../../../../packages/system/src/builtins/local-auth/oauth-session-manager.js'
import { registerOauth2Routes } from '../api/oauth2/oauth2-routes.js'
import { checkScopeAccess } from '../api/trpc/scope-access.js'
import { SESSION_COOKIE } from '../auth/session-cookie.js'

// ─── HMAC-JWT sso-bridge stand-in ────────────────────────────────────────────
//
// Produces genuine JWTs (header.payload.signature) whose payload segment is
// standard base64url-encoded JSON — so the test can decode the access token
// claims without any special tooling.

const JWT_SECRET = crypto.randomBytes(32).toString('hex')

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** `'never'` is the cap's own "no expiry": the token then carries no `exp`. */
function makeHmacJwt(payload: Record<string, unknown>, ttlSec: number | 'never'): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const now = Math.floor(Date.now() / 1000)
  const body = base64url(
    Buffer.from(
      JSON.stringify({
        ...payload,
        iat: now,
        ...(ttlSec === 'never' ? {} : { exp: now + ttlSec }),
      }),
    ),
  )
  const sig = base64url(
    crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest(),
  )
  return `${header}.${body}.${sig}`
}

function verifyHmacJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts as [string, string, string]
  const expected = base64url(
    crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest(),
  )
  if (sig !== expected) return null
  try {
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    if (typeof decoded['exp'] === 'number' && decoded['exp'] < Math.floor(Date.now() / 1000)) {
      return null
    }
    return decoded
  } catch {
    return null
  }
}

const realSsoBridge: ISsoBridgeProvider = {
  signBridgeToken: async ({ claims, ttlSec }) => ({
    token: makeHmacJwt(claims as Record<string, unknown>, ttlSec ?? 300),
  }),
  verifyBridgeToken: async ({ token }) => {
    const decoded = verifyHmacJwt(token)
    if (!decoded) return null
    return decoded as any
  },
}

// ─── In-memory fake OauthSessionManager ──────────────────────────────────────
//
// Mirrors the pattern in oauth-grants.spec.ts. The same instance is shared
// between createOauthGrants and the fake user-management provider so sessions
// created during token exchange are visible to listOauthSessions/revokeOauthSession.

function fakeSessionManager() {
  const store = new Map<string, OauthSession>()
  let seq = 0

  return {
    store,
    async create(input: {
      userId: string
      username: string
      integrationId: string
      scopes: TokenScope[]
    }): Promise<OauthSession> {
      const now = Date.now()
      const session: OauthSession = {
        id: `session-${++seq}`,
        userId: input.userId,
        username: input.username,
        integrationId: input.integrationId,
        scopes: input.scopes,
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null,
      }
      store.set(session.id, session)
      return session
    },
    async list(): Promise<OauthSession[]> {
      return Array.from(store.values())
    },
    async getById(id: string): Promise<OauthSession | null> {
      return store.get(id) ?? null
    },
    async markRevoked(id: string): Promise<boolean> {
      const existing = store.get(id)
      if (!existing) return false
      if (existing.revokedAt !== null) return true
      store.set(id, { ...existing, revokedAt: Date.now() })
      return true
    },
    async touch(id: string): Promise<void> {
      const existing = store.get(id)
      if (!existing) return
      store.set(id, { ...existing, lastUsedAt: Date.now() })
    },
  }
}

// ─── Fixed operator credentials ───────────────────────────────────────────────

const OPERATOR_USER_ID = 'user-1'
const OPERATOR_USERNAME = 'operator'
const VALID_SESSION_TOKEN = 'valid-session-token-abc123'

// ─── Alexa integration descriptor ────────────────────────────────────────────

const ALEXA_DESCRIPTOR = {
  integrationId: 'export-alexa',
  displayName: 'Alexa Smart Home',
  requestedScopes: [
    {
      type: 'category' as const,
      target: 'device' as const,
      access: ['view', 'create'] as ('view' | 'create' | 'delete')[],
    },
  ],
  allowedRedirectPrefixes: ['https://cb.example/'],
}

const REDIRECT_URI = 'https://cb.example/oauth/callback'
const STATE = 'random-state-xyz'

// ─── Fake registry ────────────────────────────────────────────────────────────
//
// Minimal CapabilityRegistry-shaped object. Only the methods called by
// oauth2-routes are needed: getCollectionEntries, getManifestDeclarers,
// hasProvider and getSingleton.
//
// The sessionManager is shared between createOauthGrants and the fake
// user-management provider so sessions created during exchange are visible
// to listOauthSessions/revokeOauthSession.

/** The addon ids that declare `oauth-integration` on a stock hub. Real ids —
 *  they appear in the /authorize refusal body and in the log line, and a fake
 *  that invented them would let a rename ship green. */
const ALEXA_ADDON_ID = 'export-alexa'
const HA_ADDON_ID = 'homeassistant-export'

interface FakeRegistryOptions {
  /** Addons whose MANIFEST declares `oauth-integration` (known at addon-load
   *  time, i.e. before a forked runner has booted). */
  readonly declarers?: readonly string[]
  /** Addons that have actually REGISTERED their provider. Anything declared
   *  but absent here is a descriptor the hub is still waiting for. */
  readonly registered?: readonly string[]
}

function buildFakeRegistry(
  grants: ReturnType<typeof createOauthGrants>,
  sessionManager: ReturnType<typeof fakeSessionManager>,
  options: FakeRegistryOptions = {},
): { getCollectionEntries: any; getManifestDeclarers: any; hasProvider: any; getSingleton: any } {
  const alexaProvider: IOauthIntegrationProvider = {
    getDescriptor: async () => ALEXA_DESCRIPTOR,
  }

  const userMgmt: IUserManagementProvider = {
    ...({} as IUserManagementProvider),
    oauthIssueCode: grants.oauthIssueCode.bind(grants),
    oauthExchangeCode: grants.oauthExchangeCode.bind(grants),
    oauthRefresh: grants.oauthRefresh.bind(grants),
    oauthVerifyAccessToken: grants.oauthVerifyAccessToken.bind(grants),
    listOauthSessions: async () => {
      const sessions = await sessionManager.list()
      return sessions.map((s) => ({
        id: s.id,
        userId: s.userId,
        username: s.username,
        integrationId: s.integrationId,
        scopes: s.scopes,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        revokedAt: s.revokedAt,
      }))
    },
    revokeOauthSession: async (input: { id: string }) => {
      const ok = await sessionManager.markRevoked(input.id)
      return { success: ok }
    },
  }

  // The REAL shipped descriptor, not a copy: a test against an invented
  // Home Assistant descriptor would keep passing after the shipped one drifted.
  const homeAssistantProvider: IOauthIntegrationProvider = {
    getDescriptor: async () => HOME_ASSISTANT_OAUTH_INTEGRATION,
  }

  const providersByAddon = new Map<string, IOauthIntegrationProvider>([
    [ALEXA_ADDON_ID, alexaProvider],
    [HA_ADDON_ID, homeAssistantProvider],
  ])
  const declarers = options.declarers ?? [ALEXA_ADDON_ID, HA_ADDON_ID]
  const registered = options.registered ?? [ALEXA_ADDON_ID, HA_ADDON_ID]

  return {
    getCollectionEntries: (cap: string) => {
      if (cap !== 'oauth-integration') return []
      return registered
        .map((addonId) => [addonId, providersByAddon.get(addonId)])
        .filter((e) => e[1] !== undefined) as [string, IOauthIntegrationProvider][]
    },
    getManifestDeclarers: (cap: string) => (cap === 'oauth-integration' ? declarers : []),
    hasProvider: (cap: string, addonId: string) =>
      cap === 'oauth-integration' && registered.includes(addonId),
    getSingleton: (cap: string) => {
      if (cap === 'user-management') return userMgmt
      return null
    },
  }
}

// ─── Test setup ───────────────────────────────────────────────────────────────

/** Every `warn` the routes emitted during the current test. A refusal that
 *  logs nothing is how Alexa linking stayed broken until an operator noticed:
 *  in Loki, silence reads as "the request never arrived". */
interface CapturedLog {
  readonly message: string
  readonly extras?: LogExtras
}
let capturedWarnings: CapturedLog[] = []
/** Every `info` the routes emitted. The login bounce lives here: it is not a
 *  fault, but it DEFERS the request and loses whatever the replay drops, so a
 *  refusal that follows it is only interpretable next to it. */
let capturedInfos: CapturedLog[] = []

function capturingLogger(): IScopedLogger {
  const sink: IScopedLogger = {
    debug: () => {},
    info: (message: string, extras?: LogExtras) => {
      capturedInfos.push(extras === undefined ? { message } : { message, extras })
    },
    warn: (message: string, extras?: LogExtras) => {
      capturedWarnings.push(extras === undefined ? { message } : { message, extras })
    },
    error: () => {},
    child: () => sink,
    withTags: () => sink,
  }
  return sink
}

function buildApp(
  grants: ReturnType<typeof createOauthGrants>,
  sessionManager: ReturnType<typeof fakeSessionManager>,
  registryOptions: FakeRegistryOptions = {},
) {
  const fastify = Fastify({ logger: false })
  void fastify.register(cookie)

  const fakeRegistry = buildFakeRegistry(grants, sessionManager, registryOptions)

  registerOauth2Routes(fastify, {
    getRegistry: () => fakeRegistry as any,
    isLiveUser: async () => true,
    verifyToken: (token: string) => {
      if (token === VALID_SESSION_TOKEN) {
        return { userId: OPERATOR_USER_ID, username: OPERATOR_USERNAME, isAdmin: true }
      }
      throw new Error('invalid token')
    },
    publicHubUrl: async () => 'https://hub.example.com',
    logger: capturingLogger(),
  })

  return fastify
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OAuth2 account-linking flow', () => {
  let grants: ReturnType<typeof createOauthGrants>
  let sessionManager: ReturnType<typeof fakeSessionManager>
  let app: ReturnType<typeof buildApp>

  beforeEach(() => {
    // Fresh session manager + grants instance per test so state is clean.
    sessionManager = fakeSessionManager()
    grants = createOauthGrants(realSsoBridge, sessionManager as any)
    capturedWarnings = []
    app = buildApp(grants, sessionManager)
  })

  // ── Case 1 ──────────────────────────────────────────────────────────────────
  it('GET /api/oauth2/authorize with no session cookie and Accept: text/html → 302 to /login', async () => {
    const url = `/api/oauth2/authorize?response_type=code&integration=export-alexa&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${STATE}`
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { accept: 'text/html,application/xhtml+xml' },
    })

    expect(res.statusCode).toBe(302)
    const location = res.headers['location'] as string
    expect(location).toContain('/login?next=')

    // ROUND TRIP. The whole OAuth request lives in this query string, so the
    // bounce owes it back byte for byte — `next` must decode to the EXACT url
    // that was asked for, every parameter present. A bounce that returns only
    // the pathname re-issues an empty authorize request, and the hub then
    // refuses it with `integration parameter missing` / `received: null` —
    // indistinguishable from a client that never sent the parameter, which is
    // exactly how this cost two debugging sessions.
    const next = new URLSearchParams(location.slice(location.indexOf('?'))).get('next')
    expect(next).toBe(url)
    const replayed = new URLSearchParams((next ?? '').slice((next ?? '').indexOf('?')))
    expect(replayed.get('integration')).toBe('export-alexa')
    expect(replayed.get('response_type')).toBe('code')
    expect(replayed.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(replayed.get('state')).toBe(STATE)
  })

  // ── Case 1b ─────────────────────────────────────────────────────────────────
  // The PKCE parameters are the ones a public client cannot proceed without,
  // and they are the last two on the query string — the first casualty of any
  // truncation.
  it('the login bounce carries the PKCE parameters too', async () => {
    const url =
      `/api/oauth2/authorize?response_type=code&client_id=camstack-ha&integration=homeassistant` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${STATE}` +
      `&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { accept: 'text/html,application/xhtml+xml' },
    })

    expect(res.statusCode).toBe(302)
    const location = res.headers['location'] as string
    const next = new URLSearchParams(location.slice(location.indexOf('?'))).get('next')
    expect(next).toBe(url)
  })

  // ── Case 2 ──────────────────────────────────────────────────────────────────
  it('GET /api/oauth2/authorize with valid session cookie → 200 consent HTML containing "Alexa Smart Home"', async () => {
    const url = `/api/oauth2/authorize?response_type=code&integration=export-alexa&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${STATE}`
    const res = await app.inject({
      method: 'GET',
      url,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('Alexa Smart Home')
  })

  // ── Case 3 ──────────────────────────────────────────────────────────────────
  it('POST /api/oauth2/authorize consent=allow → 302 to redirect_uri with code and state', async () => {
    const body = new URLSearchParams({
      consent: 'allow',
      integration: 'export-alexa',
      redirect_uri: REDIRECT_URI,
      state: STATE,
      response_type: 'code',
    }).toString()

    const res = await app.inject({
      method: 'POST',
      url: '/api/oauth2/authorize',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
      body,
    })

    expect(res.statusCode).toBe(302)
    const location = res.headers['location'] as string
    expect(location).toMatch(
      new RegExp(
        `^${REDIRECT_URI.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?code=.+&state=${STATE}`,
      ),
    )
  })

  // ── Case 4 ──────────────────────────────────────────────────────────────────
  it('POST /api/oauth2/token authorization_code → access_token, refresh_token, expires_in: 3600, token_type: Bearer', async () => {
    // First issue a code via the POST /api/oauth2/authorize step.
    const authorizeBody = new URLSearchParams({
      consent: 'allow',
      integration: 'export-alexa',
      redirect_uri: REDIRECT_URI,
      state: STATE,
      response_type: 'code',
    }).toString()

    const authorizeRes = await app.inject({
      method: 'POST',
      url: '/api/oauth2/authorize',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
      body: authorizeBody,
    })

    expect(authorizeRes.statusCode).toBe(302)
    const location = authorizeRes.headers['location'] as string
    const codeMatch = location.match(/[?&]code=([^&]+)/)
    expect(codeMatch).not.toBeNull()
    const code = decodeURIComponent(codeMatch![1]!)

    // Now exchange the code for tokens.
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }).toString()

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/oauth2/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    })

    expect(tokenRes.statusCode).toBe(200)
    const json = tokenRes.json<{
      access_token: string
      refresh_token: string
      expires_in: number
      token_type: string
    }>()
    expect(json).toMatchObject({
      expires_in: 3600,
      token_type: 'Bearer',
    })
    expect(typeof json.access_token).toBe('string')
    expect(json.access_token.length).toBeGreaterThan(0)
    expect(typeof json.refresh_token).toBe('string')
    expect(json.refresh_token.length).toBeGreaterThan(0)
  })

  // ── Case 5 ──────────────────────────────────────────────────────────────────
  it('access_token payload contains isAdmin: false, scopes with device category, and correct username', async () => {
    // Issue code.
    const authorizeBody = new URLSearchParams({
      consent: 'allow',
      integration: 'export-alexa',
      redirect_uri: REDIRECT_URI,
      state: STATE,
      response_type: 'code',
    }).toString()

    const authorizeRes = await app.inject({
      method: 'POST',
      url: '/api/oauth2/authorize',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
      body: authorizeBody,
    })

    const location = authorizeRes.headers['location'] as string
    const codeMatch = location.match(/[?&]code=([^&]+)/)
    const code = decodeURIComponent(codeMatch![1]!)

    // Exchange code for tokens.
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }).toString()

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/oauth2/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    })

    const json = tokenRes.json<{ access_token: string }>()
    const accessToken = json.access_token

    // Decode the JWT middle segment (payload) — base64url → JSON.
    const parts = accessToken.split('.')
    expect(parts).toHaveLength(3)
    const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf8')
    const payload = JSON.parse(payloadJson) as Record<string, unknown>

    expect(payload['isAdmin']).toBe(false)
    expect(payload['username']).toBe(OPERATOR_USERNAME)

    const scopes = payload['scopes'] as Array<Record<string, unknown>>
    expect(Array.isArray(scopes)).toBe(true)
    const deviceScope = scopes.find((s) => s['type'] === 'category' && s['target'] === 'device')
    expect(deviceScope).toBeDefined()
  })

  // ── Case 6 ──────────────────────────────────────────────────────────────────
  it('POST /api/oauth2/token with tampered code → 400 { error: "invalid_grant" }', async () => {
    // Issue a real code first.
    const authorizeBody = new URLSearchParams({
      consent: 'allow',
      integration: 'export-alexa',
      redirect_uri: REDIRECT_URI,
      state: STATE,
      response_type: 'code',
    }).toString()

    const authorizeRes = await app.inject({
      method: 'POST',
      url: '/api/oauth2/authorize',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
      body: authorizeBody,
    })

    const location = authorizeRes.headers['location'] as string
    const codeMatch = location.match(/[?&]code=([^&]+)/)
    const code = decodeURIComponent(codeMatch![1]!)

    // Tamper: mutate one character in the signature (last segment).
    const parts = code.split('.')
    const lastPart = parts[parts.length - 1]!
    const firstChar = lastPart[0]!
    const tamperedChar = firstChar === 'A' ? 'B' : 'A'
    parts[parts.length - 1] = tamperedChar + lastPart.slice(1)
    const tamperedCode = parts.join('.')

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: tamperedCode,
      redirect_uri: REDIRECT_URI,
    }).toString()

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/oauth2/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    })

    expect(tokenRes.statusCode).toBe(400)
    const json = tokenRes.json<{ error: string }>()
    expect(json.error).toBe('invalid_grant')
  })

  // ── Case 7 ──────────────────────────────────────────────────────────────────
  it('authenticated GET /api/oauth2/authorize with integration=bogus → 400', async () => {
    const url = `/api/oauth2/authorize?response_type=code&integration=bogus&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${STATE}`
    const res = await app.inject({
      method: 'GET',
      url,
      headers: {
        accept: 'application/json',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
    })

    expect(res.statusCode).toBe(400)
  })

  // ── Case 7a ─────────────────────────────────────────────────────────────────
  //
  // The SAME refusal, asked by a BROWSER (it wants HTML): not a bare JSON body but
  // the CamStack completion page with a reason code. The two audiences differ on
  // purpose; the JSON contract in the cases around this one is the machine caller's.
  it('the same refusal for a BROWSER lands on the completion page with a reason code', async () => {
    const url = `/api/oauth2/authorize?response_type=code&integration=bogus&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${STATE}`
    const res = await app.inject({
      method: 'GET',
      url,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
    })

    expect(res.statusCode).toBe(302)
    const location = res.headers['location'] as string
    expect(location).toContain('/sso-complete#return=oauth&status=error')
    expect(location).toContain('reason=invalid_request')
    expect(location).not.toContain(STATE)
  })

  // ── Case 7b ─────────────────────────────────────────────────────────────────
  //
  // The operator report was `{"error":"invalid_request — unknown integration"}`
  // and nothing else — not in the response, not in Loki. The value that
  // arrived is the ONLY fact that separates "the client sent the wrong id"
  // from "the hub lost the addon", and the hub had it in its hand.
  it('a refused integration is logged at warn with the received value and the known ids', async () => {
    const url = `/api/oauth2/authorize?response_type=code&integration=alexa&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${STATE}`
    const res = await app.inject({
      method: 'GET',
      url,
      headers: {
        accept: 'application/json',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
    })

    expect(res.statusCode).toBe(400)
    const json = res.json<{
      error: string
      known_integrations?: string[]
      pending_addons?: string[]
      received?: string
    }>()
    expect(json.error).toBe('invalid_request — unknown integration')
    expect(json.received).toBe('alexa')
    // The caller learns what IT sent and nothing else. Enumerating the hub's
    // installed integrations — or its internal addon ids — is a disclosure the
    // operator refused, and the diagnosis lives in the log instead.
    expect(json.known_integrations).toBeUndefined()
    expect(json.pending_addons).toBeUndefined()

    const warned = capturedWarnings.find((l) => l.message.includes('authorize refused'))
    expect(warned, JSON.stringify(capturedWarnings)).toBeDefined()
    const meta = warned?.extras?.meta as Record<string, unknown> | undefined
    expect(meta?.received).toBe('alexa')
    expect(meta?.knownIntegrations).toContain('export-alexa')
  })

  // ── Case 7c ─────────────────────────────────────────────────────────────────
  it('an ABSENT integration is refused with its own message, not "unknown"', async () => {
    const url = `/api/oauth2/authorize?response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${STATE}`
    const res = await app.inject({
      method: 'GET',
      url,
      headers: {
        accept: 'application/json',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toContain('integration parameter missing')
  })

  // ── Case 7d ─────────────────────────────────────────────────────────────────
  //
  // Fastify hands a repeated key over as an array. This is a real shape: the
  // Alexa Lambda appends `&integration=export-alexa` to whatever query it was
  // called with, so a console-configured `integration=` produces exactly this.
  it('a repeated integration carrying ONE value is honoured, not refused', async () => {
    const url = `/api/oauth2/authorize?response_type=code&integration=export-alexa&integration=export-alexa&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${STATE}`
    const res = await app.inject({
      method: 'GET',
      url,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Alexa Smart Home')
  })

  // ── Case 8 ──────────────────────────────────────────────────────────────────
  it('authenticated GET /api/oauth2/authorize with disallowed redirect_uri → 400, consent NOT rendered', async () => {
    const disallowedUri = 'https://evil.example/grab'
    const url = `/api/oauth2/authorize?response_type=code&integration=export-alexa&redirect_uri=${encodeURIComponent(disallowedUri)}&state=${STATE}`
    const res = await app.inject({
      method: 'GET',
      url,
      headers: {
        accept: 'application/json',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
    })

    expect(res.statusCode).toBe(400)
    const json = res.json<{ error: string }>()
    expect(json.error).toContain('redirect_uri not allowed')
    expect(res.body).not.toContain('Alexa Smart Home')
    // The other silent refusal on this path. A code that never reaches the
    // client must leave a trace naming WHERE it was asked to go.
    const warned = capturedWarnings.find((l) => l.message.includes('redirect_uri not allowed'))
    expect(warned, JSON.stringify(capturedWarnings)).toBeDefined()
    expect((warned?.extras?.meta as Record<string, unknown> | undefined)?.redirectUri).toBe(
      disallowedUri,
    )
  })

  // ── Case 8b ─────────────────────────────────────────────────────────────────
  it('POST /api/oauth2/token refresh_token grant → 200 with new access_token, refresh_token, expires_in: 3600, token_type: Bearer', async () => {
    // Step 1: Obtain an authorization code via POST /api/oauth2/authorize.
    const authorizeBody = new URLSearchParams({
      consent: 'allow',
      integration: 'export-alexa',
      redirect_uri: REDIRECT_URI,
      state: STATE,
      response_type: 'code',
    }).toString()

    const authorizeRes = await app.inject({
      method: 'POST',
      url: '/api/oauth2/authorize',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
      body: authorizeBody,
    })

    expect(authorizeRes.statusCode).toBe(302)
    const location = authorizeRes.headers['location'] as string
    const codeMatch = location.match(/[?&]code=([^&]+)/)
    expect(codeMatch).not.toBeNull()
    const code = decodeURIComponent(codeMatch![1]!)

    // Step 2: Exchange the authorization code for an initial token pair.
    const codeTokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }).toString()

    const codeTokenRes = await app.inject({
      method: 'POST',
      url: '/api/oauth2/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: codeTokenBody,
    })

    expect(codeTokenRes.statusCode).toBe(200)
    const initialJson = codeTokenRes.json<{ access_token: string; refresh_token: string }>()
    const refreshToken = initialJson.refresh_token
    expect(typeof refreshToken).toBe('string')
    expect(refreshToken.length).toBeGreaterThan(0)

    // Step 3: Use the refresh token to obtain a fresh token pair.
    const refreshBody = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString()

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/oauth2/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: refreshBody,
    })

    expect(refreshRes.statusCode).toBe(200)
    const refreshJson = refreshRes.json<{
      access_token: string
      refresh_token: string
      expires_in: number
      token_type: string
    }>()
    expect(refreshJson).toMatchObject({ expires_in: 3600, token_type: 'Bearer' })
    expect(typeof refreshJson.access_token).toBe('string')
    expect(refreshJson.access_token.length).toBeGreaterThan(0)
    expect(typeof refreshJson.refresh_token).toBe('string')
    expect(refreshJson.refresh_token.length).toBeGreaterThan(0)

    // Step 4: Decode the new access token payload and verify claims.
    const parts = refreshJson.access_token.split('.')
    expect(parts).toHaveLength(3)
    const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf8')
    const payload = JSON.parse(payloadJson) as Record<string, unknown>

    expect(payload['provider']).toBe('oauth-access')
    expect(payload['isAdmin']).toBe(false)
  })

  // ── Case 9 ──────────────────────────────────────────────────────────────────
  it('authenticated POST /api/oauth2/authorize consent=allow with disallowed redirect_uri → 400, no code issued', async () => {
    const disallowedUri = 'https://evil.example/grab'
    const body = new URLSearchParams({
      consent: 'allow',
      integration: 'export-alexa',
      redirect_uri: disallowedUri,
      state: STATE,
      response_type: 'code',
    }).toString()

    const res = await app.inject({
      method: 'POST',
      url: '/api/oauth2/authorize',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
      body,
    })

    expect(res.statusCode).toBe(400)
    const json = res.json<{ error: string }>()
    expect(json.error).toContain('redirect_uri not allowed')
    // Ensure no Location header with a code was issued
    expect(res.headers['location']).toBeUndefined()
  })

  // ── Session registry lifecycle ───────────────────────────────────────────────
  //
  // These cases verify the end-to-end integration of OauthSessionManager with
  // the OAuth2 routes: exchange creates a session, list/revoke work correctly,
  // and revocation blocks subsequent refresh-token grants.

  describe('session registry lifecycle', () => {
    // Shared helper: run the full authorize → consent → exchange flow and
    // return the issued token pair plus the raw location URL.
    async function doFullFlow(): Promise<{
      accessToken: string
      refreshToken: string
      location: string
    }> {
      const authorizeBody = new URLSearchParams({
        consent: 'allow',
        integration: 'export-alexa',
        redirect_uri: REDIRECT_URI,
        state: STATE,
        response_type: 'code',
      }).toString()

      const authorizeRes = await app.inject({
        method: 'POST',
        url: '/api/oauth2/authorize',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
        },
        body: authorizeBody,
      })

      expect(authorizeRes.statusCode).toBe(302)
      const location = authorizeRes.headers['location'] as string
      const codeMatch = location.match(/[?&]code=([^&]+)/)
      expect(codeMatch).not.toBeNull()
      const code = decodeURIComponent(codeMatch![1]!)

      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }).toString()

      const tokenRes = await app.inject({
        method: 'POST',
        url: '/api/oauth2/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: tokenBody,
      })

      expect(tokenRes.statusCode).toBe(200)
      const json = tokenRes.json<{ access_token: string; refresh_token: string }>()
      return { accessToken: json.access_token, refreshToken: json.refresh_token, location }
    }

    // ── Case a ────────────────────────────────────────────────────────────────
    it('a) listOauthSessions() returns exactly 1 session after exchange, with correct fields', async () => {
      await doFullFlow()

      const sessions = await sessionManager.list()
      expect(sessions).toHaveLength(1)

      const session = sessions[0]!
      expect(session.integrationId).toBe('export-alexa')
      expect(session.username).toBe(OPERATOR_USERNAME)
      expect(session.revokedAt).toBeNull()

      // Scopes must contain the category/device entry declared in ALEXA_DESCRIPTOR.
      expect(Array.isArray(session.scopes)).toBe(true)
      const deviceScope = session.scopes.find((s) => s.type === 'category' && s.target === 'device')
      expect(deviceScope).toBeDefined()
    })

    // ── Case b ────────────────────────────────────────────────────────────────
    it('b) issued access_token payload carries sessionId matching the listed session', async () => {
      const { accessToken } = await doFullFlow()

      const sessions = await sessionManager.list()
      expect(sessions).toHaveLength(1)
      const listedSessionId = sessions[0]!.id

      // Decode the JWT middle segment.
      const parts = accessToken.split('.')
      expect(parts).toHaveLength(3)
      const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf8')
      const payload = JSON.parse(payloadJson) as Record<string, unknown>

      expect(payload['sessionId']).toBe(listedSessionId)
    })

    // ── Case c ────────────────────────────────────────────────────────────────
    it('c) revokeOauthSession({id}) returns {success:true} and session gains non-null revokedAt', async () => {
      await doFullFlow()

      const sessions = await sessionManager.list()
      const sessionId = sessions[0]!.id

      // Revoke via the fake user-management method (same as the real addon does).
      const revokeResult = await sessionManager
        .markRevoked(sessionId)
        .then((ok) => ({ success: ok }))
      expect(revokeResult).toEqual({ success: true })

      // The session must now carry a non-null revokedAt.
      const afterRevoke = await sessionManager.list()
      expect(afterRevoke).toHaveLength(1)
      expect(afterRevoke[0]!.revokedAt).not.toBeNull()
    })

    // ── Case d ────────────────────────────────────────────────────────────────
    it('d) POST /api/oauth2/token refresh_token after session revocation → 400 invalid_grant', async () => {
      const { refreshToken } = await doFullFlow()

      // Revoke the session.
      const sessions = await sessionManager.list()
      await sessionManager.markRevoked(sessions[0]!.id)

      // Attempt a refresh — must be rejected.
      const refreshBody = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString()

      const refreshRes = await app.inject({
        method: 'POST',
        url: '/api/oauth2/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: refreshBody,
      })

      expect(refreshRes.statusCode).toBe(400)
      const json = refreshRes.json<{ error: string }>()
      expect(json.error).toBe('invalid_grant')
    })

    // ── Case e ────────────────────────────────────────────────────────────────
    it('e) revokeOauthSession with unknown id → {success: false}', async () => {
      const result = await sessionManager
        .markRevoked('non-existent-session-id')
        .then((ok) => ({ success: ok }))
      expect(result).toEqual({ success: false })
    })
  })
})

// ─── Phase A: integration-driven hubUrl claim ───────────────────────────────
//
// The OAuth code/token JWT carries a `hubUrl` claim the cloud Lambda routes
// back on. A forked exporter addon (which can't set the hub's env) declares its
// operator-selected external-access endpoint on the oauth-integration
// descriptor; the authorize route must prefer it over the hub-global
// publicHubUrl() (which is localhost in dev — the cause of "linking fails after
// consent").

describe('integration-driven hubUrl claim (Phase A public-origin bridge)', () => {
  const GLOBAL_FALLBACK = 'https://hub-global.example'

  function buildAppWithDescriptor(descriptorHubUrl?: string) {
    const sm = fakeSessionManager()
    const g = createOauthGrants(realSsoBridge, sm as any)
    const fastify = Fastify({ logger: false })
    void fastify.register(cookie)

    const descriptor = descriptorHubUrl
      ? { ...ALEXA_DESCRIPTOR, hubUrl: descriptorHubUrl }
      : { ...ALEXA_DESCRIPTOR }
    const alexaProvider: IOauthIntegrationProvider = { getDescriptor: async () => descriptor }

    const userMgmt: IUserManagementProvider = {
      ...({} as IUserManagementProvider),
      oauthIssueCode: g.oauthIssueCode.bind(g),
      oauthExchangeCode: g.oauthExchangeCode.bind(g),
      oauthRefresh: g.oauthRefresh.bind(g),
      oauthVerifyAccessToken: g.oauthVerifyAccessToken.bind(g),
      listOauthSessions: async () => [],
      revokeOauthSession: async () => ({ success: true }),
    }

    const reg = {
      getCollectionEntries: (cap: string) =>
        cap === 'oauth-integration' ? [[ALEXA_ADDON_ID, alexaProvider]] : [],
      getManifestDeclarers: (cap: string) => (cap === 'oauth-integration' ? [ALEXA_ADDON_ID] : []),
      hasProvider: (cap: string, addonId: string) =>
        cap === 'oauth-integration' && addonId === ALEXA_ADDON_ID,
      getSingleton: (cap: string) => (cap === 'user-management' ? userMgmt : null),
    }

    registerOauth2Routes(fastify, {
      getRegistry: () => reg as any,
      isLiveUser: async () => true,
      verifyToken: (token: string) => {
        if (token === VALID_SESSION_TOKEN)
          return { userId: OPERATOR_USER_ID, username: OPERATOR_USERNAME, isAdmin: true }
        throw new Error('invalid token')
      },
      publicHubUrl: async () => GLOBAL_FALLBACK,
      logger: capturingLogger(),
    })
    return fastify
  }

  async function issuedCodeHubUrl(
    app: ReturnType<typeof buildAppWithDescriptor>,
  ): Promise<unknown> {
    const body = new URLSearchParams({
      consent: 'allow',
      integration: 'export-alexa',
      redirect_uri: REDIRECT_URI,
      state: STATE,
      response_type: 'code',
    }).toString()
    const res = await app.inject({
      method: 'POST',
      url: '/api/oauth2/authorize',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
      body,
    })
    expect(res.statusCode).toBe(302)
    const loc = res.headers['location'] as string
    const code = decodeURIComponent(loc.match(/[?&]code=([^&]+)/)![1]!)
    const payload = JSON.parse(
      Buffer.from(code.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    return payload['hubUrl']
  }

  it('bakes the integration descriptor hubUrl into the issued code', async () => {
    const app = buildAppWithDescriptor('https://tunnel.example.test')
    expect(await issuedCodeHubUrl(app)).toBe('https://tunnel.example.test')
  })

  it('falls back to publicHubUrl() when the descriptor has no hubUrl', async () => {
    const app = buildAppWithDescriptor()
    expect(await issuedCodeHubUrl(app)).toBe(GLOBAL_FALLBACK)
  })
})

// ─── Home Assistant: the PUBLIC-client path ──────────────────────────────────
//
// Same server, second client. What is genuinely different: no secret, so PKCE
// is mandatory; and a redirect_uri on a LAN address the hub could never have
// been told about in advance.

describe('OAuth2 account-linking — Home Assistant (public client, PKCE)', () => {
  let grants: ReturnType<typeof createOauthGrants>
  let sessionManager: ReturnType<typeof fakeSessionManager>
  let app: ReturnType<typeof buildApp>

  const HA_REDIRECT = 'http://192.168.1.20:8123/auth/external/callback'
  const VERIFIER = 'ha-verifier-0123456789abcdefghijklmnopqrstuvwxyz'
  const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url')

  const authorizeUrl = (over: Record<string, string> = {}): string => {
    const params = new URLSearchParams({
      response_type: 'code',
      integration: 'homeassistant',
      redirect_uri: HA_REDIRECT,
      state: STATE,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      ...over,
    })
    return `/api/oauth2/authorize?${params.toString()}`
  }

  const consent = async (over: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/oauth2/authorize',
      headers: {
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        response_type: 'code',
        integration: 'homeassistant',
        redirect_uri: HA_REDIRECT,
        state: STATE,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        consent: 'allow',
        ...over,
      }).toString(),
    })

  beforeEach(() => {
    sessionManager = fakeSessionManager()
    grants = createOauthGrants(realSsoBridge, sessionManager as any)
    app = buildApp(grants, sessionManager)
  })

  it('GET /api/oauth2/integrations advertises homeassistant as a PKCE client', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/oauth2/integrations' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      integrations: { integrationId: string; requiresPkce: boolean }[]
    }
    const ha = body.integrations.find((i) => i.integrationId === 'homeassistant')
    expect(ha).toBeDefined()
    expect(ha!.requiresPkce).toBe(true)
    // Discovery is what lets a component tell an old hub from a refusing one,
    // so it must NOT need a token.
    expect(body.integrations.find((i) => i.integrationId === 'export-alexa')?.requiresPkce).toBe(
      false,
    )
  })

  it('authorize accepts a LAN callback and shows the operator where the code goes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: authorizeUrl(),
      headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Home Assistant')
    expect(res.body).toContain(HA_REDIRECT)
    // The challenge must survive the consent round trip or the exchange dies.
    expect(res.body).toContain(CHALLENGE)
  })

  it('authorize refuses the same callback on a PUBLIC host', async () => {
    const res = await app.inject({
      method: 'GET',
      url: authorizeUrl({ redirect_uri: 'https://evil.example/auth/external/callback' }),
      headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('authorize refuses when PKCE is omitted', async () => {
    const params = new URLSearchParams({
      response_type: 'code',
      integration: 'homeassistant',
      redirect_uri: HA_REDIRECT,
      state: STATE,
    })
    const res = await app.inject({
      method: 'GET',
      url: `/api/oauth2/authorize?${params.toString()}`,
      headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('consent → token with the verifier mints a usable pair', async () => {
    const consented = await consent()
    expect(consented.statusCode).toBe(302)
    const code = new URL(consented.headers.location as string).searchParams.get('code')
    expect(code).toBeTruthy()

    const token = await app.inject({
      method: 'POST',
      url: '/api/oauth2/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: HA_REDIRECT,
        code_verifier: VERIFIER,
        // A public client sends no secret, and the hub must not want one.
        client_id: 'homeassistant',
      }).toString(),
    })
    expect(token.statusCode).toBe(200)
    const body = token.json() as { access_token: string; refresh_token: string }
    expect(body.access_token).toBeTruthy()
    expect(body.refresh_token).toBeTruthy()

    // And the link is listable — an operator can see and cut it.
    const sessions = await sessionManager.list()
    expect(sessions.map((s) => s.integrationId)).toContain('homeassistant')
  })

  it('token WITHOUT the verifier is invalid_grant — the stolen-code case', async () => {
    const consented = await consent()
    const code = new URL(consented.headers.location as string).searchParams.get('code')
    const token = await app.inject({
      method: 'POST',
      url: '/api/oauth2/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: HA_REDIRECT,
      }).toString(),
    })
    expect(token.statusCode).toBe(400)
    expect(token.json()).toEqual({ error: 'invalid_grant' })
  })

  it('a consent POST that swaps in a different redirect_uri is refused', async () => {
    // The hidden fields came back from a browser. Every one is editable.
    const res = await consent({ redirect_uri: 'https://evil.example/auth/external/callback' })
    expect(res.statusCode).toBe(400)
  })
})

// ─── The boot window ─────────────────────────────────────────────────────────
//
// Every descriptor now comes from an ADDON (D101). An addon registers its
// provider after its runner forks and initialises, so between hub start and
// that moment `homeassistant` is genuinely absent from the collection — and
// the operator hit exactly this: `invalid_request — unknown integration` from
// the Home Assistant component during a night of four release restarts.
//
// The registry already knows more than the collection does: `declareFromManifest`
// runs at addon-LOAD time, so the hub knows WHICH addons owe a descriptor long
// before they supply one. "Owed but not yet supplied" is therefore a fact, not
// a guess — and it is a different answer from "nobody ever declared this".
//
// No timer, no backoff, no waiting (D3). The server answers immediately and
// truthfully; the CLIENT decides whether to retry.

describe('OAuth2 integrations — declared-but-not-yet-registered vs unknown', () => {
  let grants: ReturnType<typeof createOauthGrants>
  let sessionManager: ReturnType<typeof fakeSessionManager>

  const authorizeUrl = (integration: string): string =>
    `/api/oauth2/authorize?${new URLSearchParams({
      response_type: 'code',
      integration,
      redirect_uri: 'http://192.168.1.20:8123/auth/external/callback',
      state: STATE,
      code_challenge: crypto.createHash('sha256').update('v'.repeat(48)).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString()}`

  /** Hub mid-boot: `homeassistant-export` is installed and declares the cap,
   *  but its runner has not registered the provider yet. */
  const booting = () =>
    buildApp(grants, sessionManager, {
      declarers: [ALEXA_ADDON_ID, HA_ADDON_ID],
      registered: [ALEXA_ADDON_ID],
    })

  /** Hub fully up: everything that declares the cap has supplied a descriptor. */
  const settled = () => buildApp(grants, sessionManager)

  beforeEach(() => {
    sessionManager = fakeSessionManager()
    grants = createOauthGrants(realSsoBridge, sessionManager as any)
    capturedWarnings = []
  })

  it('answers 503 temporarily_unavailable — not 400 — while the owning addon still owes a descriptor', async () => {
    const res = await booting().inject({
      method: 'GET',
      url: authorizeUrl('homeassistant'),
      headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}` },
    })

    // 503 is the whole point: a 400 tells a client "never ask again", which is
    // a lie during boot and is what sent the component to the password fallback.
    expect(res.statusCode).toBe(503)
    const body = res.json() as {
      error: string
      received: string | null
      known_integrations?: string[]
      pending_addons?: string[]
    }
    expect(body.error).toContain('temporarily_unavailable')
    expect(body.received).toBe('homeassistant')
    // "Retry, this is temporary" is carried by the STATUS and the header —
    // 503 + Retry-After — not by naming the addon the hub is waiting on. The
    // id is a fact about the hub's insides and stays in the log.
    expect(body.pending_addons).toBeUndefined()
    expect(body.known_integrations).toBeUndefined()
    // Retryable in the protocol sense, not merely in prose.
    expect(res.headers['retry-after']).toBeDefined()
    const warned = capturedWarnings.find((l) => l.message.includes('authorize refused'))
    const meta = warned?.extras?.meta as Record<string, unknown> | undefined
    expect(meta?.pendingAddons).toEqual([HA_ADDON_ID])
  })

  it('still answers 400 unknown integration once nothing is outstanding', async () => {
    const res = await settled().inject({
      method: 'GET',
      url: authorizeUrl('never-declared-by-anyone'),
      headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}` },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toContain('unknown integration')
  })

  it('a hub that is merely booting does not report an id as unknown', async () => {
    // The two answers must never be produced by the same branch: an id that is
    // pending is not enumerated as known, and is not called unknown either.
    const res = await booting().inject({
      method: 'GET',
      url: authorizeUrl('homeassistant'),
      headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}` },
    })
    expect((res.json() as { error: string }).error).not.toContain('unknown integration')
    const warned = capturedWarnings.find((w) => w.message.includes('authorize refused'))
    expect(warned).toBeDefined()
    expect(warned!.extras?.meta).toMatchObject({ pendingAddons: [HA_ADDON_ID] })
  })

  it('discovery reports the list as INCOMPLETE while a descriptor is outstanding', async () => {
    // The component treats "no homeassistant in the list" as "this hub is too
    // old" and falls back to a password form. During boot that verdict is
    // wrong and sticky, so the list has to say whether it is final.
    const mid = await booting().inject({ method: 'GET', url: '/api/oauth2/integrations' })
    expect(mid.statusCode).toBe(200)
    const midBody = mid.json() as { integrations: { integrationId: string }[]; complete: boolean }
    expect(midBody.complete).toBe(false)
    expect(midBody.integrations.map((i) => i.integrationId)).not.toContain('homeassistant')

    const up = await settled().inject({ method: 'GET', url: '/api/oauth2/integrations' })
    const upBody = up.json() as { integrations: { integrationId: string }[]; complete: boolean }
    expect(upBody.complete).toBe(true)
    expect(upBody.integrations.map((i) => i.integrationId)).toContain('homeassistant')
  })

  it('does not leak the pending addon ids on the UNAUTHENTICATED discovery route', async () => {
    // /authorize is session-gated and names them; /integrations is open to
    // anyone and only needs to say "not final yet".
    const res = await booting().inject({ method: 'GET', url: '/api/oauth2/integrations' })
    expect(JSON.stringify(res.json())).not.toContain(HA_ADDON_ID)
  })
})

// ─── The refusal has to name its CALLER ──────────────────────────────────────
//
// `integration parameter missing` / `received: null` survived two rounds of
// diagnosis because the log recorded the fault and nothing about the request
// that carried it. Two stories fit that line exactly:
//
//   A. the component's URL (which does carry `integration=`) arrived, the hub
//      bounced it to /login for want of a cookie, and the login page replayed
//      `next` WITHOUT its query — the failing request is a second, browser-made
//      hit; or
//   B. the URL arrived bare on the FIRST hit, stripped upstream or never built.
//
// The query as received separates them on its own, and only refusals were
// logged, so the bounce that precedes A left no trace at all.

describe('an authorize refusal identifies the request that produced it', () => {
  let app: ReturnType<typeof buildApp>

  const STATE_VALUE = 'state-that-must-never-be-logged'
  const CHALLENGE_VALUE = crypto.createHash('sha256').update('v'.repeat(48)).digest('base64url')
  const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

  /** The URL the Home Assistant component actually opens, minus whichever
   *  parameter the caller wants gone. */
  const componentUrl = (drop?: string): string => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'camstack-ha',
      integration: 'homeassistant',
      redirect_uri: 'http://192.168.1.20:8123/auth/external/callback',
      state: STATE_VALUE,
      code_challenge: CHALLENGE_VALUE,
      code_challenge_method: 'S256',
    })
    if (drop !== undefined) params.delete(drop)
    return `/api/oauth2/authorize?${params.toString()}`
  }

  const refusalMeta = (): Record<string, unknown> => {
    const warned = capturedWarnings.find((l) => l.message.includes('authorize refused'))
    expect(warned, JSON.stringify(capturedWarnings)).toBeDefined()
    return (warned?.extras?.meta ?? {}) as Record<string, unknown>
  }

  beforeEach(() => {
    const sm = fakeSessionManager()
    capturedWarnings = []
    capturedInfos = []
    app = buildApp(createOauthGrants(realSsoBridge, sm as any), sm)
  })

  it('records the query AS RECEIVED, which is the fact that separates a replay from a bare arrival', async () => {
    const res = await app.inject({
      method: 'GET',
      url: componentUrl('integration'),
      headers: {
        accept: 'application/json',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
      },
    })
    expect(res.statusCode).toBe(400)

    const meta = refusalMeta()
    expect(meta.path).toBe('/api/oauth2/authorize')
    // The keys are the diagnosis: `state` and `code_challenge` PRESENT while
    // `integration` is absent is story B — a request built without it. A query
    // that is empty instead is story A, a replay that dropped everything.
    const query = String(meta.query)
    expect(query).toContain('state=')
    expect(query).toContain('code_challenge=')
    expect(query).not.toContain('integration=')
  })

  it('never writes the state or the code_challenge VALUE, only the key', async () => {
    await app.inject({
      method: 'GET',
      url: componentUrl('integration'),
      headers: { accept: 'text/html', cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}` },
    })
    // `state` is a per-attempt nonce the client binds its session to; a log
    // aggregator is not where it belongs. The challenge is public by design but
    // is redacted with it — one rule, no per-key judgement call at write time.
    const everything = JSON.stringify([...capturedWarnings, ...capturedInfos])
    expect(everything).not.toContain(STATE_VALUE)
    expect(everything).not.toContain(CHALLENGE_VALUE)
  })

  it('records the referer, the user-agent and whether a session cookie was present', async () => {
    await app.inject({
      method: 'GET',
      url: componentUrl('integration'),
      headers: {
        accept: 'text/html',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
        // A replay made BY the login page carries exactly this.
        referer: 'https://hub.example.com/login?next=%2Fapi%2Foauth2%2Fauthorize',
        'user-agent': UA,
      },
    })
    const meta = refusalMeta()
    expect(meta.referer).toBe('https://hub.example.com/login')
    expect(String(meta.userAgent)).toContain('Chrome/126')
    expect(meta.hasSessionCookie).toBe(true)
  })

  it('does not carry the referer QUERY, which is where the replayed url — and its state — hides', async () => {
    await app.inject({
      method: 'GET',
      url: componentUrl('integration'),
      headers: {
        accept: 'text/html',
        cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}`,
        referer: `https://hub.example.com/login?next=${encodeURIComponent(componentUrl())}`,
      },
    })
    expect(JSON.stringify(capturedWarnings)).not.toContain(STATE_VALUE)
    expect(refusalMeta().referer).toBe('https://hub.example.com/login')
  })

  it('logs the login BOUNCE, so the hit that carried the parameter is on the record too', async () => {
    const res = await app.inject({
      method: 'GET',
      url: componentUrl(),
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
    })
    expect(res.statusCode).toBe(302)

    // Without this line the pair "arrived WITH the parameter, came back
    // without" is invisible, and every refusal looks like a first arrival.
    const bounced = capturedInfos.find((l) => l.message.includes('authorize bounced'))
    expect(bounced, JSON.stringify(capturedInfos)).toBeDefined()
    const meta = (bounced?.extras?.meta ?? {}) as Record<string, unknown>
    expect(String(meta.query)).toContain('integration=homeassistant')
    expect(meta.hasSessionCookie).toBe(false)
  })

  it('says WHY it bounced — an unreadable cookie is not the same as no cookie', async () => {
    await app.inject({
      method: 'GET',
      url: componentUrl(),
      headers: { accept: 'text/html', cookie: `${SESSION_COOKIE}=expired-or-forged` },
    })
    const bounced = capturedInfos.find((l) => l.message.includes('authorize bounced'))
    expect(bounced, JSON.stringify(capturedInfos)).toBeDefined()
    const meta = (bounced?.extras?.meta ?? {}) as Record<string, unknown>
    expect(meta.reason).toBe('session-invalid')
    expect(meta.hasSessionCookie).toBe(true)
  })

  it('logs the 401 too — a programmatic client that is turned away drops the same work', async () => {
    const res = await app.inject({ method: 'GET', url: componentUrl(), headers: { accept: '*/*' } })
    expect(res.statusCode).toBe(401)
    const line = capturedInfos.find((l) => l.message.includes('authorize'))
    expect(line, JSON.stringify(capturedInfos)).toBeDefined()
    const meta = (line?.extras?.meta ?? {}) as Record<string, unknown>
    expect(meta.redirected).toBe(false)
  })
})

// ─── Alexa and Home Assistant are one mechanism, two configurations ──────────
//
// The operator's requirement: the two integrations must use the SAME
// primitives. The risk is not that they break — it is that they drift into two
// implementations of one idea, which is how `homeassistant` ended up declared
// by the kernel while `export-alexa` declared itself from an addon.
//
// So this runs BOTH SHIPPED descriptors — imported from the two addon packages,
// not copied — through the same schema and the same route, and asserts the
// differences are exactly the ones the two external platforms force.

describe('Alexa and Home Assistant declare through identical primitives', () => {
  const shipped = [
    { addonId: ALEXA_ADDON_ID, descriptor: buildAlexaOauthIntegration(undefined) },
    { addonId: HA_ADDON_ID, descriptor: HOME_ASSISTANT_OAUTH_INTEGRATION },
  ] as const

  it('both satisfy the one descriptor schema — no dialect, no extra field', () => {
    for (const { descriptor } of shipped) {
      const parsed = OauthIntegrationDescriptorSchema.safeParse(descriptor)
      expect(parsed.success, `${descriptor.integrationId}: ${parsed.error?.message ?? ''}`).toBe(
        true,
      )
    }
  })

  /** A route wired to the two SHIPPED descriptors and nothing else. The suite's
   *  default fake serves a hand-written Alexa descriptor, which would let this
   *  probe pass against an invented redirect policy — the drift this whole
   *  describe exists to catch. */
  function buildAppFromShipped() {
    const fastify = Fastify({ logger: false })
    void fastify.register(cookie)
    const reg = {
      getCollectionEntries: (cap: string) =>
        cap === 'oauth-integration'
          ? shipped.map((s) => [s.addonId, { getDescriptor: async () => s.descriptor }])
          : [],
      getManifestDeclarers: (cap: string) =>
        cap === 'oauth-integration' ? shipped.map((s) => s.addonId) : [],
      hasProvider: (cap: string, addonId: string) =>
        cap === 'oauth-integration' && shipped.some((s) => s.addonId === addonId),
      getSingleton: () => null,
    }
    registerOauth2Routes(fastify, {
      getRegistry: () => reg as any,
      isLiveUser: async () => true,
      verifyToken: (token: string) => {
        if (token === VALID_SESSION_TOKEN) {
          return { userId: OPERATOR_USER_ID, username: OPERATOR_USERNAME, isAdmin: true }
        }
        throw new Error('invalid token')
      },
      publicHubUrl: async () => 'https://hub.example.com',
      logger: capturingLogger(),
    })
    return fastify
  }

  it('both resolve on /authorize from one registry read, with no per-id branch', async () => {
    const app = buildAppFromShipped()

    for (const { descriptor } of shipped) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/oauth2/authorize?${new URLSearchParams({
          response_type: 'code',
          integration: descriptor.integrationId,
          // Deliberately disallowed for BOTH. Reaching "redirect_uri not
          // allowed" proves the integration RESOLVED — it is the success
          // signal here, and it is the same probe used against the live hub.
          redirect_uri: 'https://not-allowed.example/cb',
          state: STATE,
          code_challenge: crypto.createHash('sha256').update('v'.repeat(48)).digest('base64url'),
          code_challenge_method: 'S256',
        }).toString()}`,
        headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_TOKEN}` },
      })
      expect(res.statusCode, descriptor.integrationId).toBe(400)
      expect((res.json() as { error: string }).error).toContain('redirect_uri not allowed')
    }
  })

  it('expresses every scope in the one TokenScope vocabulary', () => {
    // `addon` joined `category`/`capability` when D103 made the
    // `/addon/:addonId/*` gate check an integration token's grant: an
    // integration that POSTs to an addon route now DECLARES that addon, which
    // is why Home Assistant carries `addon:homeassistant-export`. `device` is
    // the one form no descriptor should use — a grant pinned to a device-id
    // list cannot survive the operator adding a camera.
    for (const { descriptor } of shipped) {
      expect(descriptor.requestedScopes.length).toBeGreaterThan(0)
      for (const scope of descriptor.requestedScopes) {
        expect(['category', 'capability', 'addon']).toContain(scope.type)
      }
    }
  })

  /**
   * The declaration is the ENFORCEMENT INPUT since D103, so an under-declared
   * descriptor is a broken integration rather than a tidy one. Home Assistant's
   * component POSTs `{topic, value}` to `/addon/homeassistant-export/command`
   * for every actuated entity; without this grant the gate answers
   * `403 Token scope mismatch` and every HA control silently stops working.
   */
  it('declares the addon route it posts to — Home Assistant needs addon:homeassistant-export', () => {
    const ha = shipped.find((s) => s.descriptor.integrationId === 'homeassistant')
    expect(ha).toBeDefined()
    expect(ha!.descriptor.requestedScopes).toContainEqual({
      type: 'addon',
      target: 'homeassistant-export',
      access: ['view', 'create'],
    })
  })

  /**
   * Alexa deliberately declares NO addon grant, and that is not an oversight:
   * both of its hub-side routes are `access: 'public'` and authenticate the
   * bearer themselves via `oauthVerifyAccessToken`, so neither traverses the
   * gate. If an Alexa route ever becomes `authenticated`, this test is the one
   * that should be updated — together with the descriptor.
   */
  it('does not hand Alexa an addon grant it has no authenticated route for', () => {
    const alexa = shipped.find((s) => s.descriptor.integrationId === 'export-alexa')
    expect(alexa).toBeDefined()
    expect(alexa!.descriptor.requestedScopes.some((s) => s.type === 'addon')).toBe(false)
  })

  /**
   * Operator decision 2026-08-09: an Amazon account link lasts until the user
   * unlinks it; a Home Assistant config entry gets a year. Asserted against the
   * shipped descriptors so a future edit that drops the field — and silently
   * restores the 30-day default that unlinked a working skill — fails here.
   */
  it('declares the refresh lifetime each integration needs', () => {
    const byId = new Map(shipped.map((s) => [s.descriptor.integrationId, s.descriptor]))
    expect(byId.get('export-alexa')!.refreshTokenTtlSec).toBe('never')
    expect(byId.get('homeassistant')!.refreshTokenTtlSec).toBe(365 * 24 * 60 * 60)
  })

  it('keeps `category:system` out of BOTH — a bridge must never reach addons.installPackage', () => {
    // Recorded when the Home Assistant scopes were chosen and carried across
    // the move to the addon verbatim. It applies to every integration, not to
    // one of them, so it is asserted over both.
    for (const { descriptor } of shipped) {
      const system = descriptor.requestedScopes.filter(
        (s) => s.type === 'category' && s.target === 'system',
      )
      expect(system, descriptor.integrationId).toEqual([])
    }
  })

  it('differs ONLY where the external platform forces it', () => {
    const alexa = buildAlexaOauthIntegration(undefined)

    // PKCE: HA's component is published source and can keep no secret; Alexa's
    // secret lives in the operator's Lambda. Same field, opposite value — this
    // is "same primitive, different configuration", not a divergence.
    expect(HOME_ASSISTANT_OAUTH_INTEGRATION.requiresPkce).toBe(true)
    expect(alexa.requiresPkce).toBeUndefined()

    // Private-host callbacks: only the self-hosted client needs them.
    expect(HOME_ASSISTANT_OAUTH_INTEGRATION.allowedPrivateHostPaths).toEqual([
      '/auth/external/callback',
    ])
    expect(alexa.allowedPrivateHostPaths).toBeUndefined()

    // hubUrl: Amazon must route back over a public origin, so Alexa carries the
    // operator's chosen endpoint; Home Assistant redirects to itself on the LAN.
    expect(buildAlexaOauthIntegration('https://hub.example.com').hubUrl).toBe(
      'https://hub.example.com',
    )
    expect(HOME_ASSISTANT_OAUTH_INTEGRATION.hubUrl).toBeUndefined()

    // Everything else is identical in KIND: both name themselves, both carry a
    // consent label, both bound their redirects.
    for (const { descriptor } of shipped) {
      expect(descriptor.integrationId.length).toBeGreaterThan(0)
      expect(descriptor.displayName.length).toBeGreaterThan(0)
      expect(descriptor.allowedRedirectPrefixes.length).toBeGreaterThan(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// The descriptor is derived from the CALLS, not the other way round.
//
// 2026-08-09: linking succeeded and then setup failed with
// `deviceExport.listExposedDevices: hub rejected the token`. The component's
// FIRST authenticated call is the membership read introduced with the export
// filter, and the descriptor had never been widened for it — while an
// `addon:homeassistant-export` grant added the same day looked like it
// covered "that addon". It does not: `addon:` gates the HTTP routes,
// `capability:` gates the tRPC caps, and this call needs the second.
//
// A test that lists the expected scopes would have passed with the bug in
// place, because it would have been written from the same wrong list. This
// one starts from the paths the published component actually invokes and
// asks the REAL matcher whether the shipped descriptor permits each.
describe('Home Assistant descriptor covers every path the component calls', () => {
  // Extracted from the published component source
  // (camstack/homeassistant-component, custom_components/camstack/*.py).
  // `auth.*` is unauthenticated, `camstack.push` is the component's own
  // inbound view — neither traverses a hub scope check.
  const COMPONENT_TRPC_PATHS: readonly string[] = [
    'deviceExport.listExposedDevices',
    'deviceManager.listAll',
    'deviceState.getAllSnapshots',
    'snapshot.getSnapshot',
    'webrtcSession.handleOffer',
    'webrtcSession.addIceCandidate',
    'webrtcSession.getIceCandidates',
    'webrtcSession.closeSession',
  ]

  it.each(COMPONENT_TRPC_PATHS)('grants %s', (path) => {
    const result = checkScopeAccess(HOME_ASSISTANT_OAUTH_INTEGRATION.requestedScopes, path, {
      deviceId: 101,
    })
    expect(result.ok).toBe(true)
  })
})
