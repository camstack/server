import { describe, expect, it } from 'vitest'
import { AuthService } from '../../../core/auth/auth.service.js'
import { createAuthRouter } from '../auth.router.js'
import { staticJwtSigningKey } from '@camstack/system'

/**
 * D777 — `auth.listLoginMethods` offers a method only when its addon is
 * enabled on Identity → Authentication. The page toggles `auth-provider` /
 * `user-passkeys`; the contributions arrive on `login-method`, a cap the page
 * never toggles — so the aggregation must consult the governing caps, not
 * the registry state of `login-method` alone.
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
    staticJwtSigningKey('login-methods-secret'),
  )
}

const redirect = (id: string) => ({
  kind: 'redirect' as const,
  id,
  label: id,
  startUrl: `/addon/${id}/start`,
  stage: 'primary' as const,
})

function makeRegistry(disabled: ReadonlyArray<readonly [string, string]>) {
  const entries: Array<readonly [string, { getLoginMethods: () => Promise<unknown[]> }]> = [
    ['auth-example', { getLoginMethods: async () => [redirect('auth-example')] }],
    ['auth-oidc', { getLoginMethods: async () => [redirect('auth-oidc/google')] }],
    [
      'auth-webauthn',
      {
        getLoginMethods: async () => [
          {
            kind: 'passkey',
            id: 'auth-webauthn/passkey-direct-login',
            label: 'Sign in with a passkey',
            stage: 'primary',
            rpId: 'hub.example',
            origin: 'https://hub.example',
          },
        ],
      },
    ],
  ]
  return {
    getSingleton: () => null,
    getCollection: () => entries.map(([, p]) => p),
    getCollectionEntries: () => entries,
    isProviderDisabled: (capability: string, addonId: string): boolean =>
      disabled.some(([cap, id]) => cap === capability && id === addonId),
  }
}

async function list(disabled: ReadonlyArray<readonly [string, string]>): Promise<string[]> {
  const router = createAuthRouter(makeAuth(), makeRegistry(disabled) as never)
  const caller = router.createCaller({ user: null } as never)
  const methods = await caller.listLoginMethods()
  return methods.map((m) => m.id)
}

describe('auth.listLoginMethods — one enable per auth addon (D777)', () => {
  it('offers every method when every provider is enabled', async () => {
    expect(await list([])).toEqual([
      'auth-example',
      'auth-oidc/google',
      'auth-webauthn/passkey-direct-login',
    ])
  })

  it('drops the methods of an addon disabled at auth-provider', async () => {
    expect(await list([['auth-provider', 'auth-example']])).toEqual([
      'auth-oidc/google',
      'auth-webauthn/passkey-direct-login',
    ])
  })

  it('drops the passkey methods when the addon is disabled at user-passkeys', async () => {
    expect(await list([['user-passkeys', 'auth-webauthn']])).toEqual([
      'auth-example',
      'auth-oidc/google',
    ])
  })
})

describe('auth.listLoginMethods — how a native app starts each method (D858)', () => {
  const passkey = (id: string, stage: 'primary' | 'second-factor') => ({
    kind: 'passkey' as const,
    id,
    label: id,
    stage,
    rpId: 'hub.example',
    origin: 'https://hub.example',
  })

  async function listFull(
    contributions: Record<string, unknown[]>,
  ): Promise<Array<Record<string, unknown>>> {
    const entries = Object.entries(contributions).map(
      ([addonId, methods]) =>
        [addonId, { getLoginMethods: async () => methods }] as [
          string,
          { getLoginMethods: () => Promise<unknown[]> },
        ],
    )
    const registry = {
      getSingleton: () => null,
      getCollection: () => entries.map(([, p]) => p),
      getCollectionEntries: () => entries,
      isProviderDisabled: () => false,
    }
    const router = createAuthRouter(makeAuth(), registry as never)
    const caller = router.createCaller({ user: null } as never)
    return (await caller.listLoginMethods()) as unknown as Array<Record<string, unknown>>
  }

  it('an OIDC redirect arm carries the addon-declared browser start path', async () => {
    const [arm] = await listFull({
      'auth-oidc': [
        {
          ...redirect('auth-oidc/google'),
          app: { kind: 'browser', startPath: '/addon/auth-oidc/google/start' },
        },
      ],
    })
    expect(arm?.app).toEqual({ kind: 'browser', startPath: '/addon/auth-oidc/google/start' })
  })

  it('a redirect arm that declares no app path is reported null, never omitted', async () => {
    const [arm] = await listFull({ 'auth-example': [redirect('auth-example')] })
    expect(arm).toHaveProperty('app', null)
  })

  it('the primary passkey arm starts at the hub passkey page; a second-factor passkey has no app path', async () => {
    const arms = await listFull({
      'auth-webauthn': [
        passkey('auth-webauthn/passkey-login', 'second-factor'),
        passkey('auth-webauthn/passkey-direct-login', 'primary'),
      ],
    })
    expect(arms.find((a) => a.id === 'auth-webauthn/passkey-login')?.app).toBeNull()
    expect(arms.find((a) => a.id === 'auth-webauthn/passkey-direct-login')?.app).toEqual({
      kind: 'browser',
      startPath: '/auth/app/passkey',
    })
  })

  it('a widget arm has no app path', async () => {
    const [arm] = await listFull({
      'auth-x': [
        {
          kind: 'widget',
          id: 'auth-x/w',
          addonId: 'auth-x',
          bundle: 'remoteEntry.js',
          remote: { remoteName: 'r', exposedModule: './w' },
          stage: 'primary',
        },
      ],
    })
    expect(arm).toHaveProperty('app', null)
  })
})
