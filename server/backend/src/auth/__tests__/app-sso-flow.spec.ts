import { createHash } from 'node:crypto'
import { type AppFlowPurpose, SSO_STATE_COOKIE } from '@camstack/types'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthRouter } from '../../api/core/auth.router.js'
import { createAuthLimiters } from '../../api/core/auth-limits.js'
import { HandoffCodeService, pkceChallenge } from '../../core/auth/handoff-code.service.js'
import { DEFAULT_AUTH_NETWORK_POLICY } from '../auth-network-policy.js'
import { createRateLimiter } from '../auth-rate-limit.js'
import { DeviceEnrollProofs } from '../device-enroll-proofs.js'
import { ExternalLinkIntents } from '../external-link-intents.js'
import { NativeLinkCompletions } from '../native-link-completions.js'
import { createSessionMinter } from '../session-mint.js'
import { registerAppConfirmRoutes } from '../app-confirm-routes.js'
import { AppConfirmations } from '../app-confirmations.js'
import { registerSsoRoutes } from '../sso-routes.js'
import { UsedBridgeIds } from '../used-bridge-ids.js'
import { sessionHarness } from './session-test-harness.js'

/**
 * The OIDC native-app flow end to end (D858): bridge -> `/sso/finish-app` ->
 * 302 at the app's scheme -> redeem with the verifier. Real signer, real
 * session table, real handoff service, the real auth router for the redeem.
 */

const PROVIDER = 'auth-oidc/acme'
const ISS = 'https://idp.example.com'
const BROWSER_STATE = 'browser-state-cookie-value-0123456789abcdef'
const VERIFIER = 'v'.repeat(64)
const APP_STATE = 'app-state-0123456789'
const CLIENT_REQ = { socket: { remoteAddress: '203.0.113.5' }, headers: {} }

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

let seq = 0

function setup(
  links: Record<string, string> = { 'oidc:acme:sub-1': 'u-alice' },
  owed: string[] = [],
) {
  const users = [
    { id: 'u-alice', username: 'alice', isAdmin: false, password: 'pw-alice-1' },
    { id: 'u-carol', username: 'carol', isAdmin: false, password: 'pw-carol-1' },
  ]
  const h = sessionHarness(users)
  // The identity store and the TOTP status the finish consults.
  Object.assign(h.userManagement, {
    findUserByExternalIdentity: async (input: { provider: string; subject: string }) => {
      const userId = links[`oidc:acme:${input.subject}`]
      return userId === undefined || input.provider !== PROVIDER ? null : { userId, issuer: ISS }
    },
    getTotpStatus: async (input: { userId: string }) => ({
      enabled: owed.includes(input.userId),
      confirmedAt: null,
    }),
  })
  const handoffs = new HandoffCodeService()
  const confirmations = new AppConfirmations()
  const minter = createSessionMinter({
    signer: h.auth,
    directory: () => h.registry.getSingleton('user-management'),
    sessions: h.backing,
  })
  const router = createAuthRouter(h.auth, h.registry as never, null, handoffs, undefined, null, {
    sessions: h.backing,
    limiters: {
      ...createAuthLimiters(),
      credential: createRateLimiter({ windowMs: 60_000, max: 10_000 }),
    },
    enrollProofs: new DeviceEnrollProofs(),
  })
  const anon = router.createCaller({ user: null, req: CLIENT_REQ as never })
  const warnings: string[] = []
  const fastify = Fastify()
  registerSsoRoutes(fastify, {
    wiring: {
      auth: h.auth,
      registry: h.registry as never,
      moleculer: null,
      minter,
      linkIntents: new ExternalLinkIntents(),
      nativeLinks: new NativeLinkCompletions(),
      usedBridgeIds: new UsedBridgeIds(),
    },
    network: DEFAULT_AUTH_NETWORK_POLICY,
    limiter: createRateLimiter({ windowMs: 60_000, max: 1_000 }),
    browserHandoffCodes: new HandoffCodeService(),
    confirmations,
    minter,
    logger: {
      error: (m) => void warnings.push(m),
      warn: (m, o) => void warnings.push(`${m} ${JSON.stringify(o?.meta ?? {})}`),
    },
  })
  registerAppConfirmRoutes(fastify, {
    confirmations,
    handoffCodes: handoffs,
    network: DEFAULT_AUTH_NETWORK_POLICY,
    limiter: createRateLimiter({ windowMs: 60_000, max: 1_000 }),
    logger: { warn: () => undefined },
  })
  return { h, fastify, handoffs, confirmations, anon, router, warnings }
}

type Setup = ReturnType<typeof setup>

function bridge(
  s: Setup,
  extra: {
    app?: {
      purpose?: AppFlowPurpose
      redirect?: string
      challenge?: string
      lang?: 'en' | 'it'
    } | null
    userId?: string
    linkIntent?: string
    binding?: string
    provider?: string
  } = {},
): string {
  seq += 1
  const app = extra.app === null ? undefined : (extra.app ?? {})
  return s.h.auth.signSsoBridgeToken({
    userId: extra.userId ?? 'oidc:acme:sub-1',
    username: 'alice@example.com',
    isAdmin: false,
    provider: extra.provider ?? PROVIDER,
    issuer: ISS,
    jti: `jti-${seq}`,
    browserBinding: extra.binding ?? sha256(BROWSER_STATE),
    ...(extra.linkIntent !== undefined ? { linkIntent: extra.linkIntent } : {}),
    ...(app !== undefined
      ? {
          app: {
            codeChallenge: app.challenge ?? pkceChallenge(VERIFIER),
            state: APP_STATE,
            purpose: app.purpose ?? 'new-session',
            redirect: app.redirect ?? 'camstack://auth-callback',
            ...(app.lang !== undefined ? { lang: app.lang } : {}),
          },
        }
      : {}),
  })
}

async function finishApp(s: Setup, token: string, cookie: string | null = BROWSER_STATE) {
  return s.fastify.inject({
    method: 'GET',
    url: `/api/auth/sso/finish-app?bridge=${encodeURIComponent(token)}`,
    headers: cookie === null ? {} : { cookie: `${SSO_STATE_COOKIE}=${cookie}` },
  })
}

/** The confirmation page the finish sent the browser to, and the cookie that binds it. */
function confirmTarget(res: { headers: Record<string, unknown> }) {
  const location = String(res.headers.location)
  const token = new URL(location, 'https://hub.example').searchParams.get('confirm')
  const cookies = [res.headers['set-cookie']].flat().map(String)
  const cookie = cookies.find((c) => c.startsWith('camstack_app_confirm='))?.split(';')[0] ?? null
  return { location, token, cookie }
}

/** Continue pressed in the browser that finished the sign-in: the app location the page navigates to. */
async function confirmed(s: Setup, res: { headers: Record<string, unknown> }): Promise<string> {
  const { location, token, cookie } = confirmTarget(res)
  if (!location.startsWith('/auth/app/confirm')) return location
  const post = await s.fastify.inject({
    method: 'POST',
    url: '/auth/app/confirm',
    headers: cookie === null ? {} : { cookie },
    payload: { confirm: token },
  })
  return post.json<{ location: string }>().location
}

const codeOf = (location: string | undefined): string => {
  const code = new URL(String(location)).searchParams.get('code')
  if (code === null) throw new Error(`no code in ${location}`)
  return code
}

let open: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(open.map((f) => f.close()))
  open = []
})
const boot = (...args: Parameters<typeof setup>): Setup => {
  const s = setup(...args)
  open.push(s.fastify)
  return s
}

describe('/api/auth/sso/finish-app (D858)', () => {
  it('a verified, linked, bound bridge -> 302 to the CONFIRMATION page, no code yet, no web session', async () => {
    const s = boot()
    const res = await finishApp(s, bridge(s))
    expect(res.statusCode).toBe(302)
    expect(String(res.headers.location)).toMatch(/^\/auth\/app\/confirm\?confirm=[A-Za-z0-9_-]+$/)
    // Nothing is minted before Continue.
    expect(s.handoffs.pendingCount).toBe(0)
    expect(s.confirmations.pendingCount).toBe(1)
    // The cookies set: the state binding is spent, the confirmation is bound. No session cookie.
    const cookies = [res.headers['set-cookie']].flat().map(String)
    expect(cookies.some((c) => /^camstack_sso_state=; .*Max-Age=0/.test(c))).toBe(true)
    expect(cookies.some((c) => /^camstack_app_confirm=.*HttpOnly/.test(c))).toBe(true)
    expect(cookies.some((c) => c.includes('camstack_session'))).toBe(false)
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['cache-control']).toBe('no-store')
    // Continue then mints and answers at the app with the exact state.
    const location = await confirmed(s, res)
    expect(location).toMatch(/^camstack:\/\/auth-callback\?/)
    expect(new URL(location).searchParams.get('state')).toBe(APP_STATE)
    expect(location).not.toContain('token=')
    expect(s.handoffs.pendingCount).toBe(1)
  })

  it("the app's lang survives the OIDC bridge to the confirmation page (and wins over Accept-Language)", async () => {
    const s = boot()
    const res = await finishApp(s, bridge(s, { app: { lang: 'it' } }))
    const { location, cookie } = confirmTarget(res)
    const page = await s.fastify.inject({
      method: 'GET',
      url: location,
      headers: { cookie: cookie ?? '', 'accept-language': 'en-US,en;q=0.9' },
    })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('<html lang="it">')
    expect(page.body).toContain('Accedere all&#39;app CamStack?')
    expect(page.body).toContain('<strong>alice</strong>')
  })

  it('the confirmation page names the person, and no code exists until Continue', async () => {
    const s = boot()
    const res = await finishApp(s, bridge(s))
    const { location, cookie } = confirmTarget(res)
    const page = await s.fastify.inject({
      method: 'GET',
      url: location,
      headers: { cookie: cookie ?? '' },
    })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Sign in the CamStack app?')
    expect(page.body).toContain('<strong>alice</strong>')
    expect(String(page.headers['content-security-policy'])).toContain("default-src 'none'")
    expect(s.handoffs.pendingCount).toBe(0)
  })

  it('the confirm token is single use', async () => {
    const s = boot()
    const res = await finishApp(s, bridge(s))
    const { token, cookie } = confirmTarget(res)
    const post = () =>
      s.fastify.inject({
        method: 'POST',
        url: '/auth/app/confirm',
        headers: { cookie: cookie ?? '' },
        payload: { confirm: token },
      })
    expect((await post()).statusCode).toBe(200)
    expect((await post()).statusCode).toBe(400)
    expect(s.handoffs.pendingCount).toBe(1)
  })

  it('the confirm token is useless in another browser (no / wrong cookie), and is burned by the attempt', async () => {
    const s = boot()
    const res = await finishApp(s, bridge(s))
    const { token, cookie } = confirmTarget(res)
    for (const headers of [{}, { cookie: 'camstack_app_confirm=some-other-browsers-cookie' }]) {
      const bad = await s.fastify.inject({
        method: 'POST',
        url: '/auth/app/confirm',
        headers,
        payload: { confirm: token },
      })
      expect(bad.statusCode).toBe(400)
    }
    const late = await s.fastify.inject({
      method: 'POST',
      url: '/auth/app/confirm',
      headers: { cookie: cookie ?? '' },
      payload: { confirm: token },
    })
    expect(late.statusCode).toBe(400)
    expect(s.handoffs.pendingCount).toBe(0)
    const fresh = confirmTarget(await finishApp(s, bridge(s)))
    const page = await s.fastify.inject({ method: 'GET', url: fresh.location })
    expect(page.statusCode).toBe(400)
    expect(page.body).not.toContain('Continue')
  })

  it('Cancel is a plain link to the app with error=cancelled and mints nothing', async () => {
    const s = boot()
    const res = await finishApp(s, bridge(s))
    const { location, cookie } = confirmTarget(res)
    const page = await s.fastify.inject({
      method: 'GET',
      url: location,
      headers: { cookie: cookie ?? '' },
    })
    expect(page.body).toContain(
      `href="camstack://auth-callback?error=cancelled&#38;state=${APP_STATE}"`,
    )
    expect(s.handoffs.pendingCount).toBe(0)
  })

  it('new-session: the code redeems WITH the verifier for a normal session of the linked user', async () => {
    const s = boot()
    const code = codeOf(await confirmed(s, await finishApp(s, bridge(s))))
    const session = await s.anon.redeemHandoffCode({
      code,
      codeVerifier: VERIFIER,
      state: APP_STATE,
      refreshable: true,
    })
    expect(s.h.auth.verifyToken(session.token).userId).toBe('u-alice')
    expect(session.refreshToken).toBeDefined()
  })

  it('a wrong verifier is refused, and the code is burned', async () => {
    const s = boot()
    const code = codeOf(await confirmed(s, await finishApp(s, bridge(s))))
    await expect(
      s.anon.redeemHandoffCode({ code, codeVerifier: 'x'.repeat(64), state: APP_STATE }),
    ).rejects.toThrow()
    await expect(
      s.anon.redeemHandoffCode({ code, codeVerifier: VERIFIER, state: APP_STATE }),
    ).rejects.toThrow()
  })

  it('a missing verifier or a different state is refused', async () => {
    const s = boot()
    const a = codeOf(await confirmed(s, await finishApp(s, bridge(s))))
    await expect(s.anon.redeemHandoffCode({ code: a, state: APP_STATE })).rejects.toThrow()
    const b = codeOf(await confirmed(s, await finishApp(s, bridge(s))))
    await expect(
      s.anon.redeemHandoffCode({ code: b, codeVerifier: VERIFIER, state: 'other' }),
    ).rejects.toThrow()
  })

  it('step-up: yields a PROOF for the same user and NO session (an IdP login just happened)', async () => {
    const s = boot()
    const res = await finishApp(s, bridge(s, { app: { purpose: 'step-up' } }))
    const code = codeOf(await confirmed(s, res))
    // Not a login code.
    await expect(
      s.anon.redeemHandoffCode({ code, codeVerifier: VERIFIER, state: APP_STATE }),
    ).rejects.toThrow()
    // A fresh code (the first was burned by the refused attempt).
    const again = codeOf(
      await confirmed(s, await finishApp(s, bridge(s, { app: { purpose: 'step-up' } }))),
    )
    const alice = await s.anon.login({ username: 'alice', password: 'pw-alice-1' })
    const payload = s.h.auth.verifyToken(alice.token)
    const caller = s.router.createCaller({
      user: {
        id: payload.userId ?? '',
        username: 'alice',
        isAdmin: false,
        permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
        isApiKey: false,
        interactive: true,
        userDelegated: true,
        ...(payload.sid !== undefined ? { sessionId: payload.sid } : {}),
      },
    })
    const proof = await caller.deviceEnrollProofFromHandoff({
      code: again,
      codeVerifier: VERIFIER,
      state: APP_STATE,
    })
    expect(proof.proof).toMatch(/^cdp_/)
    // Another user's session cannot turn the code into its own proof.
    const other = await finishApp(s, bridge(s, { app: { purpose: 'step-up' } }))
    const carol = await s.anon.login({ username: 'carol', password: 'pw-carol-1' })
    const carolPayload = s.h.auth.verifyToken(carol.token)
    const carolCaller = s.router.createCaller({
      user: {
        id: carolPayload.userId ?? '',
        username: 'carol',
        isAdmin: false,
        permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
        isApiKey: false,
        interactive: true,
        userDelegated: true,
        ...(carolPayload.sid !== undefined ? { sessionId: carolPayload.sid } : {}),
      },
    })
    await expect(
      carolCaller.deviceEnrollProofFromHandoff({
        code: codeOf(await confirmed(s, other)),
        codeVerifier: VERIFIER,
        state: APP_STATE,
      }),
    ).rejects.toThrow()
  })

  it('the dev client scheme comes back to the dev client', async () => {
    const s = boot()
    const res = await finishApp(s, bridge(s, { app: { redirect: 'camstack.dev://auth-callback' } }))
    expect(await confirmed(s, res)).toMatch(/^camstack\.dev:\/\/auth-callback\?code=/)
  })

  it('a signed redirect outside the allow-list is never followed', async () => {
    const s = boot()
    const res = await finishApp(s, bridge(s, { app: { redirect: 'https://evil.example/cb' } }))
    expect(String(res.headers.location)).toBe('camstack://auth-callback?error=not-app-flow')
    expect(s.handoffs.pendingCount).toBe(0)
  })

  it('an identity nobody linked -> error redirect with the state, no code', async () => {
    const s = boot({})
    const res = await finishApp(s, bridge(s))
    expect(String(res.headers.location)).toBe(
      `camstack://auth-callback?error=sso-not-linked&state=${APP_STATE}`,
    )
    expect(s.handoffs.pendingCount).toBe(0)
  })

  it('a replayed bridge is refused (single use)', async () => {
    const s = boot()
    const token = bridge(s)
    await finishApp(s, token)
    const replay = await finishApp(s, token)
    expect(String(replay.headers.location)).toBe(
      `camstack://auth-callback?error=sso-state&state=${APP_STATE}`,
    )
    expect(s.handoffs.pendingCount).toBe(0)
    expect(s.confirmations.pendingCount).toBe(1)
  })

  it('a bridge copied to another browser (no matching state cookie) is refused', async () => {
    const s = boot()
    const res = await finishApp(s, bridge(s), 'another-browsers-cookie-value-0123456789')
    expect(String(res.headers.location)).toContain('error=sso-state')
    expect(s.handoffs.pendingCount).toBe(0)
  })

  it('a forged or missing bridge answers at the default callback', async () => {
    const s = boot()
    expect(String((await finishApp(s, 'forged')).headers.location)).toBe(
      'camstack://auth-callback?error=invalid-bridge',
    )
    const none = await s.fastify.inject({ method: 'GET', url: '/api/auth/sso/finish-app' })
    expect(String(none.headers.location)).toBe('camstack://auth-callback?error=invalid-bridge')
  })

  it('a web bridge (no app claim) is not an app login; a link bridge never is one', async () => {
    const s = boot()
    expect(String((await finishApp(s, bridge(s, { app: null }))).headers.location)).toBe(
      'camstack://auth-callback?error=not-app-flow',
    )
    const link = await finishApp(s, bridge(s, { linkIntent: 'abcdefghijklmnopqrstuvwx' }))
    expect(String(link.headers.location)).toContain('error=link-not-supported')
    expect(s.handoffs.pendingCount).toBe(0)
  })

  it('a non-login bridge of the same signer (oauth account link) is refused', async () => {
    const s = boot()
    const res = await finishApp(s, bridge(s, { provider: 'oauth-code' }))
    expect(String(res.headers.location)).toBe('camstack://auth-callback?error=not-app-flow')
  })

  it('a user who owes a second factor gets an error redirect, not a code', async () => {
    const s = boot(undefined, ['u-alice'])
    const res = await finishApp(s, bridge(s))
    expect(String(res.headers.location)).toContain('error=second-factor-required')
    expect(s.handoffs.pendingCount).toBe(0)
  })

  it('never logs the app parameters', async () => {
    const s = boot({})
    await finishApp(s, bridge(s))
    const log = s.warnings.join('\n')
    expect(log).not.toContain(APP_STATE)
    expect(log).not.toContain(pkceChallenge(VERIFIER))
  })
})

describe('the web finish is unchanged', () => {
  it('still signs a web login in for a bridge without an app claim', async () => {
    const s = boot()
    const res = await s.fastify.inject({
      method: 'GET',
      url: `/api/auth/sso/finish?bridge=${encodeURIComponent(bridge(s, { app: null }))}`,
      headers: { cookie: `${SSO_STATE_COOKIE}=${BROWSER_STATE}` },
    })
    expect(res.statusCode).toBe(302)
    expect(String(res.headers.location)).toMatch(/\/login#token=/)
  })

  it('refuses an app bridge: it can only end at the app, never as a web session', async () => {
    const s = boot()
    const res = await s.fastify.inject({
      method: 'GET',
      url: `/api/auth/sso/finish?bridge=${encodeURIComponent(bridge(s))}`,
      headers: { cookie: `${SSO_STATE_COOKIE}=${BROWSER_STATE}` },
    })
    expect(res.statusCode).toBe(401)
    expect(s.handoffs.pendingCount).toBe(0)
  })
})
