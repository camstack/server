import { createHash } from 'node:crypto'
import type { IUserPasskeysProvider } from '@camstack/types'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { HandoffCodeService, pkceChallenge } from '../../core/auth/handoff-code.service.js'
import { APP_PASSKEY_CSP } from '../app-passkey-page.js'
import { registerAppConfirmRoutes } from '../app-confirm-routes.js'
import { AppConfirmations } from '../app-confirmations.js'
import { appPageCsp } from '../app-page-shell.js'
import { registerAppPasskeyRoutes } from '../app-passkey-routes.js'
import { DEFAULT_AUTH_NETWORK_POLICY } from '../auth-network-policy.js'
import { createRateLimiter } from '../auth-rate-limit.js'
import type { SecondFactor } from '../second-factors.js'
import { SessionUserGoneError } from '../session-mint.js'

/** The passkey app page and its two legs (D858). */

const VERIFIER = 'p'.repeat(64)
const STATE = 'app-state-0123456789'
const FLOW = {
  code_challenge: pkceChallenge(VERIFIER),
  code_challenge_method: 'S256',
  state: STATE,
  purpose: 'new-session',
}
const QUERY = new URLSearchParams(FLOW).toString()

interface Options {
  readonly verified?: boolean
  readonly userId?: string | null
  readonly factors?: readonly SecondFactor[]
  readonly noProvider?: boolean
  readonly userGone?: boolean
  readonly max?: number
}

let open: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(open.map((f) => f.close()))
  open = []
})

function boot(opts: Options = {}) {
  const fastify = Fastify()
  open.push(fastify)
  const handoffs = new HandoffCodeService()
  const confirmations = new AppConfirmations()
  const calls: string[] = []
  const logs: string[] = []
  const provider = {
    beginDiscoverableAuthentication: async () => {
      calls.push('begin')
      return { optionsJSON: { challenge: 'Y2hhbGxlbmdl', allowCredentials: [] } }
    },
    finishDiscoverableAuthentication: async () => {
      calls.push('finish')
      return {
        verified: opts.verified ?? true,
        userId: opts.userId === undefined ? 'u-alice' : opts.userId,
      }
    },
  } as unknown as IUserPasskeysProvider
  registerAppPasskeyRoutes(fastify, {
    passkeys: () => (opts.noProvider === true ? null : provider),
    secondFactors: async () => opts.factors ?? [],
    minter: {
      findUser: async (id: string) => {
        if (opts.userGone === true) throw new SessionUserGoneError(id)
        return { id, username: 'alice', isAdmin: false, allowedProviders: '*', allowedDevices: {} }
      },
    } as never,
    confirmations,
    network: DEFAULT_AUTH_NETWORK_POLICY,
    limiter: createRateLimiter({ windowMs: 60_000, max: opts.max ?? 1_000 }),
    logger: {
      warn: (m, o) => void logs.push(`${m} ${JSON.stringify(o?.meta ?? {})}`),
      error: (m, o) => void logs.push(`${m} ${JSON.stringify(o?.meta ?? {})}`),
    },
  })
  const finish = (body: Record<string, unknown> = {}) =>
    fastify.inject({
      method: 'POST',
      url: '/auth/app/passkey/finish',
      payload: { response: { id: 'cred' }, ...FLOW, ...body },
    })
  registerAppConfirmRoutes(fastify, {
    confirmations,
    handoffCodes: handoffs,
    network: DEFAULT_AUTH_NETWORK_POLICY,
    limiter: createRateLimiter({ windowMs: 60_000, max: 1_000 }),
    logger: { warn: () => undefined },
  })
  /** Continue pressed on the confirmation page the finish pointed at: the app location. */
  const confirm = async (res: { json: <T>() => T; headers: Record<string, unknown> }) => {
    const next = res.json<{ confirm?: string; location?: string }>()
    if (next.confirm === undefined) return String(next.location)
    const token = new URL(next.confirm, 'https://hub.example/auth/app/').searchParams.get('confirm')
    const cookie = [res.headers['set-cookie']].flat().map(String)[0]?.split(';')[0] ?? ''
    const post = await fastify.inject({
      method: 'POST',
      url: '/auth/app/confirm',
      headers: { cookie },
      payload: { confirm: token },
    })
    return post.json<{ location: string }>().location
  }
  return { fastify, handoffs, confirmations, calls, logs, finish, confirm }
}

describe('GET /auth/app/passkey', () => {
  it('serves a standalone page with a tight CSP, no third-party asset, and a cancel link', async () => {
    const { fastify } = boot()
    const res = await fastify.inject({ method: 'GET', url: `/auth/app/passkey?${QUERY}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['content-security-policy']).toBe(APP_PASSKEY_CSP)
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toContain("default-src 'none'")
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/)
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('unsafe')
    expect(res.headers['cache-control']).toBe('no-store')
    const body = res.body
    expect(body).toContain('Sign in with a passkey')
    expect(body).not.toMatch(/(src|href)="https?:/)
    expect(body).toContain(`href="camstack://auth-callback?error=cancelled&#38;state=${STATE}"`)
    // The one inline script is exactly what the CSP hashes.
    const script = /<script>([\s\S]*)<\/script>/.exec(body)?.[1] ?? ''
    expect(csp).toContain(`'sha256-${createHash('sha256').update(script).digest('base64')}'`)
    // It parses (a syntax slip would otherwise only show on a phone).
    expect(() => new Function(script)).not.toThrow()
  })

  it.each([
    ['no challenge', 'code_challenge', ''],
    ['a plain method', 'code_challenge_method', 'plain'],
    ['no state', 'state', ''],
    ['a bad purpose', 'purpose', 'renew'],
    ['a foreign redirect', 'redirect', 'https://evil.example'],
  ])('refuses %s with a page that runs nothing', async (_n, key, value) => {
    const { fastify } = boot()
    const params = new URLSearchParams(FLOW)
    if (value === '') params.delete(key)
    else params.set(key, value)
    const res = await fastify.inject({ method: 'GET', url: `/auth/app/passkey?${params}` })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('Sign-in request refused')
    expect(res.body).not.toContain('<script')
    // Nothing runs and nothing loads, but the shell's one style is allowed (by hash).
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toBe(appPageCsp())
    expect(csp).not.toContain('script-src')
    expect(csp).toContain("default-src 'none'")
  })
})

describe('POST /auth/app/passkey/begin and /finish', () => {
  it('begin returns assertion options for a valid flow, and refuses a request without one', async () => {
    const { fastify, calls } = boot()
    const ok = await fastify.inject({
      method: 'POST',
      url: '/auth/app/passkey/begin',
      payload: FLOW,
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ optionsJSON: { challenge: 'Y2hhbGxlbmdl' } })
    const bad = await fastify.inject({
      method: 'POST',
      url: '/auth/app/passkey/begin',
      payload: {},
    })
    expect(bad.statusCode).toBe(400)
    expect(calls).toEqual(['begin'])
  })

  it('a verified assertion -> the CONFIRMATION page, and NO code until Continue', async () => {
    const { finish, handoffs, confirmations } = boot()
    const res = await finish()
    expect(res.statusCode).toBe(200)
    expect(res.json<{ confirm: string }>().confirm).toMatch(/^confirm\?confirm=[A-Za-z0-9_-]+$/)
    expect(String(res.headers['set-cookie'])).toMatch(/^camstack_app_confirm=.*HttpOnly/)
    expect(handoffs.pendingCount).toBe(0)
    expect(confirmations.pendingCount).toBe(1)
  })

  it('Continue mints the code: PKCE- and state-bound, at the app', async () => {
    const { finish, confirm, handoffs } = boot()
    const location = new URL(await confirm(await finish()))
    expect(`${location.protocol}//${location.host}`).toBe('camstack://auth-callback')
    expect(location.searchParams.get('state')).toBe(STATE)
    const code = location.searchParams.get('code') ?? ''
    // Wrong verifier is refused (and burns the code) ...
    expect(
      handoffs.redeemWithReason(code, { codeVerifier: 'x'.repeat(64), state: STATE }).grant,
    ).toBeNull()
    // ... the right one redeems on a fresh code.
    const again = new URL(await confirm(await finish()))
    const grant = handoffs.redeem(again.searchParams.get('code') ?? '', {
      codeVerifier: VERIFIER,
      state: STATE,
    })
    expect(grant).toMatchObject({
      userId: 'u-alice',
      purpose: 'new-session',
      authMethod: 'passkey',
    })
  })

  it('step-up purpose: the code is a step-up code (a proof at the hub, never a session)', async () => {
    const { finish, confirm, handoffs } = boot()
    const code = new URL(await confirm(await finish({ purpose: 'step-up' }))).searchParams.get(
      'code',
    )
    const grant = handoffs.redeem(code ?? '', { codeVerifier: VERIFIER, state: STATE })
    expect(grant).toMatchObject({ purpose: 'step-up', userId: 'u-alice', authMethod: 'passkey' })
  })

  it('an assertion that does not verify mints nothing and redirects with an error', async () => {
    const { finish, handoffs, logs } = boot({ verified: false })
    const res = await finish()
    expect(res.json<{ location: string }>().location).toBe(
      `camstack://auth-callback?error=passkey-failed&state=${STATE}`,
    )
    expect(handoffs.pendingCount).toBe(0)
    expect(logs.join('\n')).not.toContain(STATE)
  })

  it('no ceremony, no code: an unverified userId, a missing provider, a vanished user', async () => {
    for (const opts of [{ userId: null }, { noProvider: true }, { userGone: true }] as const) {
      const { finish, handoffs } = boot(opts)
      const res = await finish()
      expect(res.json<{ location: string }>().location).toContain('error=')
      expect(handoffs.pendingCount).toBe(0)
    }
  })

  it('a user who owes a second factor gets an error redirect, not a code', async () => {
    const { finish, handoffs } = boot({ factors: ['totp'] })
    const res = await finish()
    expect(res.json<{ location: string }>().location).toContain('error=second-factor-required')
    expect(handoffs.pendingCount).toBe(0)
  })

  it('the finish takes its destination from the allow-list only (no open redirect)', async () => {
    const { finish, handoffs, confirm } = boot()
    const evil = await finish({ redirect: 'https://evil.example/cb' })
    expect(evil.statusCode).toBe(400)
    expect(evil.body).not.toContain('evil.example')
    expect(handoffs.pendingCount).toBe(0)
    const dev = await confirm(await finish({ redirect: 'camstack.dev://auth-callback' }))
    expect(dev).toMatch(/^camstack\.dev:\/\/auth-callback\?code=/)
  })

  it('a finish without PKCE or state is a 400 and the provider is never asked', async () => {
    const { finish, calls } = boot()
    expect((await finish({ code_challenge: undefined })).statusCode).toBe(400)
    expect((await finish({ state: undefined })).statusCode).toBe(400)
    expect(calls).toEqual([])
  })

  it('is rate limited per client', async () => {
    const { finish } = boot({ max: 2 })
    await finish()
    await finish()
    expect((await finish()).statusCode).toBe(429)
  })
})
