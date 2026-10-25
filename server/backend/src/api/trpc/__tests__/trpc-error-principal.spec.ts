/**
 * A tRPC error line has to say WHO was refused.
 *
 * The incident this exists for (2026-08-09): a linked Home Assistant was
 * refused on its first authenticated call. The hub logged the refusal with the
 * missing grant spelled out — and the operator, grepping `docker logs` for
 * `oauth` and `token`, concluded the hub had logged nothing at all. It had. The
 * line simply carried no principal, so nothing tied `deviceExport.listExposedDevices`
 * to the account-linked integration that made the call, in a stream running
 * ~2700 lines every four minutes.
 *
 * Two pure functions cover it: one lifts the credential's identity off the
 * verified claims, the other renders it for the log.
 */
import { describe, expect, it } from 'vitest'
import type { AuthenticatedAgent } from '../trpc.context.js'
import { describeTrpcPrincipal, readCredentialIdentity } from '../trpc-error-principal.js'

function user(overrides: Partial<AuthenticatedAgent> = {}): AuthenticatedAgent {
  return {
    id: 'user-1',
    username: 'apocaliss92',
    isAdmin: false,
    permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
    isApiKey: false,
    ...overrides,
  }
}

describe('readCredentialIdentity', () => {
  it('lifts the provider and session off an OAuth access token', () => {
    // The exact claim set `mintPair` signs for an `oauth-access` token.
    const identity = readCredentialIdentity({
      kind: 'sso-bridge',
      userId: 'user-1',
      username: 'apocaliss92',
      isAdmin: false,
      provider: 'oauth-access',
      sessionId: '910a6179-0000-0000-0000-000000000000',
      hubUrl: 'https://hub.example',
    })

    expect(identity).toEqual({
      credential: 'oauth-access',
      sessionId: '910a6179-0000-0000-0000-000000000000',
    })
  })

  it('reads nothing off an ordinary login token', () => {
    expect(
      readCredentialIdentity({ userId: 'user-1', username: 'apocaliss92', isAdmin: true }),
    ).toEqual({})
  })

  it('ignores a `provider` claim that is not on a bridge token', () => {
    // Defence against a future token type reusing the field name for something
    // else. Only `kind: 'sso-bridge'` means what this reader thinks it means.
    expect(readCredentialIdentity({ provider: 'reolink', isAdmin: true })).toEqual({})
  })
})

describe('describeTrpcPrincipal', () => {
  it('names the account link behind a refusal', () => {
    const described = describeTrpcPrincipal(
      user({ credential: 'oauth-access', oauthSessionId: '910a6179-aaaa' }),
    )
    // `oauth` is the word an operator greps for when an integration breaks.
    expect(described).toContain('oauth-access')
    expect(described).toContain('apocaliss92')
    expect(described).toContain('910a6179-aaaa')
  })

  it('says anonymous rather than nothing when there is no principal', () => {
    // An UNAUTHORIZED with a blank principal field reads like a logging bug.
    expect(describeTrpcPrincipal(null)).toBe('anonymous')
  })

  it('marks an admin session, which is never scope-gated', () => {
    expect(describeTrpcPrincipal(user({ isAdmin: true }))).toContain('admin')
  })

  it('marks a share link (a token) by its audit tag and label', () => {
    expect(
      describeTrpcPrincipal(
        user({
          username: 'token:share grid-view',
          auditTag: 'token',
          scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [101] } }],
        }),
      ),
    ).toBe('token:share grid-view (token)')
  })
})
