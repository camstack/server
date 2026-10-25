/**
 * Who may CONSENT to an account link (security review 2026-10-21, CRITICAL).
 *
 * A consent mints an account link carrying the integration's whole grant —
 * for Alexa, every camera and device, view and control, with a refresh that
 * never expires. It used to accept ANY JWT this hub signed as the session
 * cookie: a share link (a minted token, no `exp`), even one revoked or
 * expired, set as the cookie reached `consent=allow` and came back with a
 * code for `userId: ''`.
 *
 * Only a person's login session may consent: a session-grade JWT naming a
 * user that still exists. Driven through the REAL routes and a REAL
 * AuthService signing key, so the tokens are the hub's own.
 *
 * Disarm checks:
 *   - drop `isSessionGradeJwtPayload` in `consentingUserOf` → the minted-token
 *     cookie still dies (D895: raw verify refuses its audience), but the
 *     bridge-token row consents;
 *   - drop `deps.isLiveUser` → the deleted user consents;
 *   - drop the audience refusal in `AuthManager.verifyToken` and the session
 *     grade check together → the share link consents (the original attack).
 */
import cookie from '@fastify/cookie'
import { staticJwtSigningKey } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { liveUserCheck } from '../../../auth/live-user.js'
import { SESSION_COOKIE } from '../../../auth/session-cookie.js'
import { AuthService } from '../../../core/auth/auth.service.js'
import { registerOauth2Routes } from '../oauth2-routes.js'

const REDIRECT = 'https://layla.amazon.com/cb'

function logger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

const auth = new AuthService(
  { get: () => undefined, update: () => undefined } as never,
  undefined,
  staticJwtSigningKey('oauth-consent-spec-secret'),
)

/** A login-session JWT as `auth.login` signs it. */
function session(userId: string, username: string, isAdmin: boolean): string {
  return auth.signToken({
    userId,
    username,
    isAdmin,
    allowedProviders: '*',
    allowedDevices: {},
  })
}

let app: FastifyInstance | undefined
let issued: unknown[] = []

async function build(): Promise<FastifyInstance> {
  issued = []
  const userManagement = {
    listUsers: async () => [{ id: 'u-root', username: 'root', isAdmin: true }],
    oauthIssueCode: async (input: unknown) => {
      issued.push(input)
      return { code: 'code-1' }
    },
  }
  const registry = {
    getCollectionEntries: () =>
      new Map([
        [
          'export-alexa',
          {
            getDescriptor: async () => ({
              integrationId: 'export-alexa',
              displayName: 'Alexa Smart Home',
              requestedScopes: [{ type: 'category', target: 'device', access: ['view', 'create'] }],
              allowedRedirectPrefixes: ['https://layla.amazon.com/'],
            }),
          },
        ],
      ]),
    getManifestDeclarers: () => [] as string[],
    hasProvider: () => true,
    getSingleton: <T>(name: string): T | null =>
      name === 'user-management' ? (userManagement as T) : null,
  }
  const fastify = Fastify()
  await fastify.register(cookie)
  registerOauth2Routes(fastify, {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double for the registry surface the route reads
    getRegistry: () => registry as never,
    verifyToken: (token) => auth.verifyToken(token),
    isLiveUser: liveUserCheck(registry),
    publicHubUrl: async () => 'https://hub.example',
    logger: logger(),
  })
  app = fastify
  return fastify
}

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function consent(cookieValue: string) {
  const body = new URLSearchParams({
    consent: 'allow',
    integration: 'export-alexa',
    redirect_uri: REDIRECT,
    state: 's',
    response_type: 'code',
  }).toString()
  return (await build()).inject({
    method: 'POST',
    url: '/api/oauth2/authorize',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      cookie: `${SESSION_COOKIE}=${cookieValue}`,
    },
    body,
  })
}

const SHARE_LINK = () =>
  auth.signCredentialToken({
    kind: 'credential',
    sub: 'u-root',
    jti: 'jti-share-link-0001',
    scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [5] } }],
  })

describe('only a live person’s login session consents to an account link', () => {
  it('control: a login session of a live user consents and gets a code', async () => {
    const res = await consent(session('u-root', 'root', true))
    expect(res.statusCode).toBe(302)
    expect(String(res.headers.location)).toContain('code=code-1')
    expect(issued).toEqual([expect.objectContaining({ userId: 'u-root' })])
  })

  it('SECURITY: a share link (a minted token) set as the cookie consents to nothing', async () => {
    const res = await consent(SHARE_LINK())
    expect(res.statusCode).toBe(401)
    expect(issued).toEqual([])
  })

  it('SECURITY: the same holds for a minted * token', async () => {
    const res = await consent(
      auth.signCredentialToken({
        kind: 'credential',
        sub: 'u-root',
        jti: 'jti-admin-token-0001',
        scopes: ['*'],
      }),
    )
    expect(res.statusCode).toBe(401)
    expect(issued).toEqual([])
  })

  it('SECURITY: a session naming nobody (empty userId) consents to nothing', async () => {
    const res = await consent(session('', '', false))
    expect(res.statusCode).toBe(401)
    expect(issued).toEqual([])
  })

  it('SECURITY: a session of a deleted user consents to nothing', async () => {
    const res = await consent(session('u-gone', 'gone', true))
    expect(res.statusCode).toBe(401)
    expect(issued).toEqual([])
  })

  it('SECURITY: a bridge token (signed by the hub, not a session) consents to nothing', async () => {
    const bridge = auth.signSsoBridgeToken({
      provider: 'oauth-code',
      userId: 'u-root',
      username: 'root',
      isAdmin: true,
    })
    const res = await consent(bridge)
    expect(res.statusCode).toBe(401)
    expect(issued).toEqual([])
  })

  it('SECURITY: the consent PAGE (GET) refuses a share link too', async () => {
    const res = await (await build()).inject({
      method: 'GET',
      url: `/api/oauth2/authorize?response_type=code&integration=export-alexa&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s`,
      headers: { accept: 'application/json', cookie: `${SESSION_COOKIE}=${SHARE_LINK()}` },
    })
    expect(res.statusCode).toBe(401)
  })
})
