/**
 * An OAuth link names the integration INSTANCE it was made for (planning#415).
 *
 * The signer here is the real `AuthManager`: it writes and reads claims field
 * by field, so a fake that echoes its input would supply the claim production
 * forgot to carry.
 */
import type { TokenScope } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AuthManager } from '../../../auth/auth-manager.js'
import { staticJwtSigningKey } from '../../../auth/jwt-signing-key.js'
import { createOauthGrants } from '../oauth-grants.js'
import type { OauthSession } from '../oauth-session-manager.js'

function realSigner() {
  const auth = new AuthManager({ get: () => undefined }, undefined, staticJwtSigningKey('secret'))
  return {
    signBridgeToken: async (input: {
      claims: Parameters<AuthManager['signSsoBridgeToken']>[0]
      ttlSec?: number | 'never'
    }) => ({ token: auth.signSsoBridgeToken(input.claims, input.ttlSec) }),
    verifyBridgeToken: async ({ token }: { token: string }) => auth.verifySsoBridgeToken(token),
  }
}

interface CreateSessionInput {
  userId: string
  username: string
  integrationId: string
  instanceId?: string | null
  scopes: TokenScope[]
}

function sessions() {
  const store = new Map<string, OauthSession>()
  let seq = 0
  return {
    store,
    async create(input: CreateSessionInput): Promise<OauthSession> {
      const session: OauthSession = {
        id: `session-${++seq}`,
        userId: input.userId,
        username: input.username,
        integrationId: input.integrationId,
        instanceId: input.instanceId ?? null,
        scopes: input.scopes,
        createdAt: 1,
        lastUsedAt: 1,
        revokedAt: null,
      }
      store.set(session.id, session)
      return session
    },
    async getById(id: string): Promise<OauthSession | null> {
      return store.get(id) ?? null
    },
    async touch(): Promise<void> {},
  }
}

const scopes: TokenScope[] = [{ type: 'category', target: 'device', access: ['view'] }]
const REDIRECT = 'https://cb.example/r'

function claimOf(token: string, name: string): unknown {
  const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
  return typeof payload === 'object' && payload !== null ? Reflect.get(payload, name) : undefined
}

async function link(instanceId: string | undefined) {
  const store = sessions()
  const grants = createOauthGrants(realSigner(), store)
  const { code } = await grants.oauthIssueCode({
    integrationId: 'voice',
    userId: 'u1',
    username: 'ann',
    scopes,
    redirectUri: REDIRECT,
    hubUrl: 'https://hub.example',
    ...(instanceId !== undefined ? { instanceId } : {}),
  })
  const pair = await grants.oauthExchangeCode({ code, redirectUri: REDIRECT })
  if (pair === null) throw new Error('exchange refused')
  return { grants, store, pair }
}

describe('an OAuth link made for an instance', () => {
  it('stores the instance on the session and returns it from verify', async () => {
    const { grants, store, pair } = await link('second')
    expect([...store.store.values()][0]?.instanceId).toBe('second')
    const verified = await grants.oauthVerifyAccessToken({ token: pair.accessToken })
    expect(verified?.instanceId).toBe('second')
  })

  it('carries the instance as a claim of the access token, for a relay that routes on it', async () => {
    const { pair } = await link('second')
    expect(claimOf(pair.accessToken, 'instanceId')).toBe('second')
  })

  it('keeps the instance across a refresh', async () => {
    const { grants, pair } = await link('second')
    const next = await grants.oauthRefresh({ refreshToken: pair.refreshToken })
    expect(next).not.toBeNull()
    expect(claimOf(next!.accessToken, 'instanceId')).toBe('second')
    const verified = await grants.oauthVerifyAccessToken({ token: next!.accessToken })
    expect(verified?.instanceId).toBe('second')
  })

  it('answers from the SESSION, not from the claim of a token', async () => {
    const { grants, store, pair } = await link('second')
    const [session] = [...store.store.values()]
    store.store.set(session!.id, { ...session!, instanceId: 'third' })
    const verified = await grants.oauthVerifyAccessToken({ token: pair.accessToken })
    expect(verified?.instanceId).toBe('third')
  })
})

describe('an OAuth link made for no instance (the default one)', () => {
  it('names no instance anywhere: session, claim, verify', async () => {
    const { grants, store, pair } = await link(undefined)
    expect([...store.store.values()][0]?.instanceId).toBeNull()
    expect(claimOf(pair.accessToken, 'instanceId')).toBeUndefined()
    const verified = await grants.oauthVerifyAccessToken({ token: pair.accessToken })
    expect(verified).not.toBeNull()
    expect(verified !== null && 'instanceId' in verified).toBe(false)
  })
})
