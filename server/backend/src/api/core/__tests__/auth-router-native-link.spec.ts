/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- mock factories cross typed boundaries */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExternalLinkIntents } from '../../../auth/external-link-intents.js'
import {
  NativeLinkCompletions,
  type ParkedNativeLink,
} from '../../../auth/native-link-completions.js'
import { AuthService } from '../../../core/auth/auth.service.js'
import { HandoffCodeService } from '../../../core/auth/handoff-code.service.js'
import type { AuthenticatedAgent, TrpcContext } from '../../trpc/trpc.context.js'
import { createAuthRouter, type NativeLinkRouterDeps } from '../auth.router.js'
import { staticJwtSigningKey } from '@camstack/system'

/**
 * D801 — linking from the native app, and opening the account page in a
 * browser signed in. The app's return is allowlisted; the parked link is
 * claimed with the app's bearer and bound to the intent's user HERE.
 */

function makeAuth(): AuthService {
  return new AuthService(
    { get: () => undefined, update(): void {} } as never,
    undefined,
    staticJwtSigningKey('native-link-secret'),
  )
}

/** A fresh re-authentication proof for the default user (`auth.reauthenticate`). */
function proof(userId = 'u-alice'): string {
  return makeAuth().signReauthToken({ userId, method: 'password' })
}

function makeUser(overrides: Partial<AuthenticatedAgent> = {}): AuthenticatedAgent {
  return {
    id: 'u-alice',
    username: 'alice',
    isAdmin: false,
    permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
    isApiKey: false,
    interactive: true,
    userDelegated: true,
    ...overrides,
  } as AuthenticatedAgent
}

const registry = {
  getSingleton: () => null,
  getCollection: () => [],
  getCollectionEntries: () => [
    [
      'auth-oidc',
      {
        getLoginMethods: async () => [
          {
            kind: 'redirect',
            id: 'auth-oidc/authentik',
            label: 'Authentik',
            startUrl: '/addon/auth-oidc/authentik/start',
            stage: 'primary',
            linkable: true,
          },
        ],
      },
    ],
  ],
  isProviderDisabled: () => false,
}

const PARKED: ParkedNativeLink = {
  userId: 'u-alice',
  provider: 'auth-oidc/authentik',
  subject: 'sub-1',
  issuer: 'https://idp/',
  label: 'alice@x',
}

describe('auth — native link and browser handoff (D801)', () => {
  let intents: ExternalLinkIntents
  let deps: NativeLinkRouterDeps & { link: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    intents = new ExternalLinkIntents()
    deps = {
      completions: new NativeLinkCompletions(),
      browserHandoffs: new HandoffCodeService(),
      link: vi.fn(async () => 'linked' as const),
    }
  })

  function caller(
    user: AuthenticatedAgent = makeUser(),
    native: NativeLinkRouterDeps | null = deps,
  ) {
    const router = createAuthRouter(
      makeAuth(),
      registry as never,
      null,
      new HandoffCodeService(),
      intents,
      native,
    )
    const ctx: TrpcContext = { user }
    return router.createCaller(ctx)
  }

  it('beginExternalLink carries an allowlisted app return into the intent', async () => {
    const { url } = await caller().beginExternalLink({
      provider: 'auth-oidc/authentik',
      returnTo: 'camstack:///auth-callback',
      reauthToken: proof(),
    })
    const handle = new URL(url, 'https://hub').searchParams.get('link') ?? ''
    expect(intents.consume(handle)).toEqual({
      userId: 'u-alice',
      provider: 'auth-oidc/authentik',
      returnTo: 'camstack://auth-callback',
    })
  })

  it('refuses any other return target', async () => {
    for (const returnTo of [
      'https://evil.example/cb',
      'camstack://auth-callback?x=1',
      'evil://auth-callback',
    ]) {
      await expect(
        caller().beginExternalLink({
          provider: 'auth-oidc/authentik',
          returnTo,
          reauthToken: proof(),
        }),
      ).rejects.toThrow(/not an allowed app callback/)
    }
  })

  it('the intent’s own user claims the parked link — through the finish’s link step', async () => {
    const code = deps.completions.park(PARKED)
    expect(await caller().completeExternalLink({ code })).toEqual({
      outcome: 'linked',
      provider: 'auth-oidc/authentik',
    })
    expect(deps.link).toHaveBeenCalledWith(PARKED)
  })

  it('ANOTHER user claiming the code links nothing — and spends it', async () => {
    const code = deps.completions.park(PARKED)
    expect(await caller(makeUser({ id: 'u-mallory' })).completeExternalLink({ code })).toEqual({
      outcome: 'session',
    })
    expect(deps.link).not.toHaveBeenCalled()
    expect(await caller().completeExternalLink({ code })).toEqual({ outcome: 'expired' })
  })

  it('a conflict is reported, not thrown', async () => {
    deps.link.mockResolvedValueOnce('conflict')
    const code = deps.completions.park(PARKED)
    expect((await caller().completeExternalLink({ code })).outcome).toBe('conflict')
  })

  it('a scoped token cannot claim a link or open a browser session', async () => {
    const code = deps.completions.park(PARKED)
    await expect(
      caller(makeUser({ interactive: false, userDelegated: false })).completeExternalLink({ code }),
    ).rejects.toThrow(/real user session/)
    await expect(
      caller(makeUser({ interactive: false, userDelegated: false })).createBrowserHandoff(),
    ).rejects.toThrow(/real user session/)
  })

  it('createBrowserHandoff mints a one-time code for the CALLER and names only the handoff route', async () => {
    const { path } = await caller().createBrowserHandoff()
    const parsed = new URL(path, 'https://hub')
    expect(parsed.pathname).toBe('/api/auth/browser-handoff')
    expect([...parsed.searchParams.keys()]).toEqual(['code'])
    const code = parsed.searchParams.get('code') ?? ''
    expect(deps.browserHandoffs.redeem(code)).toEqual({ userId: 'u-alice', purpose: 'new-session' })
    expect(deps.browserHandoffs.redeem(code)).toBeNull()
  })

  it('a hub without the native wiring says so', async () => {
    await expect(caller(makeUser(), null).completeExternalLink({ code: 'nlc_x' })).rejects.toThrow(
      /not available/,
    )
  })
})
