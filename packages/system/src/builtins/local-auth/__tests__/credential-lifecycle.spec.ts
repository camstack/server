/* eslint-disable @typescript-eslint/no-unsafe-assignment -- the AddonContext stub crosses typed boundaries */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonContext, IUserManagementProvider } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getUserManagementInternal,
  type UserManagementInternal,
} from '../../../auth/user-management-internal.js'
import { LocalAuthAddon } from '../local-auth.addon.js'
import { fakeSecrets } from '../../../auth/__tests__/fake-secrets.js'
import { makeStore } from './memory-settings-store.js'
import {
  withLocalAuthRecords,
  type LocalAuthRecordsFixture,
} from './support/local-auth-records-context.js'
import { localAuthPreferencesRecordKinds } from '../preferences-record-kinds.js'

/**
 * What ends a user's access, and when (security plan §5.1): a deleted user's
 * sessions and 2FA row go in the SAME call — they used to
 * survive until the next hub restart — and a password change ends the user's
 * other sessions.
 */

const MONTH = 30 * 86_400_000

describe('local-auth — credential lifecycle', () => {
  let dataDir: string
  let um: IUserManagementProvider
  let internal: UserManagementInternal
  let addon: LocalAuthAddon
  let providersList: ReadonlyArray<{ capability: { name: string }; provider: unknown }> = []
  let store: ReturnType<typeof makeStore>
  let recordsFixture: LocalAuthRecordsFixture

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-auth-life-'))
    store = makeStore()
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
      api: { settingsStore: store },
      secrets: { ...fakeSecrets(), forOwner: () => fakeSecrets() },
    } as unknown as AddonContext
    addon = new LocalAuthAddon()
    recordsFixture = await withLocalAuthRecords(ctx)
    const result = await addon.initialize(recordsFixture.ctx)
    const providers = Array.isArray(result) ? result : (result?.providers ?? [])
    providersList = providers
    um = providers.find((p) => p.capability.name === 'user-management')
      ?.provider as IUserManagementProvider
    const found = getUserManagementInternal(um)
    if (found === null) throw new Error('no hub-internal surface')
    internal = found
  })

  afterEach(async () => {
    await addon.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  async function aliceWithSessions() {
    const alice = await um.createUser({
      username: 'alice',
      password: 'alice-pass-1',
      isAdmin: false,
    })
    const a = await internal.sessions.create({
      userId: alice.id,
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'password',
    })
    const b = await internal.sessions.create({
      userId: alice.id,
      lifetimeMs: MONTH,
      refreshable: false,
      method: 'passkey',
    })
    return { alice, a: a.session.id, b: b.session.id }
  }

  it('SECURITY: deleting a user revokes its sessions and its 2FA immediately', async () => {
    const { alice, a, b } = await aliceWithSessions()
    await um.setupTotp({ userId: alice.id })

    await um.deleteUser({ id: alice.id })

    expect(internal.sessions.check(a).state).toBe('revoked')
    expect(internal.sessions.check(b).state).toBe('revoked')
    expect(internal.sessions.legacyCutoff(alice.id)).toBeGreaterThan(0)
    expect((await um.getTotpStatus({ userId: alice.id })).enabled).toBe(false)
  })

  it("PRIVACY: deleting a user wipes its account preferences, and nobody else's (D894)", async () => {
    const alice = await um.createUser({
      username: 'alice',
      password: 'alice-pass-1',
      isAdmin: false,
    })
    const carol = await um.createUser({
      username: 'carol',
      password: 'carol-pass-1',
      isAdmin: false,
    })
    const prefs = internal.preferences
    if (prefs === undefined) throw new Error('local-auth exposes no preferences store')
    await prefs.put(alice.id, { namespace: 'viewer.app', value: { theme: 'dark' } })
    await prefs.put(alice.id, { namespace: 'viewer.grids', value: { grids: [] } })
    await prefs.put(carol.id, { namespace: 'viewer.app', value: { theme: 'light' } })

    await um.deleteUser({ id: alice.id })

    // Read the kind itself, not the store's mirror: the ROWS must be gone.
    const kind = recordsFixture.records.kind(localAuthPreferencesRecordKinds['user-preferences'])
    const left = await kind.query({ order: 'id', limit: 100 })
    expect(left.records.map((r) => r.data.userId)).toEqual([carol.id])
    expect(await prefs.get(alice.id)).toEqual([])
  })

  it("an admin's password reset ends every session of that user", async () => {
    const { alice, a, b } = await aliceWithSessions()
    await um.resetPassword({ id: alice.id, newPassword: 'brand-new-pass' })
    expect(internal.sessions.check(a).state).toBe('revoked')
    expect(internal.sessions.check(b).state).toBe('revoked')
  })

  it('a self-service password change keeps the current session and ends the others', async () => {
    const { alice, a, b } = await aliceWithSessions()
    await internal.setPassword({
      userId: alice.id,
      newPassword: 'brand-new-pass',
      keepSessionId: a,
    })
    expect(internal.sessions.check(a).state).toBe('active')
    expect(internal.sessions.check(b).state).toBe('revoked')
    expect(
      await um.validateCredentials({ username: 'alice', password: 'brand-new-pass' }),
    ).not.toBeNull()
  })

  it('sessions survive an addon restart over the same store', async () => {
    const { a } = await aliceWithSessions()
    expect(internal.sessions.check(a).state).toBe('active')
  })

  it('SECURITY: an admin password reset revokes EVERY device credential of the user and the sessions they opened', async () => {
    const alice = await um.createUser({
      username: 'alice',
      password: 'alice-pass-1',
      isAdmin: false,
    })
    const credentials = providersList.find((p) => p.capability.name === 'device-credentials')
      ?.provider as import('@camstack/types').IDeviceCredentialsProvider
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString(
      'base64url',
    )
    const caller = { userId: 'admin-1', isAdmin: true }
    const { code } = await credentials.startEnrollment({
      userId: alice.id,
      deviceName: 'iPhone',
      caller,
    })
    const enrolled = await internal.deviceCredentials.completeEnrollment({
      code,
      publicKeySpki: spki,
      platform: 'ios',
    })
    if (!enrolled.ok) throw new Error(enrolled.reason)
    const opened = await internal.sessions.create({
      userId: alice.id,
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'device-certificate',
      credentialId: enrolled.credentialId,
    })
    expect(internal.deviceCredentials.check(enrolled.credentialId)).toBe('active')

    await um.resetPassword({ id: alice.id, newPassword: 'brand-new-pass-1' })

    expect(internal.deviceCredentials.check(enrolled.credentialId)).toBe('revoked')
    expect(internal.deviceCredentials.get(enrolled.credentialId)?.revokedBy).toBe('password-reset')
    expect(internal.sessions.check(opened.session.id).state).toBe('revoked')
  })

  it("SECURITY: the user's OWN password change also revokes every device credential, ends the other sessions, and keeps only the session that changed it", async () => {
    const alice = await um.createUser({
      username: 'alice',
      password: 'alice-pass-1',
      isAdmin: false,
    })
    const credentials = providersList.find((p) => p.capability.name === 'device-credentials')
      ?.provider as import('@camstack/types').IDeviceCredentialsProvider
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString(
      'base64url',
    )
    const { code } = await credentials.startEnrollment({
      userId: alice.id,
      deviceName: 'iPhone',
      caller: { userId: 'admin-1', isAdmin: true },
    })
    const enrolled = await internal.deviceCredentials.completeEnrollment({
      code,
      publicKeySpki: spki,
      platform: 'ios',
    })
    if (!enrolled.ok) throw new Error(enrolled.reason)
    const mk = (method: 'password' | 'device-certificate', credentialId?: string) =>
      internal.sessions.create({
        userId: alice.id,
        lifetimeMs: MONTH,
        refreshable: true,
        method,
        ...(credentialId !== undefined ? { credentialId } : {}),
      })
    const current = await mk('password')
    const other = await mk('password')
    const viaDevice = await mk('device-certificate', enrolled.credentialId)

    await internal.setPassword({
      userId: alice.id,
      newPassword: 'another-pass-123',
      keepSessionId: current.session.id,
    })

    expect(internal.deviceCredentials.get(enrolled.credentialId)?.revokedBy).toBe(
      'password-changed',
    )
    expect(internal.sessions.check(current.session.id).state).toBe('active')
    expect(internal.sessions.check(other.session.id).state).toBe('revoked')
    expect(internal.sessions.check(viaDevice.session.id).state).toBe('revoked')
  })
})
