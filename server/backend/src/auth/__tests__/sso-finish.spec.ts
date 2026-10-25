import { createHash } from 'node:crypto'
import type { TokenScope } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AuthService } from '../../core/auth/auth.service.js'
import { ExternalLinkIntents } from '../external-link-intents.js'
import { NativeLinkCompletions } from '../native-link-completions.js'
import type { SecondFactor } from '../second-factors.js'
import { createSessionMinter, type SessionUserRecord } from '../session-mint.js'
import { UsedBridgeIds } from '../used-bridge-ids.js'
import {
  finishSsoLogin,
  popupCompletionLocation,
  type SsoFinishOptions,
  type SsoFinishOutcome,
} from '../sso-finish.js'
import { staticJwtSigningKey } from '@camstack/system'

/**
 * `/api/auth/sso/finish` mints through THE session mint (D712): the session
 * carries the user record as it is at mint time, never the bridge's claims.
 * An OIDC identity signs in ONLY the user it was explicitly linked to, and
 * links only through a hub-side intent bound to the signed-in session (D782).
 */

const SCOPES: TokenScope[] = [{ type: 'category', target: 'device', access: ['view'] }]

function makeAuth(): AuthService {
  const store: Record<string, unknown> = {}
  return new AuthService(
    {
      get<T>(path: string): T {
        return store[path] as T
      },
      update(): void {},
    } as never,
    undefined,
    staticJwtSigningKey('sso-finish-secret'),
  )
}

interface SetupOptions {
  readonly disabledAddons?: readonly string[]
  /** `(provider, subject)` → userId already linked (issuer {@link ISS} unless given). */
  readonly links?: ReadonlyArray<readonly [string, string, string, string?]>
  /** The user the request's session cookie names, if any. */
  readonly sessionUserId?: string | null
  readonly factors?: Readonly<Record<string, readonly SecondFactor[]>>
  /** The state cookie the finishing request presents; `null` = none. Default: the one bridges are bound to. */
  readonly browserState?: string | null
  /** Share the single-use record between two setups (two browsers, one hub). */
  readonly usedBridgeIds?: UsedBridgeIds
  /** The finishing request came directly from a trusted network (opt-in skip). */
  readonly trustedNetwork?: boolean
  readonly skipped?: string[]
}

/** The state cookie value the IdP `/start` set in the test browser. */
const BROWSER_STATE = 'browser-state-cookie-value-0123456789abcdef'
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

function setup(users: SessionUserRecord[] | null, opts: SetupOptions = {}) {
  const auth = makeAuth()
  const minter = createSessionMinter({
    signer: auth,
    directory: () => (users === null ? null : { listUsers: async () => users }),
  })
  const links = new Map<string, { userId: string; issuer: string }>(
    (opts.links ?? []).map(([p, s, u, i]) => [
      JSON.stringify([p, s]),
      { userId: u, issuer: i ?? ISS },
    ]),
  )
  const intents = new ExternalLinkIntents()
  const parked = new NativeLinkCompletions()
  const usedBridgeIds = opts.usedBridgeIds ?? new UsedBridgeIds()
  const browserState = opts.browserState === undefined ? BROWSER_STATE : opts.browserState
  const finish = (
    bridge: string | undefined,
    options?: SsoFinishOptions,
  ): Promise<SsoFinishOutcome> =>
    finishSsoLogin(
      bridge,
      {
        verifyBridge: (token) => auth.verifySsoBridgeToken(token),
        minter,
        isProviderDisabled: (addonId) => (opts.disabledAddons ?? []).includes(addonId),
        identities: {
          findUser: async (provider, subject) =>
            links.get(JSON.stringify([provider, subject])) ?? null,
          link: async ({ userId, provider, subject, issuer }) => {
            const key = JSON.stringify([provider, subject])
            const holder = links.get(key)
            if (holder !== undefined && holder.userId !== userId) return 'conflict'
            links.set(key, { userId, issuer })
            return 'linked'
          },
        },
        consumeLinkIntent: (handle) => intents.consume(handle),
        parkNativeLink: (link) => parked.park(link),
        browserBinding: () => (browserState === null ? null : sha256(browserState)),
        ...(opts.trustedNetwork !== undefined
          ? {
              trustedNetworkLogin: () => opts.trustedNetwork === true,
              auditSkip: async (userId: string) => {
                opts.skipped?.push(userId)
              },
            }
          : {}),
        consumeBridgeId: (jti) => usedBridgeIds.consume(jti),
        sessionUserId: () => opts.sessionUserId ?? null,
        secondFactors: async (userId) => [...(opts.factors?.[userId] ?? [])],
        signChallenge: (user) => auth.signTotpChallengeToken(user),
      },
      options,
    )
  return { auth, finish, intents, links, parked }
}

function tokenOf(outcome: SsoFinishOutcome): string {
  if (outcome.kind !== 'redirect') throw new Error(`expected a redirect, got ${outcome.status}`)
  const match = /#token=([^&]+)/.exec(outcome.location)
  if (match === null || match[1] === undefined) throw new Error('no token in the redirect')
  return decodeURIComponent(match[1])
}

function locationOf(outcome: SsoFinishOutcome): string {
  if (outcome.kind !== 'redirect') throw new Error(`expected a redirect, got ${outcome.status}`)
  return outcome.location
}

const ALICE: SessionUserRecord = {
  id: 'u-alice',
  username: 'alice',
  isAdmin: false,
  allowedProviders: '*',
  allowedDevices: { 'provider-hikvision': ['101'] },
  scopes: SCOPES,
}

const OIDC_PROVIDER = 'auth-oidc/authentik'
const ISS = 'https://auth.example.com/application/o/camstack/'
const OIDC_USER_ID = 'oidc:authentik:sub-1'

let bridgeSeq = 0

function oidcBridge(
  auth: AuthService,
  extra: {
    linkIntent?: string
    isAdmin?: boolean
    issuer?: string | null
    userId?: string
    /** `null` = a bridge without one. Default: a fresh id. */
    jti?: string | null
    /** `null` = a bridge without one. Default: bound to {@link BROWSER_STATE}. */
    binding?: string | null
  } = {},
) {
  bridgeSeq += 1
  return auth.signSsoBridgeToken({
    userId: extra.userId ?? OIDC_USER_ID,
    username: 'alice@example.com',
    isAdmin: extra.isAdmin ?? false,
    provider: OIDC_PROVIDER,
    ...(extra.issuer === null ? {} : { issuer: extra.issuer ?? ISS }),
    ...(extra.linkIntent !== undefined ? { linkIntent: extra.linkIntent } : {}),
    ...(extra.jti === null ? {} : { jti: extra.jti ?? `jti-${bridgeSeq}` }),
    ...(extra.binding === null ? {} : { browserBinding: extra.binding ?? sha256(BROWSER_STATE) }),
  })
}

describe('SSO finish — magic-link is gone', () => {
  it('a bridge naming the retired magic-link provider is not a login bridge — no session', async () => {
    const { auth, finish } = setup([ALICE])
    const bridge = auth.signSsoBridgeToken({
      userId: ALICE.id,
      username: ALICE.username,
      isAdmin: false,
      provider: 'auth-magic-link',
      email: 'alice@example.com',
    })
    expect(await finish(bridge)).toEqual({
      kind: 'error',
      status: 401,
      body: { error: 'Not a login bridge token' },
    })
  })
})

describe('SSO finish — an OIDC login (explicit linking, D782)', () => {
  it('a LINKED identity signs in the linked user, from that user’s record', async () => {
    const { auth, finish } = setup([ALICE], { links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]] })
    const payload = auth.verifyToken(tokenOf(await finish(oidcBridge(auth, { isAdmin: true }))))
    expect(payload.userId).toBe(ALICE.id)
    expect(payload.isAdmin).toBe(false)
    expect(payload.scopes).toEqual(SCOPES)
    expect(payload.allowedDevices).toEqual(ALICE.allowedDevices)
  })

  it('user-management not registered is a 500, never a session', async () => {
    const { auth, finish } = setup(null, { links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]] })
    const outcome = await finish(oidcBridge(auth))
    expect(outcome.kind === 'error' && outcome.status).toBe(500)
  })

  it('an UNLINKED identity is refused with a message for the login page — no session', async () => {
    const { auth, finish } = setup([ALICE])
    const location = locationOf(await finish(oidcBridge(auth)))
    expect(location).not.toContain('#token=')
    expect(location).toBe(
      `/login#error=sso-not-linked&provider=${encodeURIComponent(OIDC_PROVIDER)}`,
    )
  })

  it('the same subject from ANOTHER issuer is not the linked identity (instance repointed)', async () => {
    const { auth, finish } = setup([ALICE], { links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]] })
    const location = locationOf(
      await finish(oidcBridge(auth, { issuer: 'https://other-idp.example/' })),
    )
    expect(location).toContain('#error=sso-not-linked')
  })

  it('an OIDC bridge without an issuer is refused', async () => {
    const { auth, finish } = setup([ALICE], { links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]] })
    expect(await finish(oidcBridge(auth, { issuer: null }))).toMatchObject({
      kind: 'error',
      status: 401,
    })
  })

  it('a failure never echoes internal detail to the browser', async () => {
    const { auth, finish } = setup(null, { links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]] })
    const outcome = await finish(oidcBridge(auth))
    expect(outcome).toEqual({ kind: 'error', status: 500, body: { error: 'SSO finish failed' } })
  })

  it('the same subject under ANOTHER provider instance is not linked', async () => {
    const { auth, finish } = setup([ALICE], { links: [['auth-oidc/google', 'sub-1', ALICE.id]] })
    expect(locationOf(await finish(oidcBridge(auth)))).toContain('#error=sso-not-linked')
  })

  it('a link to a user deleted since is a 401', async () => {
    const { auth, finish } = setup([], { links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]] })
    expect(await finish(oidcBridge(auth))).toMatchObject({ kind: 'error', status: 401 })
  })

  it('the linked user’s TOTP still applies', async () => {
    const { auth, finish } = setup([ALICE], {
      links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]],
      factors: { [ALICE.id]: ['totp', 'passkey'] },
    })
    const location = locationOf(await finish(oidcBridge(auth)))
    expect(location).toMatch(/^\/login#challenge=/)
    expect(new URLSearchParams(location.split('#')[1]).get('factors')).toBe('totp,passkey')
  })

  it('an `oidc:` id signed by a non-OIDC provider is not an OIDC identity: 401', async () => {
    const { auth, finish } = setup([])
    const bridge = auth.signSsoBridgeToken({
      userId: OIDC_USER_ID,
      username: 'x',
      isAdmin: true,
      provider: 'auth-saml',
    })
    expect(await finish(bridge)).toMatchObject({ kind: 'error', status: 401 })
  })

  it('an OIDC bridge whose id names another instance is refused', async () => {
    const { auth, finish } = setup([ALICE], { links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]] })
    const bridge = oidcBridge(auth, { userId: 'oidc:google:sub-1' })
    expect(await finish(bridge)).toMatchObject({ kind: 'error', status: 401 })
  })
})

describe('SSO finish — linking an OIDC identity (D782)', () => {
  it('links the identity to the intent’s user when the session cookie is that user', async () => {
    const { auth, finish, intents, links } = setup([ALICE], { sessionUserId: ALICE.id })
    const handle = intents.create(ALICE.id, OIDC_PROVIDER)
    const location = locationOf(await finish(oidcBridge(auth, { linkIntent: handle })))
    expect(location).toBe(`/system/my-access?linked=${encodeURIComponent(OIDC_PROVIDER)}`)
    expect(links.get(JSON.stringify([OIDC_PROVIDER, 'sub-1']))).toEqual({
      userId: ALICE.id,
      issuer: ISS,
    })
  })

  it('never signs anyone in', async () => {
    const { auth, finish, intents } = setup([ALICE], { sessionUserId: ALICE.id })
    const handle = intents.create(ALICE.id, OIDC_PROVIDER)
    expect(locationOf(await finish(oidcBridge(auth, { linkIntent: handle })))).not.toContain(
      'token=',
    )
  })

  it('refuses when the browser’s session is ANOTHER user (link-CSRF)', async () => {
    const { auth, finish, intents, links } = setup([ALICE], { sessionUserId: 'u-mallory' })
    const handle = intents.create(ALICE.id, OIDC_PROVIDER)
    const location = locationOf(await finish(oidcBridge(auth, { linkIntent: handle })))
    expect(location).toBe('/system/my-access?linkError=session')
    expect(links.size).toBe(0)
  })

  it('refuses when the browser carries no session at all', async () => {
    const { auth, finish, intents, links } = setup([ALICE], { sessionUserId: null })
    const handle = intents.create(ALICE.id, OIDC_PROVIDER)
    expect(locationOf(await finish(oidcBridge(auth, { linkIntent: handle })))).toContain(
      'linkError=session',
    )
    expect(links.size).toBe(0)
  })

  it('a replayed link bridge links nothing more', async () => {
    const { auth, finish, intents } = setup([ALICE], { sessionUserId: ALICE.id })
    const handle = intents.create(ALICE.id, OIDC_PROVIDER)
    const bridge = oidcBridge(auth, { linkIntent: handle })
    await finish(bridge)
    expect(locationOf(await finish(bridge))).toContain('linkError=state')
  })

  it('an intent is single-use even under a NEW bridge', async () => {
    const { auth, finish, intents } = setup([ALICE], { sessionUserId: ALICE.id })
    const handle = intents.create(ALICE.id, OIDC_PROVIDER)
    await finish(oidcBridge(auth, { linkIntent: handle }))
    expect(locationOf(await finish(oidcBridge(auth, { linkIntent: handle })))).toContain(
      'linkError=expired',
    )
  })

  it('an intent minted for another provider instance is refused', async () => {
    const { auth, finish, intents, links } = setup([ALICE], { sessionUserId: ALICE.id })
    const handle = intents.create(ALICE.id, 'auth-oidc/google')
    expect(locationOf(await finish(oidcBridge(auth, { linkIntent: handle })))).toContain(
      'linkError=provider',
    )
    expect(links.size).toBe(0)
  })

  it('an identity already linked to another user is refused, the other link kept', async () => {
    const { auth, finish, intents, links } = setup([ALICE], {
      sessionUserId: ALICE.id,
      links: [[OIDC_PROVIDER, 'sub-1', 'u-bob']],
    })
    const handle = intents.create(ALICE.id, OIDC_PROVIDER)
    expect(locationOf(await finish(oidcBridge(auth, { linkIntent: handle })))).toContain(
      'linkError=conflict',
    )
    expect(links.get(JSON.stringify([OIDC_PROVIDER, 'sub-1']))?.userId).toBe('u-bob')
  })
})

describe('SSO finish — a link started from the native app (D801)', () => {
  const APP = 'camstack://auth-callback'

  it('parks the identity under a one-time code and returns to the app — no cookie needed', async () => {
    const { auth, finish, intents, links, parked } = setup([ALICE], { sessionUserId: null })
    const handle = intents.create(ALICE.id, OIDC_PROVIDER, APP)
    const location = locationOf(await finish(oidcBridge(auth, { linkIntent: handle })))
    expect(location).toMatch(/^camstack:\/\/auth-callback\?link=nlc_/)
    // Nothing is linked yet: only the app's claim, bound to its bearer, links.
    expect(links.size).toBe(0)
    const code = decodeURIComponent(location.split('link=')[1] ?? '')
    expect(parked.claim(code)).toEqual({
      userId: ALICE.id,
      provider: OIDC_PROVIDER,
      subject: 'sub-1',
      issuer: ISS,
      label: 'alice@example.com',
    })
  })

  it('never signs anyone in, and never carries a session to the app', async () => {
    const { auth, finish, intents } = setup([ALICE])
    const handle = intents.create(ALICE.id, OIDC_PROVIDER, APP)
    const location = locationOf(await finish(oidcBridge(auth, { linkIntent: handle })))
    expect(location).not.toContain('token=')
  })

  it('a provider mismatch goes back to the app as an error', async () => {
    const { auth, finish, intents } = setup([ALICE])
    const handle = intents.create(ALICE.id, 'auth-oidc/google', APP)
    expect(locationOf(await finish(oidcBridge(auth, { linkIntent: handle })))).toBe(
      `${APP}?linkError=provider`,
    )
  })

  it('a popup flag does not wrap the app return in the completion page', async () => {
    const { auth, finish, intents } = setup([ALICE])
    const handle = intents.create(ALICE.id, OIDC_PROVIDER, APP)
    const location = locationOf(
      await finish(oidcBridge(auth, { linkIntent: handle }), { popup: true }),
    )
    expect(location.startsWith(`${APP}?link=`)).toBe(true)
  })
})

describe('SSO finish — a bridge is single-use and bound to the browser that started it', () => {
  it('SECURITY: a replayed login bridge mints nothing the second time', async () => {
    const { auth, finish } = setup([ALICE], { links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]] })
    const bridge = oidcBridge(auth)
    expect(locationOf(await finish(bridge))).toContain('#token=')
    const replay = locationOf(await finish(bridge))
    expect(replay).not.toContain('token=')
    expect(replay).toBe('/login#error=sso-state')
  })

  it('SECURITY: a bridge presented WITHOUT the state cookie (another browser) is refused', async () => {
    const { auth, finish } = setup([ALICE], {
      links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]],
      browserState: null,
    })
    expect(locationOf(await finish(oidcBridge(auth)))).toBe('/login#error=sso-state')
  })

  it("SECURITY: a bridge presented with ANOTHER browser's state cookie is refused", async () => {
    const { auth, finish } = setup([ALICE], {
      links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]],
      browserState: 'attacker-browser-state',
    })
    expect(locationOf(await finish(oidcBridge(auth)))).toBe('/login#error=sso-state')
  })

  it('a bridge stolen without the cookie is NOT burned: the real browser can still finish', async () => {
    const usedBridgeIds = new UsedBridgeIds()
    const victim = setup([ALICE], { links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]], usedBridgeIds })
    const bridge = oidcBridge(victim.auth, { jti: 'shared-jti' })
    // Same hub (one single-use record), but the attacker's request has no cookie.
    const attacker = setup([ALICE], {
      links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]],
      browserState: null,
      usedBridgeIds,
    })
    expect(locationOf(await attacker.finish(bridge))).toBe('/login#error=sso-state')
    expect(locationOf(await victim.finish(bridge))).toContain('#token=')
  })

  it('a bridge without a browser binding or without a jti is refused (an older OIDC addon)', async () => {
    const { auth, finish } = setup([ALICE], { links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]] })
    expect(locationOf(await finish(oidcBridge(auth, { binding: null })))).toBe(
      '/login#error=sso-state',
    )
    expect(locationOf(await finish(oidcBridge(auth, { jti: null })))).toBe('/login#error=sso-state')
  })

  it('a link bridge from another browser is refused with a profile message', async () => {
    const { auth, finish, intents, links } = setup([ALICE], {
      sessionUserId: ALICE.id,
      browserState: null,
    })
    const handle = intents.create(ALICE.id, OIDC_PROVIDER)
    expect(locationOf(await finish(oidcBridge(auth, { linkIntent: handle })))).toBe(
      '/system/my-access?linkError=state',
    )
    expect(links.size).toBe(0)
  })
})

describe('SSO finish — trusted-network second-factor skip (opt-in)', () => {
  it('a finish made directly from a trusted network gets the session, and the skip is audited', async () => {
    const skipped: string[] = []
    const { auth, finish } = setup([ALICE], {
      links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]],
      factors: { [ALICE.id]: ['totp'] },
      trustedNetwork: true,
      skipped,
    })
    expect(auth.verifyToken(tokenOf(await finish(oidcBridge(auth)))).userId).toBe(ALICE.id)
    expect(skipped).toEqual([ALICE.id])
  })

  it('otherwise the factor is owed', async () => {
    const { auth, finish } = setup([ALICE], {
      links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]],
      factors: { [ALICE.id]: ['totp'] },
      trustedNetwork: false,
    })
    expect(locationOf(await finish(oidcBridge(auth)))).toMatch(/^\/login#challenge=/)
  })
})

describe('SSO finish — what it refuses', () => {
  it('an OAuth account-link token is not a login bridge, even for a live user', async () => {
    const { auth, finish } = setup([ALICE])
    for (const provider of ['oauth-code', 'oauth-access', 'oauth-refresh']) {
      const bridge = auth.signSsoBridgeToken({
        userId: ALICE.id,
        username: ALICE.username,
        isAdmin: false,
        provider,
        scopes: SCOPES,
      })
      expect(await finish(bridge)).toEqual({
        kind: 'error',
        status: 401,
        body: { error: 'Not a login bridge token' },
      })
    }
  })

  it('no bridge is a 400; a forged or session token is a 401', async () => {
    const { auth, finish } = setup([ALICE])
    expect(await finish(undefined)).toMatchObject({ status: 400 })
    expect(await finish('garbage')).toMatchObject({ status: 401 })
    const session = (
      await createSessionMinter({
        signer: auth,
        directory: () => ({ listUsers: async () => [ALICE] }),
      }).mintForRecord(ALICE, { method: 'password' })
    ).token
    expect(await finish(session)).toMatchObject({ status: 401 })
  })
})

describe('SSO finish — a provider disabled on Identity → Authentication (D777)', () => {
  it('refuses an OIDC instance bridge when auth-oidc is disabled', async () => {
    const { auth, finish } = setup([ALICE], {
      disabledAddons: ['auth-oidc'],
      links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]],
    })
    expect(await finish(oidcBridge(auth))).toMatchObject({ kind: 'error', status: 401 })
  })

  it('disabling another provider does not affect this one', async () => {
    const { auth, finish } = setup([ALICE], {
      disabledAddons: ['auth-webauthn'],
      links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]],
    })
    expect((await finish(oidcBridge(auth))).kind).toBe('redirect')
  })
})

describe('SSO finish — a sign-in run in a popup window (D791)', () => {
  it('a popup login lands on the completion page with the session in the FRAGMENT', async () => {
    const { auth, finish } = setup([ALICE], { links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]] })
    const location = locationOf(await finish(oidcBridge(auth), { popup: true }))
    expect(location).toMatch(/^\/sso-complete#return=login&token=/)
    expect(location.split('#')[0]).toBe('/sso-complete')
    const params = new URLSearchParams(location.split('#')[1])
    expect(auth.verifyToken(params.get('token') ?? '').userId).toBe(ALICE.id)
    expect(params.get('provider')).toBe(OIDC_PROVIDER)
  })

  it('a popup login that owes a second factor carries the challenge, never a session', async () => {
    const { auth, finish } = setup([ALICE], {
      links: [[OIDC_PROVIDER, 'sub-1', ALICE.id]],
      factors: { [ALICE.id]: ['totp'] },
    })
    const location = locationOf(await finish(oidcBridge(auth), { popup: true }))
    const params = new URLSearchParams(location.split('#')[1])
    expect(params.get('return')).toBe('login')
    expect(params.get('challenge')).toBeTruthy()
    expect(params.get('token')).toBeNull()
  })

  it('a popup link lands on the completion page naming the profile outcome', async () => {
    const { auth, finish, intents } = setup([ALICE], { sessionUserId: ALICE.id })
    const handle = intents.create(ALICE.id, OIDC_PROVIDER)
    const location = locationOf(
      await finish(oidcBridge(auth, { linkIntent: handle }), { popup: true }),
    )
    expect(location).toBe(
      `/sso-complete#return=profile&linked=${encodeURIComponent(OIDC_PROVIDER)}`,
    )
  })

  it('without popup the returns are unchanged', async () => {
    const { auth, finish } = setup([ALICE])
    expect(locationOf(await finish(oidcBridge(auth), { popup: false }))).toMatch(/^\/login#error=/)
  })

  it('maps every return shape, and keeps a refusal readable', () => {
    expect(popupCompletionLocation('/system/my-access?linkError=session')).toBe(
      '/sso-complete#return=profile&linkError=session',
    )
    expect(popupCompletionLocation('/login#error=sso-not-linked&provider=auth-oidc%2Fa')).toBe(
      '/sso-complete#return=login&error=sso-not-linked&provider=auth-oidc%2Fa',
    )
  })
})
