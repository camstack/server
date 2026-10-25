/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- the AddonContext stub crosses typed boundaries */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonContext, IUserManagementProvider } from '@camstack/types'
import { userManagementCapability } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getUserManagementInternal,
  type UserManagementInternal,
} from '../../../auth/user-management-internal.js'
import { LocalAuthAddon } from '../local-auth.addon.js'
import { makeStore } from './memory-settings-store.js'
import { withLocalAuthRecords } from './support/local-auth-records-context.js'

/**
 * D782 through the real `user-management` provider: links are stored per
 * user, one identity maps to one user, a link to a user that does not exist
 * is refused, and DELETING A USER DELETES ITS LINKS.
 */

describe('local-auth — external sign-in identities (D782)', () => {
  let dataDir: string
  let um: IUserManagementProvider
  let internal: UserManagementInternal
  let addon: LocalAuthAddon

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-auth-ext-'))
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
      withTags: vi.fn().mockReturnThis(),
    }
    const ctx = {
      id: 'local-auth',
      logger,
      nodeDataDir: dataDir,
      kernel: { localNodeId: 'hub' },
      eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
      settings: {
        getSection: vi.fn(async () => ({})),
        setSection: vi.fn(async () => undefined),
        readAddonStore: vi.fn(async () => ({})),
        writeAddonStore: vi.fn(async () => undefined),
      },
      api: { settingsStore: makeStore() },
    } as unknown as AddonContext
    addon = new LocalAuthAddon()
    const { ctx: withRecords } = await withLocalAuthRecords(ctx)
    const result = await addon.initialize(withRecords)
    const providers = Array.isArray(result) ? result : (result?.providers ?? [])
    um = providers.find((p) => p.capability.name === 'user-management')
      ?.provider as IUserManagementProvider
    const found = getUserManagementInternal(um)
    if (found === null) throw new Error('local-auth attached no hub-internal surface')
    internal = found
  })

  afterEach(async () => {
    await addon.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('links, finds and lists an identity for an existing user', async () => {
    const alice = await um.createUser({
      username: 'alice',
      password: 'alice-pass-1',
      isAdmin: false,
    })
    await internal.linkExternalIdentity({
      userId: alice.id,
      provider: 'auth-oidc/authentik',
      subject: 'sub-1',
      issuer: 'https://idp.example/',
      label: 'alice@example.com',
    })
    expect(
      await um.findUserByExternalIdentity({ provider: 'auth-oidc/authentik', subject: 'sub-1' }),
    ).toEqual({ userId: alice.id, issuer: 'https://idp.example/' })
    const links = await um.listExternalIdentities({ userId: alice.id })
    expect(links).toMatchObject([{ provider: 'auth-oidc/authentik', label: 'alice@example.com' }])
  })

  it('refuses a link to a user that does not exist', async () => {
    await expect(
      internal.linkExternalIdentity({
        userId: 'u-ghost',
        provider: 'auth-oidc/a',
        subject: 's',
        issuer: 'https://idp.example/',
      }),
    ).rejects.toThrow(/User not found/)
  })

  it('deleting a user deletes its links', async () => {
    const alice = await um.createUser({
      username: 'alice',
      password: 'alice-pass-1',
      isAdmin: false,
    })
    await internal.linkExternalIdentity({
      userId: alice.id,
      provider: 'auth-oidc/a',
      subject: 's1',
      issuer: 'https://idp.example/',
    })
    await internal.linkExternalIdentity({
      userId: alice.id,
      provider: 'auth-oidc/b',
      subject: 's2',
      issuer: 'https://idp.example/',
    })
    await um.deleteUser({ id: alice.id })
    expect(
      await um.findUserByExternalIdentity({ provider: 'auth-oidc/a', subject: 's1' }),
    ).toBeNull()
    expect(await um.listExternalIdentities({ userId: alice.id })).toEqual([])
  })

  it('creating a link is on no wire: not a cap method, not an own enumerable key', () => {
    expect(Object.keys(userManagementCapability.methods)).not.toContain('linkExternalIdentity')
    expect(Object.keys(um)).not.toContain('linkExternalIdentity')
    // A serialized copy (what any remote proxy is) carries no internal surface.
    expect(getUserManagementInternal(JSON.parse(JSON.stringify({ ...um })))).toBeNull()
  })
})
