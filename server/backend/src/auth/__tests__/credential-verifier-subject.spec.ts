/* eslint-disable @typescript-eslint/consistent-type-assertions -- test doubles cross typed service boundaries */
/**
 * A credential never outlives — or outgrows — the person it acts for
 * (security review 2026-10-21):
 *
 *   - a non-admin's minted token is cut down to what its subject holds NOW,
 *     at every verify: an admin who narrows a user narrows the user's tokens
 *     (MEDIUM — the row's scopes used to apply whole);
 *   - an account link authenticates nobody once its subject is gone, or when
 *     it names nobody (CRITICAL follow-up — it used to skip the subject);
 *   - the user list behind those checks is read at most once per window, not
 *     once per request (LOW).
 *
 * Driven through the REAL `createTrpcContext`, the REAL AuthService signing
 * key and the REAL `CredentialTokenService`, so the tokens are the hub's own.
 *
 * Disarm checks:
 *   - drop `narrowedToSubject` (use `row.scopes`) → the narrowed rows keep
 *     `delete`, the emptied row authenticates;
 *   - drop the subject check in the integration branch → the deleted and the
 *     nameless account links authenticate;
 *   - drop the users memo → `listUsers` is read once per verify.
 */
import { attachUserManagementInternal, staticJwtSigningKey } from '@camstack/system'
import type { UserManagementInternal } from '@camstack/system'
import { makeInMemoryRecords, type TokenScope } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bindHubCredentialStores,
  createTrpcContext,
  type TrpcRequest,
} from '../../api/trpc/trpc.context.js'
import type { AddonRegistryService } from '../../core/addon/addon-registry.service.js'
import { AuthService } from '../../core/auth/auth.service.js'
import { CredentialTokenService } from '../../core/auth/credential-token.service.js'
import { coreAuthRecordKinds } from '../../core/auth/record-kinds.js'

const VIEW_USERS: TokenScope = { type: 'capability', target: 'user-management', access: ['view'] }
const MANAGE_USERS: TokenScope = {
  type: 'capability',
  target: 'user-management',
  access: ['view', 'delete'],
}
const DAY_MS = 86_400_000

interface DirectoryUser {
  readonly id: string
  isAdmin: boolean
  scopes: TokenScope[]
}

async function setup(users: DirectoryUser[]) {
  const auth = new AuthService(
    { get: () => undefined, update: () => undefined } as never,
    undefined,
    staticJwtSigningKey('verifier-subject-spec-secret'),
  )
  const world = makeInMemoryRecords('core-auth')
  await world.records.declare(coreAuthRecordKinds)
  const kind = world.records.kind(coreAuthRecordKinds['credential-tokens'])
  const tokens = new CredentialTokenService(auth)
  tokens.bindKind(() => kind)
  let reads = 0
  const internal = { audit: { record: async () => {} } } as unknown as UserManagementInternal
  const userManagement = attachUserManagementInternal(
    {
      listUsers: async () => {
        reads += 1
        return users
      },
    },
    internal,
  )
  const registry = {
    getPersistedAncestors: () => [],
    getPersistedType: () => null,
    getPersistedLocation: () => null,
    getPersistedDeviceList: () => [],
    getCapabilityRegistry: () => ({
      getSingleton: (name: string) => (name === 'user-management' ? userManagement : undefined),
    }),
  } as unknown as AddonRegistryService
  bindHubCredentialStores({ tokenRows: tokens })
  const principalFor = async (bearer: string) => {
    const req = { headers: { authorization: `Bearer ${bearer}` } } as unknown as TrpcRequest
    return (await createTrpcContext(req, auth, registry)).user
  }
  return { auth, tokens, principalFor, reads: () => reads }
}

afterEach(() => bindHubCredentialStores({ tokenRows: null }))

describe('a minted token never outgrows its non-admin subject', () => {
  it('SECURITY: narrowing the user narrows the token at the next verify', async () => {
    const carol: DirectoryUser = { id: 'u-carol', isAdmin: false, scopes: [VIEW_USERS] }
    const h = await setup([carol])
    const { token } = await h.tokens.mint({
      subjectId: 'u-carol',
      createdBy: 'u-carol',
      label: 'ci',
      // What carol held when she minted it, before an admin narrowed her.
      scopes: [MANAGE_USERS],
      expiresAt: Date.now() + DAY_MS,
    })
    expect((await h.principalFor(token))?.scopes).toEqual([VIEW_USERS])
  })

  it('SECURITY: a user narrowed to nothing the token names has a token that authenticates nobody', async () => {
    const dave: DirectoryUser = { id: 'u-dave', isAdmin: false, scopes: [] }
    const h = await setup([dave])
    const { token } = await h.tokens.mint({
      subjectId: 'u-dave',
      createdBy: 'u-dave',
      label: 'ci',
      scopes: [MANAGE_USERS],
      expiresAt: Date.now() + DAY_MS,
    })
    expect(await h.principalFor(token)).toBeNull()
  })

  it('a share link keeps only the cameras its non-admin subject can still view', async () => {
    const erin: DirectoryUser = {
      id: 'u-erin',
      isAdmin: false,
      scopes: [{ type: 'device', selector: { kind: 'ids', ids: [5] }, access: ['view'] }],
    }
    const h = await setup([erin])
    const { token } = await h.tokens.mint({
      subjectId: 'u-erin',
      createdBy: 'u-erin',
      label: 'wall',
      scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [5, 7] } }],
      expiresAt: null,
    })
    expect((await h.principalFor(token))?.scopes).toEqual([
      { type: 'share-view', grant: { kind: 'grid-view', deviceIds: [5] } },
    ])
  })

  it('SECURITY: a token whose subject was deleted authenticates nobody (no cascade needed)', async () => {
    const users: DirectoryUser[] = [{ id: 'u-gina', isAdmin: true, scopes: [] }]
    const h = await setup(users)
    const { token } = await h.tokens.mint({
      subjectId: 'u-gina',
      createdBy: 'u-gina',
      label: 'ops',
      scopes: ['*'],
      expiresAt: Date.now() + DAY_MS,
    })
    users.splice(0, 1)
    expect(await h.principalFor(token)).toBeNull()
  })

  it('an admin subject’s token is never narrowed', async () => {
    const root: DirectoryUser = { id: 'u-root2', isAdmin: true, scopes: [] }
    const h = await setup([root])
    const { token } = await h.tokens.mint({
      subjectId: 'u-root2',
      createdBy: 'u-root2',
      label: 'ci',
      scopes: [MANAGE_USERS],
      expiresAt: Date.now() + DAY_MS,
    })
    expect((await h.principalFor(token))?.scopes).toEqual([MANAGE_USERS])
  })
})

describe('an account link authenticates only for a user that exists', () => {
  const link = (auth: AuthService, userId: string) =>
    auth.signSsoBridgeToken({
      provider: 'oauth-access',
      userId,
      username: userId,
      isAdmin: false,
      scopes: [VIEW_USERS],
      sessionId: `oa-${userId}`,
    })

  it('control: a live user’s link authenticates with its grant', async () => {
    const h = await setup([{ id: 'u-frank', isAdmin: false, scopes: [] }])
    expect(await h.principalFor(link(h.auth, 'u-frank'))).toMatchObject({
      id: 'u-frank',
      scopes: [VIEW_USERS],
    })
  })

  it('SECURITY: a link whose user was deleted authenticates nobody', async () => {
    const h = await setup([{ id: 'u-frank', isAdmin: false, scopes: [] }])
    expect(await h.principalFor(link(h.auth, 'u-gone'))).toBeNull()
  })

  it('SECURITY: a link that names nobody (empty userId) authenticates nobody', async () => {
    const h = await setup([{ id: '', isAdmin: false, scopes: [] }])
    expect(await h.principalFor(link(h.auth, ''))).toBeNull()
  })
})

describe('the subject checks read the user list once per window', () => {
  it('ten token verifies cost one user-list read', async () => {
    const h = await setup([{ id: 'u-root3', isAdmin: true, scopes: [] }])
    const { token } = await h.tokens.mint({
      subjectId: 'u-root3',
      createdBy: 'u-root3',
      label: 'ops',
      scopes: ['*'],
      expiresAt: Date.now() + DAY_MS,
    })
    for (let i = 0; i < 10; i += 1) expect(await h.principalFor(token)).not.toBeNull()
    expect(h.reads()).toBe(1)
  })
})
