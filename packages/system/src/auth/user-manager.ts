import { userError } from '@camstack/types'
import * as crypto from 'node:crypto'
import type { RecordKindHandle, SettingsStoreClient, UserRecord, UserScope } from '@camstack/types'
import { UserRecordSchema } from '@camstack/types'
import type { AuthManager } from './auth-manager.js'
import { parseRecord } from './parse-record.js'
import { readAllRows } from '../records/read-all-rows.js'
import type { UserBody } from '../builtins/local-auth/record-kinds.js'
import { localAuthRecordKinds } from '../builtins/local-auth/record-kinds.js'

export type { UserRecord }

interface CreateUserInput {
  username: string
  password: string
  isAdmin?: boolean
  allowedProviders?: string[] | '*'
  allowedDevices?: Record<string, string[] | '*'>
  scopes?: UserScope[]
}

type UpdatableUserFields = Partial<
  Pick<UserRecord, 'isAdmin' | 'allowedProviders' | 'allowedDevices' | 'scopes'>
>

const USERS_COLLECTION = 'users'

/**
 * The account a fresh hub seeds on its first boot (D797). Not configurable —
 * no env variable, no config.yaml key: the first sign-in with this password
 * forces a change (admin-ui `mustChangePassword`), and an existing user is
 * never overwritten (D728).
 */
export const FIRST_BOOT_ADMIN_USERNAME = 'admin'
export const FIRST_BOOT_ADMIN_PASSWORD = 'changeme'

export interface EnsureAdminOptions {
  /** The operator's explicit, one-shot recovery request. Never a default. */
  readonly resetPassword?: boolean
}

/** What `ensureAdminExists` did — every branch is named so the caller can log it. */
export type AdminSeedOutcome =
  | { readonly kind: 'seeded'; readonly username: string }
  | { readonly kind: 'exists'; readonly username: string }
  | { readonly kind: 'other-admin-exists'; readonly username: string }
  | { readonly kind: 'reset'; readonly username: string }

export interface UserStorageAccess {
  getStore(): SettingsStoreClient
}

export interface UserRecordsDeps {
  readonly usersKind: RecordKindHandle<UserBody>
  /** Optional legacy store for tests that assert no declareCollection. */
  readonly legacyStore?: SettingsStoreClient
}

function parseUser(data: Record<string, unknown>): UserRecord {
  return parseRecord('user', UserRecordSchema, data)
}

function userToBody(user: UserRecord): UserBody {
  const { id: _id, ...body } = user
  return body
}

function rowToUser(id: string, body: UserBody): UserRecord {
  return parseUser({ id, ...body })
}

export class UserManager {
  private readonly usersKind: RecordKindHandle<UserBody> | null
  private readonly legacyStore: SettingsStoreClient | null

  constructor(
    private readonly storageAccess: UserStorageAccess | UserRecordsDeps,
    private readonly auth: AuthManager,
  ) {
    if ('getStore' in storageAccess) {
      this.usersKind = null
      this.legacyStore = storageAccess.getStore()
    } else {
      this.usersKind = storageAccess.usersKind
      this.legacyStore = storageAccess.legacyStore ?? null
    }
  }

  private get store(): SettingsStoreClient {
    if ('getStore' in this.storageAccess) return this.storageAccess.getStore()
    if (this.legacyStore === null) {
      throw new Error('UserManager: legacy store unavailable on records-only path')
    }
    return this.legacyStore
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    const existing = await this.findByUsername(input.username)
    if (existing)
      throw userError(
        'system.user-exists',
        { username: String(input.username) },
        `User with username "${input.username}" already exists`,
      )

    const passwordHash = await this.auth.hashPassword(input.password)
    const now = Date.now()
    const record: UserRecord = {
      id: crypto.randomUUID(),
      username: input.username,
      passwordHash,
      isAdmin: input.isAdmin ?? false,
      allowedProviders: input.allowedProviders ?? '*',
      allowedDevices: input.allowedDevices ?? {},
      scopes: input.scopes ?? [],
      createdAt: now,
      updatedAt: now,
    }

    const kind = this.usersKind
    if (kind !== null) {
      const body = userToBody(record)
      const parsed = localAuthRecordKinds.users.schema.safeParse(body)
      if (!parsed.success) throw new Error(parsed.error.message)
      await kind.put({ id: record.id, data: parsed.data })
      return record
    }

    await this.store.insert.mutate({
      collection: USERS_COLLECTION,
      record: { id: record.id, data: { ...record } },
    })
    return record
  }

  async findByUsername(username: string): Promise<UserRecord | null> {
    const kind = this.usersKind
    if (kind !== null) {
      const page = await kind.query({ where: { username }, limit: 1 })
      const row = page.records[0]
      if (row === undefined) return null
      return rowToUser(row.id, row.data)
    }
    const results = await this.store.query.query({
      collection: USERS_COLLECTION,
      filter: { where: { username } },
    })
    if (results.length === 0) return null
    return parseUser(results[0]!.data)
  }

  async findById(id: string): Promise<UserRecord | null> {
    const kind = this.usersKind
    if (kind !== null) {
      const row = await kind.get(id)
      return row === null ? null : rowToUser(row.id, row.data)
    }
    const results = await this.store.query.query({
      collection: USERS_COLLECTION,
      filter: { where: { id } },
    })
    if (results.length === 0) return null
    return parseUser(results[0]!.data)
  }

  async validateCredentials(username: string, password: string): Promise<UserRecord | null> {
    const user = await this.findByUsername(username)
    if (!user) return null
    const valid = await this.auth.comparePassword(password, user.passwordHash)
    return valid ? user : null
  }

  async listAll(): Promise<Omit<UserRecord, 'passwordHash'>[]> {
    const kind = this.usersKind
    if (kind !== null) {
      const rows = await readAllRows(kind)
      return rows.map((row) => {
        const parsed = rowToUser(row.id, row.data)
        const { passwordHash: _ph, ...rest } = parsed
        return rest
      })
    }
    const results = await this.store.query.query({ collection: USERS_COLLECTION })
    return results.map((r) => {
      const parsed = parseUser(r.data)
      const { passwordHash: _ph, ...rest } = parsed
      return rest
    })
  }

  async update(id: string, data: UpdatableUserFields): Promise<void> {
    const existing = await this.findById(id)
    if (!existing)
      throw userError('system.user-not-found', { id: String(id) }, `User with id "${id}" not found`)
    const next: UserRecord = { ...existing, ...data, updatedAt: Date.now() }
    const kind = this.usersKind
    if (kind !== null) {
      const body = userToBody(next)
      const parsed = localAuthRecordKinds.users.schema.safeParse(body)
      if (!parsed.success) throw new Error(parsed.error.message)
      await kind.put({ id, data: parsed.data })
      return
    }
    await this.store.update.mutate({
      collection: USERS_COLLECTION,
      id,
      data: { ...next },
    })
  }

  async delete(id: string): Promise<void> {
    const kind = this.usersKind
    if (kind !== null) {
      await kind.delete(id)
      return
    }
    await this.store.delete.mutate({ collection: USERS_COLLECTION, key: id })
  }

  async resetPassword(id: string, newPassword: string): Promise<void> {
    const existing = await this.findById(id)
    if (!existing)
      throw userError('system.user-not-found', { id: String(id) }, `User with id "${id}" not found`)
    const passwordHash = await this.auth.hashPassword(newPassword)
    const next: UserRecord = { ...existing, passwordHash, updatedAt: Date.now() }
    const kind = this.usersKind
    if (kind !== null) {
      const body = userToBody(next)
      const parsed = localAuthRecordKinds.users.schema.safeParse(body)
      if (!parsed.success) throw new Error(parsed.error.message)
      await kind.put({ id, data: parsed.data })
      return
    }
    await this.store.update.mutate({
      collection: USERS_COLLECTION,
      id,
      data: { ...next },
    })
  }

  /**
   * Seed {@link FIRST_BOOT_ADMIN_USERNAME} / {@link FIRST_BOOT_ADMIN_PASSWORD}
   * — on FIRST boot only, i.e. when no admin account exists.
   */
  async ensureAdminExists(options: EnsureAdminOptions = {}): Promise<AdminSeedOutcome> {
    const username = FIRST_BOOT_ADMIN_USERNAME
    const existing = await this.findByUsername(username)
    if (existing) {
      if (options.resetPassword === true) {
        await this.resetPassword(existing.id, FIRST_BOOT_ADMIN_PASSWORD)
        return { kind: 'reset', username }
      }
      return { kind: 'exists', username }
    }
    const users = await this.listAll()
    if (users.some((u) => u.isAdmin)) {
      return { kind: 'other-admin-exists', username }
    }
    await this.create({
      username,
      password: FIRST_BOOT_ADMIN_PASSWORD,
      isAdmin: true,
      allowedProviders: '*',
      allowedDevices: {},
    })
    return { kind: 'seeded', username }
  }

  async hasPassword(username: string, password: string): Promise<boolean> {
    const user = await this.findByUsername(username)
    if (!user) return false
    return this.auth.comparePassword(password, user.passwordHash)
  }
}
