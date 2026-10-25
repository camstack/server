/**
 * `/api/embed-auth` turns a bearer into the browser's SESSION cookie — the
 * cookie every cookie-gated surface reads, the OAuth consent page among them.
 * It used to accept any JWT this hub signed (security review 2026-10-21,
 * CRITICAL): a share link became a session cookie. Only a live person's login
 * session may become one now.
 *
 * Disarm checks:
 *   - drop `isSessionGradeJwtPayload` in `sessionCookieTtl` → the bridge token
 *     gets a cookie;
 *   - drop `isLiveUser` → the deleted user's session gets a cookie;
 *   - drop the audience refusal in `AuthManager.verifyToken` → the share link
 *     still fails the session grade (it has a `kind`), so remove both to see
 *     the original attack succeed.
 */
import cookie from '@fastify/cookie'
import { staticJwtSigningKey } from '@camstack/system'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../../core/auth/auth.service.js'
import { registerEmbedAuthRoute } from '../embed-auth-route.js'
import { SESSION_COOKIE } from '../session-cookie.js'

const NEXT = '/addon/stream-broker/embed/grid'

const auth = new AuthService(
  { get: () => undefined, update: () => undefined } as never,
  undefined,
  staticJwtSigningKey('embed-auth-spec-secret'),
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

async function embedAuth(bearer: string) {
  const fastify = Fastify()
  await fastify.register(cookie)
  registerEmbedAuthRoute(fastify, {
    verifyToken: (token) => auth.verifyToken(token),
    isLiveUser: async (userId) => userId === 'u-root',
  })
  app = fastify
  return fastify.inject({
    method: 'GET',
    url: `/api/embed-auth?next=${encodeURIComponent(NEXT)}`,
    headers: { authorization: `Bearer ${bearer}` },
  })
}

afterEach(async () => {
  await app?.close()
  app = undefined
})

function sessionCookieOf(res: Awaited<ReturnType<typeof embedAuth>>): string | undefined {
  const raw = res.headers['set-cookie']
  const all = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  return all.find((c) => c.startsWith(`${SESSION_COOKIE}=`))
}

describe('/api/embed-auth mints a session cookie only from a live login session', () => {
  it('control: a live user’s login session becomes the cookie and redirects', async () => {
    const res = await embedAuth(session('u-root', 'root', true))
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(NEXT)
    expect(sessionCookieOf(res)).toBeDefined()
  })

  it('SECURITY: a share link (a minted token) never becomes a session cookie', async () => {
    const share = auth.signCredentialToken({
      kind: 'credential',
      sub: 'u-root',
      jti: 'jti-share-link-0001',
      scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [5] } }],
    })
    const res = await embedAuth(share)
    expect(res.statusCode).toBe(401)
    expect(sessionCookieOf(res)).toBeUndefined()
  })

  it('SECURITY: a bridge token never becomes a session cookie', async () => {
    const bridge = auth.signSsoBridgeToken({
      provider: 'oauth-code',
      userId: 'u-root',
      username: 'root',
      isAdmin: true,
    })
    const res = await embedAuth(bridge)
    expect(res.statusCode).toBe(401)
    expect(sessionCookieOf(res)).toBeUndefined()
  })

  it('SECURITY: a deleted user’s session never becomes a session cookie', async () => {
    const res = await embedAuth(session('u-gone', 'gone', true))
    expect(res.statusCode).toBe(401)
    expect(sessionCookieOf(res)).toBeUndefined()
  })
})
