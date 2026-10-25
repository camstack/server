/**
 * A real login-session table behind a fake `user-management` provider, for
 * the hub's session specs: the same `LoginSessionManager` local-auth runs,
 * over an in-memory store, reached through the same hub-internal symbol.
 */
import {
  attachUserManagementInternal,
  AuthAuditLog,
  DeviceCaStore,
  DeviceCredentialManager,
  LoginSessionManager,
  staticJwtSigningKey,
  type UserManagementInternal,
} from '@camstack/system'
import type { SettingsStoreClient, TokenScope } from '@camstack/types'
import { fakeSecrets } from './device-test-kit.js'
import { AuthService } from '../../core/auth/auth.service.js'
import { createSessionTokenCheck, sessionBackingFrom } from '../hub-sessions.js'
import { readSessionLifetimes } from '../session-lifetimes.js'

interface Row {
  id: string
  data: Record<string, unknown>
}

function memoryStore(): SettingsStoreClient {
  const collections = new Map<string, Map<string, Row>>()
  const coll = (name: string) => {
    let c = collections.get(name)
    if (c === undefined) {
      c = new Map()
      collections.set(name, c)
    }
    return c
  }
  const matches = (row: Row, where: Record<string, unknown> | undefined) =>
    Object.entries(where ?? {}).every(([k, v]) => row.data[k] === v)
  const store = {
    declareCollection: { mutate: async () => undefined },
    insert: {
      mutate: async (a: { collection: string; record: Row }) => {
        coll(a.collection).set(a.record.id, { id: a.record.id, data: { ...a.record.data } })
        return { id: a.record.id }
      },
    },
    update: {
      mutate: async (a: { collection: string; id: string; data: Record<string, unknown> }) => {
        coll(a.collection).set(a.id, { id: a.id, data: { ...a.data } })
      },
    },
    delete: {
      mutate: async (a: { collection: string; key: string }) => {
        coll(a.collection).delete(a.key)
      },
    },
    query: {
      query: async (a: { collection: string; filter?: { where?: Record<string, unknown> } }) =>
        [...coll(a.collection).values()].filter((row) => matches(row, a.filter?.where)),
    },
  }
  return store as unknown as SettingsStoreClient
}

export interface HarnessUser {
  readonly id: string
  readonly username: string
  isAdmin: boolean
  readonly allowedProviders?: '*'
  readonly allowedDevices?: Record<string, never>
  readonly scopes?: readonly TokenScope[]
  password: string
}

export function sessionHarness(users: HarnessUser[], settings: Record<string, unknown> = {}) {
  const store = memoryStore()
  const sessions = new LoginSessionManager(store)
  const auditLog = new AuthAuditLog(store)
  // A lightweight stub for the account links the bulk revoker can end.
  const oauthById = new Map<string, { revokedAt: number | null }>()
  const deviceSettings = new Map<string, Record<string, unknown>>()
  const deviceState = { selfEnrollment: true }
  const devices = new DeviceCredentialManager(store, {
    ca: new DeviceCaStore({
      secrets: fakeSecrets(),
      readSection: async (section) => deviceSettings.get(section) ?? {},
      writeSection: async (section, patch) => {
        deviceSettings.set(section, { ...deviceSettings.get(section), ...patch })
      },
    }),
    findUser: async (id) => {
      const user = users.find((u) => u.id === id)
      return user === undefined ? null : { username: user.username }
    },
    selfEnrollmentAllowed: async () => deviceState.selfEnrollment,
  })
  const internal: UserManagementInternal = {
    deviceCredentials: devices,
    linkExternalIdentity: async () => ({ success: true }),
    sessions,
    oauthSessions: {
      revoke: async (id) => {
        const row = oauthById.get(id)
        if (row === undefined) return false
        if (row.revokedAt !== null) {
          oauthById.delete(id)
          return true
        }
        oauthById.set(id, { revokedAt: Date.now() })
        return true
      },
    },
    audit: {
      record: (event) => auditLog.record(event),
      list: (input) => auditLog.list(input),
    },
    setPassword: async (input) => {
      const user = users.find((u) => u.id === input.userId)
      if (user === undefined) throw new Error('no such user')
      user.password = input.newPassword
      await sessions.revokeAllForUser(input.userId, {
        ...(input.keepSessionId !== undefined ? { exceptSessionId: input.keepSessionId } : {}),
        reason: 'password-changed',
      })
    },
  }
  const userManagement = attachUserManagementInternal(
    {
      listUsers: async () => users,
      validateCredentials: async (input: { username: string; password: string }) => {
        const user = users.find((u) => u.username === input.username)
        return user !== undefined && user.password === input.password
          ? { ...user, totpEnabled: false }
          : null
      },
      getTotpStatus: async () => ({ enabled: false, confirmedAt: null }),
      resetPassword: async () => ({ success: true }),
    },
    internal,
  )
  const registry = {
    getSingleton: (name: string) => (name === 'user-management' ? userManagement : null),
    getCollection: () => [],
    getCollectionEntries: () => [],
    isProviderDisabled: () => false,
  }
  const auth = new AuthService(
    { get: () => undefined, update: () => undefined } as never,
    undefined,
    staticJwtSigningKey('session-harness-secret'),
  )
  auth.setSessionCheck(createSessionTokenCheck(registry))
  const backing = sessionBackingFrom(registry, () => readSessionLifetimes((key) => settings[key]))
  // The device mirror the tRPC context reads for device selectors: a flat
  // fleet (no parents, no types, no locations).
  const addonRegistry = {
    getCapabilityRegistry: () => registry,
    getPersistedAncestors: (): readonly number[] => [],
    getPersistedType: (): string | null => null,
    getPersistedLocation: (): string | null => null,
  }
  return {
    auth,
    registry,
    sessions,
    backing,
    userManagement,
    devices,
    deviceState,
    auditLog,
    addonRegistry,
    /** Test-only: plant an OAuth session (`revokedAt` null = active). */
    plantOauthSession: (id: string, revokedAt: number | null = null) => {
      oauthById.set(id, { revokedAt })
    },
    oauthSession: (id: string) => oauthById.get(id),
  }
}
