/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- mock factories cross typed boundaries */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExternalLinkIntents } from '../../../auth/external-link-intents.js'
import { AuthService } from '../../../core/auth/auth.service.js'
import { HandoffCodeService } from '../../../core/auth/handoff-code.service.js'
import type { AuthenticatedAgent, TrpcContext } from '../../trpc/trpc.context.js'
import { createAuthRouter } from '../auth.router.js'
import { staticJwtSigningKey } from '@camstack/system'

/**
 * D782 — a signed-in user links an OIDC identity to THEIR OWN account. The
 * hub mints the link intent for the calling session's user and hands back the
 * provider's start URL with an opaque `?link=` handle; the user id never
 * leaves the server. The profile lists and removes the caller's own links.
 */

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
    staticJwtSigningKey('unit-test-secret'),
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

const redirect = (id: string, label: string, startUrl: string, linkable?: boolean) => ({
  kind: 'redirect' as const,
  id,
  label,
  startUrl,
  stage: 'primary' as const,
  ...(linkable !== undefined ? { linkable } : {}),
})

type LoginMethodEntry = readonly [string, { getLoginMethods: () => Promise<unknown[]> }]

function makeRegistry(
  disabled: ReadonlyArray<readonly [string, string]> = [],
  extra: readonly LoginMethodEntry[] = [],
) {
  const userMgmt = {
    listExternalIdentities: vi.fn(async ({ userId }: { userId: string }) => [
      { provider: 'auth-oidc/authentik', subject: 's-1', userId, label: 'alice@x', linkedAt: 1 },
      { provider: 'auth-oidc/retired', subject: 's-2', userId, linkedAt: 2 },
    ]),
    unlinkExternalIdentity: vi.fn(async () => ({ success: true })),
  }
  const entries = [
    [
      'auth-oidc',
      {
        getLoginMethods: async () => [
          redirect('auth-oidc/authentik', 'Authentik', '/addon/auth-oidc/authentik/start', true),
        ],
      },
    ],
    [
      'auth-example',
      {
        getLoginMethods: async () => [
          redirect('auth-example', 'Email', '/addon/auth-example/start'),
        ],
      },
    ],
    ...extra,
  ] as const
  return {
    userMgmt,
    registry: {
      getSingleton: (name: string) => (name === 'user-management' ? userMgmt : null),
      getCollection: () => entries.map(([, p]) => p),
      getCollectionEntries: () => entries,
      isProviderDisabled: (cap: string, addonId: string) =>
        disabled.some(([c, a]) => c === cap && a === addonId),
    },
  }
}

describe('auth — linking an external sign-in identity (D782)', () => {
  let intents: ExternalLinkIntents
  beforeEach(() => {
    intents = new ExternalLinkIntents()
  })

  function caller(registry: unknown, user: AuthenticatedAgent | null = makeUser()) {
    const router = createAuthRouter(
      makeAuth(),
      registry as never,
      null,
      new HandoffCodeService(),
      intents,
    )
    const ctx: TrpcContext = { user }
    return router.createCaller(ctx)
  }

  it('lists the OIDC instances that can be linked — not a login-only redirect', async () => {
    const { registry } = makeRegistry()
    expect(await caller(registry).listLinkableProviders()).toEqual([
      { provider: 'auth-oidc/authentik', label: 'Authentik' },
    ])
  })

  it('linkable is the contract, not the id: a non-OIDC redirect declaring it is offered', async () => {
    const { registry } = makeRegistry(
      [],
      [
        [
          'auth-saml',
          {
            getLoginMethods: async () => [
              redirect('auth-saml/corp', 'Corp SSO', '/addon/auth-saml/corp/start', true),
            ],
          },
        ],
      ],
    )
    expect(await caller(registry).listLinkableProviders()).toEqual([
      { provider: 'auth-oidc/authentik', label: 'Authentik' },
      { provider: 'auth-saml/corp', label: 'Corp SSO' },
    ])
    const { url } = await caller(registry).beginExternalLink({
      provider: 'auth-saml/corp',
      reauthToken: proof(),
    })
    expect(url).toMatch(/^\/addon\/auth-saml\/corp\/start\?link=/)
  })

  it('a redirect without the flag is not linkable, even under an auth-oidc/ id', async () => {
    const { registry } = makeRegistry(
      [],
      [
        [
          'auth-oidc-legacy',
          {
            getLoginMethods: async () => [
              redirect('auth-oidc/legacy', 'Legacy', '/addon/auth-oidc/legacy/start'),
              redirect('auth-oidc/off', 'Off', '/addon/auth-oidc/off/start', false),
            ],
          },
        ],
      ],
    )
    expect(await caller(registry).listLinkableProviders()).toEqual([
      { provider: 'auth-oidc/authentik', label: 'Authentik' },
    ])
    await expect(
      caller(registry).beginExternalLink({ provider: 'auth-oidc/legacy', reauthToken: proof() }),
    ).rejects.toThrow(/not available for linking/)
  })

  it('a disabled provider cannot be linked', async () => {
    const { registry } = makeRegistry([['auth-provider', 'auth-oidc']])
    expect(await caller(registry).listLinkableProviders()).toEqual([])
    await expect(
      caller(registry).beginExternalLink({ provider: 'auth-oidc/authentik', reauthToken: proof() }),
    ).rejects.toThrow(/not available/)
  })

  it('beginExternalLink returns the start URL with an intent for the CALLER', async () => {
    const { registry } = makeRegistry()
    const { url } = await caller(registry).beginExternalLink({
      provider: 'auth-oidc/authentik',
      reauthToken: proof(),
    })
    const parsed = new URL(url, 'https://hub.example')
    expect(parsed.pathname).toBe('/addon/auth-oidc/authentik/start')
    const handle = parsed.searchParams.get('link') ?? ''
    expect(url).not.toContain('u-alice')
    expect(intents.consume(handle)).toEqual({
      userId: 'u-alice',
      provider: 'auth-oidc/authentik',
    })
  })

  it('refuses a scoped token or a share-view session', async () => {
    const { registry } = makeRegistry()
    await expect(
      caller(registry, makeUser({ interactive: false, userDelegated: false })).beginExternalLink({
        provider: 'auth-oidc/authentik',
        reauthToken: proof(),
      }),
    ).rejects.toThrow(/real user session/)
  })

  it('refuses an unknown provider', async () => {
    const { registry } = makeRegistry()
    await expect(
      caller(registry).beginExternalLink({ provider: 'auth-example', reauthToken: proof() }),
    ).rejects.toThrow(/not available/)
  })

  it('lists the caller’s own links, marking one whose provider is gone', async () => {
    const { registry, userMgmt } = makeRegistry()
    const links = await caller(registry).listOwnExternalIdentities()
    expect(userMgmt.listExternalIdentities).toHaveBeenCalledWith({ userId: 'u-alice' })
    expect(links).toEqual([
      {
        provider: 'auth-oidc/authentik',
        subject: 's-1',
        label: 'alice@x',
        linkedAt: 1,
        providerLabel: 'Authentik',
        available: true,
      },
      {
        provider: 'auth-oidc/retired',
        subject: 's-2',
        linkedAt: 2,
        providerLabel: null,
        available: false,
      },
    ])
  })

  it('unlinks only from the caller’s own account', async () => {
    const { registry, userMgmt } = makeRegistry()
    await caller(registry).unlinkOwnExternalIdentity({
      provider: 'auth-oidc/retired',
      subject: 's-2',
    })
    expect(userMgmt.unlinkExternalIdentity).toHaveBeenCalledWith({
      userId: 'u-alice',
      provider: 'auth-oidc/retired',
      subject: 's-2',
    })
  })
})
