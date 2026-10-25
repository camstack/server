import { userError } from '@camstack/types'
/**
 * Device credentials (D855): the registry of enrolled devices, the one-shot
 * enrollment codes, the login nonces and the certificate checks.
 *
 * Hub-owned and persisted in `device_credentials` (the settings store);
 * agents persist nothing. Enrollment codes and nonces live in memory only —
 * both die in minutes and a hub restart simply asks the user to start again.
 *
 * Every refusal is logged with its reason and the credential/user it concerns
 * (`tags: { credentialId | userId }`) — never the code, the nonce or a
 * signature.
 */
import * as crypto from 'node:crypto'
import type {
  CollectionColumn,
  IScopedLogger,
  RecordKindHandle,
  SettingsStoreClient,
} from '@camstack/types'
import { readAllRows } from '../records/read-all-rows.js'
import type { DeviceCredentialBody } from '../builtins/local-auth/record-kinds.js'
import { localAuthRecordKinds } from '../builtins/local-auth/record-kinds.js'
import {
  buildDeviceSignatureMessage,
  type DeviceCredential,
  type DevicePlatform,
  DEVICE_ENROLLMENT_TTL_MS,
  DEVICE_NONCE_TTL_MS,
  type DeviceSignaturePurpose,
} from '@camstack/types'
import {
  type DeviceCaSigner,
  type DeviceLeafMaterial,
  importDevicePublicKey,
  issueDeviceLeaf,
  verifyDeviceLeaf,
  verifyDeviceSignature,
} from './device-ca.js'
import type { DeviceCaStore } from './device-ca-store.js'

/**
 * @durable class=config owner=local-auth
 *   write="an enrollment completes (QR or self) inserts a row; a renewal rewrites
 *     fingerprint/expiry; every accepted certificate login rewrites lastUsedAt/From;
 *     an admin revokes or renames"
 *   retention="a revoked or long-expired row is kept 90 days for the audit question
 *     'which device was that', then the daily reap deletes it; an active row is
 *     never deleted"
 */
export const DEVICE_CREDENTIALS_COLLECTION = 'device_credentials'

export const DEVICE_CREDENTIALS_COLUMNS: readonly CollectionColumn[] = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'userId', type: 'TEXT' as const, notNull: true },
  { name: 'deviceName', type: 'TEXT' as const, notNull: true },
  { name: 'platform', type: 'TEXT' as const, notNull: true },
  { name: 'enrolledVia', type: 'TEXT' as const, notNull: true },
  { name: 'fingerprint', type: 'TEXT' as const, notNull: true },
  { name: 'serial', type: 'TEXT' as const, notNull: true },
  { name: 'previousFingerprint', type: 'TEXT' as const },
  { name: 'renewedAt', type: 'INTEGER' as const },
  { name: 'publicKey', type: 'TEXT' as const, notNull: true },
  { name: 'issuedAt', type: 'INTEGER' as const, notNull: true },
  { name: 'expiresAt', type: 'INTEGER' as const, notNull: true },
  { name: 'lastUsedAt', type: 'INTEGER' as const },
  { name: 'lastUsedFrom', type: 'TEXT' as const },
  { name: 'revokedAt', type: 'INTEGER' as const },
  { name: 'revokedBy', type: 'TEXT' as const },
]

export type EnrolledVia = 'qr' | 'self'

export interface DeviceCredentialRecord {
  readonly id: string
  readonly userId: string
  readonly deviceName: string
  readonly platform: DevicePlatform
  readonly enrolledVia: EnrolledVia
  readonly fingerprint: string
  readonly serial: string
  /** The fingerprint the leaf had before the last renewal, accepted until {@link PREVIOUS_LEAF_GRACE_MS} after `renewedAt`. */
  readonly previousFingerprint: string | null
  readonly renewedAt: number | null
  /** SPKI DER, base64url. */
  readonly publicKey: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly lastUsedAt: number | null
  readonly lastUsedFrom: string | null
  readonly revokedAt: number | null
  readonly revokedBy: string | null
}

export type DeviceCredentialState = 'active' | 'expired' | 'revoked' | 'unknown'

export type DeviceCheckRefusal =
  | 'unknown-or-used-code'
  | 'expired-code'
  | 'user-gone'
  | 'ca-unavailable'
  | 'bad-public-key'
  | 'self-enrollment-disabled'
  | 'unknown-nonce'
  | 'expired-nonce'
  | 'no-device-ca'
  | 'malformed-certificate'
  | 'not-issued-by-device-ca'
  | 'not-yet-valid'
  | 'expired'
  | 'missing-credential-san'
  | 'missing-client-auth'
  | 'unknown-credential'
  | 'revoked'
  | 'key-mismatch'
  | 'bad-signature'
  | 'user-mismatch'
  | 'superseded'

export type Refused = { readonly ok: false; readonly reason: DeviceCheckRefusal }

export interface IssuedDeviceCertificate {
  readonly ok: true
  readonly credentialId: string
  readonly userId: string
  readonly certPem: string
  readonly chainPem: string
  readonly notAfter: number
}

export interface AuthenticatedDevice {
  readonly ok: true
  readonly credential: DeviceCredentialRecord
}

export interface DeviceNonce {
  readonly nonce: string
  readonly expiresAt: number
}

interface PendingEnrollment {
  readonly userId: string
  readonly deviceName: string
  readonly createdBy: string
  readonly expiresAt: number
}

const MAX_PENDING = 2_000
/**
 * Outstanding login nonces are bounded PER CLIENT (a partition = the client
 * address): one flooder evicts only its own oldest nonces, never another
 * client's. {@link MAX_NONCES_TOTAL} is a memory ceiling that only a flood from
 * hundreds of distinct addresses can reach.
 */
const MAX_NONCES_PER_PARTITION = 50
const MAX_NONCES_TOTAL = 20_000
/**
 * After a renewal the PREVIOUS leaf still logs in for this long, so a device
 * that crashed between the hub's answer and its own write is not locked out;
 * after it, the old leaf is `superseded` (not definitive: the app holds the
 * newest certificate, so seeing it means the device lost the new one).
 */
export const PREVIOUS_LEAF_GRACE_MS: number = 24 * 3_600_000
const REAP_RETENTION_MS = 90 * 86_400_000

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function str(data: Record<string, unknown>, key: string): string | null {
  const v = data[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(data: Record<string, unknown>, key: string): number | null {
  const v = data[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

const PLATFORMS: readonly DevicePlatform[] = ['ios', 'android', 'web', 'other']

function parseRecord(data: Record<string, unknown>): DeviceCredentialRecord | null {
  const id = str(data, 'id')
  const userId = str(data, 'userId')
  const deviceName = str(data, 'deviceName')
  const fingerprint = str(data, 'fingerprint')
  const serial = str(data, 'serial')
  const publicKey = str(data, 'publicKey')
  const issuedAt = num(data, 'issuedAt')
  const expiresAt = num(data, 'expiresAt')
  if (
    id === null ||
    userId === null ||
    deviceName === null ||
    fingerprint === null ||
    serial === null ||
    publicKey === null ||
    issuedAt === null ||
    expiresAt === null
  ) {
    return null
  }
  return {
    id,
    userId,
    deviceName,
    platform: PLATFORMS.find((p) => p === data['platform']) ?? 'other',
    enrolledVia: data['enrolledVia'] === 'self' ? 'self' : 'qr',
    fingerprint,
    serial,
    previousFingerprint: str(data, 'previousFingerprint'),
    renewedAt: num(data, 'renewedAt'),
    publicKey,
    issuedAt,
    expiresAt,
    lastUsedAt: num(data, 'lastUsedAt'),
    lastUsedFrom: str(data, 'lastUsedFrom'),
    revokedAt: num(data, 'revokedAt'),
    revokedBy: str(data, 'revokedBy'),
  }
}

function recordToBody(record: DeviceCredentialRecord): DeviceCredentialBody {
  return {
    userId: record.userId,
    deviceName: record.deviceName,
    platform: record.platform,
    enrolledVia: record.enrolledVia,
    fingerprint: record.fingerprint,
    serial: record.serial,
    previousFingerprint: record.previousFingerprint,
    renewedAt: record.renewedAt,
    publicKey: record.publicKey,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    lastUsedFrom: record.lastUsedFrom,
    revokedAt: record.revokedAt,
    revokedBy: record.revokedBy,
  }
}

export interface DeviceCredentialManagerDeps {
  readonly ca: Pick<DeviceCaStore, 'lookup' | 'ensure'>
  /** The user a credential names; `null` when gone. */
  readonly findUser: (userId: string) => Promise<{ readonly username: string } | null>
  /** Hub-wide switch for `enrollSelf`; absent = allowed. */
  readonly selfEnrollmentAllowed: () => Promise<boolean>
  readonly deviceCredentialsKind?: RecordKindHandle<DeviceCredentialBody> | null
  readonly now?: () => number
  readonly logger?: IScopedLogger
}

export class DeviceCredentialManager {
  private readonly records = new Map<string, DeviceCredentialRecord>()
  private readonly pendingEnrollments = new Map<string, PendingEnrollment>()
  private readonly usedCodes = new Map<string, number>()
  private readonly nonces = new Map<
    string,
    { origin: string; expiresAt: number; partition: string }
  >()
  private readonly now: () => number

  constructor(
    private readonly store: SettingsStoreClient,
    private readonly deps: DeviceCredentialManagerDeps,
  ) {
    this.now = deps.now ?? Date.now
  }

  async load(): Promise<void> {
    const kind = this.deps.deviceCredentialsKind ?? null
    if (kind !== null) {
      for (const row of await readAllRows(kind)) {
        const record = parseRecord({ id: row.id, ...row.data })
        if (record !== null) this.records.set(record.id, record)
      }
      return
    }
    const rows = await this.store.query.query({ collection: DEVICE_CREDENTIALS_COLLECTION })
    for (const row of rows) {
      const record = parseRecord(row.data)
      if (record !== null) this.records.set(record.id, record)
    }
  }

  // ── Enrollment ──────────────────────────────────────────────────────

  /** A one-shot code for `userId` (admin path). Returned once; only its hash is kept. */
  startEnrollment(input: {
    readonly userId: string
    readonly deviceName: string
    readonly createdBy: string
  }): { readonly code: string; readonly expiresAt: number } {
    this.prune()
    if (this.pendingEnrollments.size >= MAX_PENDING) {
      throw userError(
        'system.device-enrollment-busy',
        undefined,
        'Too many pending device enrollments — try again shortly',
      )
    }
    const code = crypto.randomBytes(24).toString('base64url') // 192 bits
    const expiresAt = this.now() + DEVICE_ENROLLMENT_TTL_MS
    this.pendingEnrollments.set(hash(code), {
      userId: input.userId,
      deviceName: input.deviceName,
      createdBy: input.createdBy,
      expiresAt,
    })
    return { code, expiresAt }
  }

  /** Redeem a code with the device's public key (public procedure). */
  async completeEnrollment(input: {
    readonly code: string
    readonly publicKeySpki: string
    readonly deviceName?: string
    readonly platform: DevicePlatform
  }): Promise<(IssuedDeviceCertificate & { readonly username: string }) | Refused> {
    const key = hash(input.code)
    const pending = this.pendingEnrollments.get(key)
    if (pending === undefined) {
      const wasUsed = this.usedCodes.has(key)
      return this.refuse('enroll', 'unknown-or-used-code', {
        detail: wasUsed ? 'code already redeemed' : 'code unknown',
      })
    }
    // Single use: consumed on the FIRST attempt whatever its outcome.
    this.pendingEnrollments.delete(key)
    this.usedCodes.set(key, pending.expiresAt)
    if (this.now() > pending.expiresAt) {
      return this.refuse('enroll', 'expired-code', { userId: pending.userId })
    }
    return this.issueNew({
      userId: pending.userId,
      deviceName: input.deviceName ?? pending.deviceName,
      platform: input.platform,
      publicKeySpki: input.publicKeySpki,
      enrolledVia: 'qr',
    })
  }

  /** A signed-in user's own device (the caller has already proved a step-up). */
  async enrollSelf(input: {
    readonly userId: string
    readonly publicKeySpki: string
    readonly deviceName: string
    readonly platform: DevicePlatform
  }): Promise<(IssuedDeviceCertificate & { readonly username: string }) | Refused> {
    if (!(await this.deps.selfEnrollmentAllowed())) {
      return this.refuse('enroll-self', 'self-enrollment-disabled', { userId: input.userId })
    }
    return this.issueNew({ ...input, enrolledVia: 'self' })
  }

  private async issueNew(input: {
    readonly userId: string
    readonly deviceName: string
    readonly platform: DevicePlatform
    readonly publicKeySpki: string
    readonly enrolledVia: EnrolledVia
  }): Promise<(IssuedDeviceCertificate & { readonly username: string }) | Refused> {
    const user = await this.deps.findUser(input.userId)
    if (user === null) return this.refuse('enroll', 'user-gone', { userId: input.userId })
    const spki = Buffer.from(input.publicKeySpki, 'base64url')
    try {
      await importDevicePublicKey(spki)
    } catch {
      return this.refuse('enroll', 'bad-public-key', { userId: input.userId })
    }
    let ca: DeviceCaSigner
    try {
      ca = await this.deps.ca.ensure()
    } catch (error: unknown) {
      this.deps.logger?.error('Device enrollment refused: the device CA is unavailable', {
        tags: { userId: input.userId },
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
      return { ok: false, reason: 'ca-unavailable' }
    }
    const id = crypto.randomUUID()
    const leaf = await issueDeviceLeaf(ca, {
      credentialId: id,
      userId: input.userId,
      publicKeySpki: spki,
      now: new Date(this.now()),
    })
    const record: DeviceCredentialRecord = {
      id,
      userId: input.userId,
      deviceName: input.deviceName,
      platform: input.platform,
      enrolledVia: input.enrolledVia,
      fingerprint: leaf.fingerprint,
      serial: leaf.serialNumber,
      previousFingerprint: null,
      renewedAt: null,
      publicKey: input.publicKeySpki,
      issuedAt: leaf.notBefore.getTime(),
      expiresAt: leaf.notAfter.getTime(),
      lastUsedAt: null,
      lastUsedFrom: null,
      revokedAt: null,
      revokedBy: null,
    }
    await this.persistRecord(record, 'insert')
    this.records.set(id, record)
    this.deps.logger?.info('Device credential enrolled', {
      tags: { credentialId: id, userId: input.userId },
      meta: { via: input.enrolledVia, platform: input.platform },
    })
    return this.issued(record, leaf, ca, user.username)
  }

  private issued(
    record: DeviceCredentialRecord,
    leaf: DeviceLeafMaterial,
    ca: DeviceCaSigner,
    username: string,
  ): IssuedDeviceCertificate & { readonly username: string } {
    return {
      ok: true,
      credentialId: record.id,
      userId: record.userId,
      username,
      certPem: leaf.certPem,
      chainPem: ca.certPem,
      notAfter: leaf.notAfter.getTime(),
    }
  }

  // ── Login / renewal ─────────────────────────────────────────────────

  /** A single-use nonce bound to `origin`. */
  issueNonce(origin: string, partition = 'unknown'): DeviceNonce {
    this.prune()
    const own = [...this.nonces.entries()].filter(([, v]) => v.partition === partition)
    // Oldest of the CALLER's partition first: a flood evicts only its own nonces.
    for (const [key] of own.slice(0, Math.max(0, own.length - MAX_NONCES_PER_PARTITION + 1))) {
      this.nonces.delete(key)
    }
    if (this.nonces.size >= MAX_NONCES_TOTAL) {
      const oldest = this.nonces.keys().next()
      if (oldest.done !== true) this.nonces.delete(oldest.value)
    }
    const nonce = crypto.randomBytes(32).toString('base64url')
    const expiresAt = this.now() + DEVICE_NONCE_TTL_MS
    this.nonces.set(nonce, { origin, expiresAt, partition })
    return { nonce, expiresAt }
  }

  /**
   * Check a presented certificate + signature. Consumes the nonce on the first
   * attempt. On success the credential's lastUsed is stamped.
   */
  async authenticate(input: {
    readonly certPem: string
    readonly nonce: string
    readonly signature: string
    readonly purpose: DeviceSignaturePurpose
    readonly from?: string
  }): Promise<AuthenticatedDevice | Refused> {
    const bound = this.nonces.get(input.nonce)
    if (bound === undefined) return this.refuse(input.purpose, 'unknown-nonce', {})
    this.nonces.delete(input.nonce)
    if (this.now() > bound.expiresAt) return this.refuse(input.purpose, 'expired-nonce', {})
    const caState = await this.deps.ca.lookup()
    if (caState.state !== 'ready') return this.refuse(input.purpose, 'no-device-ca', {})
    const verdict = await verifyDeviceLeaf(caState.ca.certPem, input.certPem, new Date(this.now()))
    if (!verdict.ok) return this.refuse(input.purpose, verdict.reason, {})
    // The signature is checked against the key IN THE PRESENTED LEAF before the
    // registry is consulted: whoever cannot sign with a CA-issued leaf's key
    // learns nothing about which credentials exist, are revoked or deleted.
    const message = buildDeviceSignatureMessage({
      purpose: input.purpose,
      origin: bound.origin,
      nonce: input.nonce,
    })
    if (!verifyDeviceSignature(verdict.publicKeySpki, message, input.signature)) {
      return this.refuse(input.purpose, 'bad-signature', { credentialId: verdict.credentialId })
    }
    const record = this.records.get(verdict.credentialId)
    if (record === undefined) {
      return this.refuse(input.purpose, 'unknown-credential', {
        credentialId: verdict.credentialId,
      })
    }
    const tags = { credentialId: record.id, userId: record.userId }
    if (record.revokedAt !== null) return this.refuse(input.purpose, 'revoked', tags)
    if (verdict.userId !== null && verdict.userId !== record.userId) {
      return this.refuse(input.purpose, 'user-mismatch', tags)
    }
    if (!verdict.publicKeySpki.equals(Buffer.from(record.publicKey, 'base64url'))) {
      return this.refuse(input.purpose, 'key-mismatch', tags)
    }
    if (verdict.fingerprint !== record.fingerprint) {
      const inGrace =
        record.previousFingerprint !== null &&
        verdict.fingerprint === record.previousFingerprint &&
        record.renewedAt !== null &&
        this.now() - record.renewedAt <= PREVIOUS_LEAF_GRACE_MS
      if (!inGrace) return this.refuse(input.purpose, 'superseded', tags)
    }
    const used: DeviceCredentialRecord = {
      ...record,
      lastUsedAt: this.now(),
      lastUsedFrom: input.from ?? record.lastUsedFrom,
    }
    await this.save(used)
    return { ok: true, credential: used }
  }

  /** A new leaf for the SAME public key, after {@link authenticate} accepted a `renew` proof. */
  async renew(credential: DeviceCredentialRecord): Promise<IssuedDeviceCertificate | Refused> {
    const current = this.records.get(credential.id)
    if (current === undefined) return this.refuse('renew', 'unknown-credential', {})
    if (current.revokedAt !== null) {
      return this.refuse('renew', 'revoked', { credentialId: current.id, userId: current.userId })
    }
    let ca: DeviceCaSigner
    try {
      ca = await this.deps.ca.ensure()
    } catch {
      return { ok: false, reason: 'ca-unavailable' }
    }
    const leaf = await issueDeviceLeaf(ca, {
      credentialId: current.id,
      userId: current.userId,
      publicKeySpki: Buffer.from(current.publicKey, 'base64url'),
      now: new Date(this.now()),
    })
    const updated: DeviceCredentialRecord = {
      ...current,
      fingerprint: leaf.fingerprint,
      serial: leaf.serialNumber,
      previousFingerprint: current.fingerprint,
      renewedAt: this.now(),
      issuedAt: leaf.notBefore.getTime(),
      expiresAt: leaf.notAfter.getTime(),
    }
    await this.save(updated)
    this.deps.logger?.info('Device certificate renewed', {
      tags: { credentialId: updated.id, userId: updated.userId },
    })
    return {
      ok: true,
      credentialId: updated.id,
      userId: updated.userId,
      certPem: leaf.certPem,
      chainPem: ca.certPem,
      notAfter: leaf.notAfter.getTime(),
    }
  }

  // ── Registry ────────────────────────────────────────────────────────

  /** Synchronous: the hub asks on every refresh of a credential-bound session. */
  check(credentialId: string): DeviceCredentialState {
    const record = this.records.get(credentialId)
    if (record === undefined) return 'unknown'
    if (record.revokedAt !== null) return 'revoked'
    return record.expiresAt <= this.now() ? 'expired' : 'active'
  }

  get(credentialId: string): DeviceCredentialRecord | undefined {
    return this.records.get(credentialId)
  }

  list(input: {
    readonly userId?: string
    readonly includeRevoked: boolean
  }): readonly DeviceCredentialRecord[] {
    return [...this.records.values()]
      .filter((r) => input.userId === undefined || r.userId === input.userId)
      .filter((r) => input.includeRevoked || r.revokedAt === null)
      .toSorted((a, b) => b.issuedAt - a.issuedAt)
  }

  /**
   * Delete a REVOKED row (admin clean-up). `live` refuses a credential that is
   * not revoked — a live credential is revoked first, so a delete can never be
   * the way a device silently stops working.
   */
  async delete(credentialId: string): Promise<'deleted' | 'live' | 'unknown'> {
    const record = this.records.get(credentialId)
    if (record === undefined) return 'unknown'
    if (record.revokedAt === null) {
      this.deps.logger?.warn('Device credential delete refused: still live', {
        tags: { credentialId, userId: record.userId },
      })
      return 'live'
    }
    this.records.delete(credentialId)
    await this.deleteRecord(credentialId)
    this.deps.logger?.info('Device credential row deleted', {
      tags: { credentialId, userId: record.userId },
    })
    return 'deleted'
  }

  /** Revoke; `false` when unknown or already revoked. `revokedBy`: see `formatDeviceRevoker`. */
  async revoke(credentialId: string, revokedBy: string): Promise<boolean> {
    const record = this.records.get(credentialId)
    if (record === undefined || record.revokedAt !== null) return false
    await this.save({ ...record, revokedAt: this.now(), revokedBy })
    this.deps.logger?.warn('Device credential revoked', {
      tags: { credentialId, userId: record.userId },
      meta: { revokedBy },
    })
    return true
  }

  async rename(credentialId: string, deviceName: string): Promise<boolean> {
    const record = this.records.get(credentialId)
    if (record === undefined) return false
    await this.save({ ...record, deviceName })
    return true
  }

  /** Revoke every credential of a user (account deleted). Returns their ids. */
  async revokeAllForUser(userId: string, revokedBy: string): Promise<readonly string[]> {
    const ids = [...this.records.values()]
      .filter((r) => r.userId === userId && r.revokedAt === null)
      .map((r) => r.id)
    for (const id of ids) await this.revoke(id, revokedBy)
    return ids
  }

  toSummary(record: DeviceCredentialRecord, username: string | null): DeviceCredential {
    return {
      id: record.id,
      userId: record.userId,
      username,
      deviceName: record.deviceName,
      platform: record.platform,
      enrolledVia: record.enrolledVia,
      fingerprint: record.fingerprint,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      lastUsedAt: record.lastUsedAt,
      lastUsedFrom: record.lastUsedFrom,
      revokedAt: record.revokedAt,
      revokedBy: record.revokedBy,
      status:
        record.revokedAt !== null
          ? 'revoked'
          : record.expiresAt <= this.now()
            ? 'expired'
            : 'active',
    }
  }

  /** Delete rows revoked or expired more than 90 days ago. */
  async reap(): Promise<number> {
    const cutoff = this.now() - REAP_RETENTION_MS
    const dead = [...this.records.values()].filter((r) => (r.revokedAt ?? r.expiresAt) < cutoff)
    for (const r of dead) {
      this.records.delete(r.id)
      await this.deleteRecord(r.id)
    }
    return dead.length
  }

  private async persistRecord(
    record: DeviceCredentialRecord,
    mode: 'insert' | 'update',
  ): Promise<void> {
    const kind = this.deps.deviceCredentialsKind ?? null
    if (kind !== null) {
      const parsed = localAuthRecordKinds['device-credentials'].schema.safeParse(
        recordToBody(record),
      )
      if (!parsed.success) throw new Error(parsed.error.message)
      await kind.put({ id: record.id, expiresAt: record.expiresAt, data: parsed.data })
      return
    }
    if (mode === 'insert') {
      await this.store.insert.mutate({
        collection: DEVICE_CREDENTIALS_COLLECTION,
        record: { id: record.id, data: { ...record } },
      })
    } else {
      await this.store.update.mutate({
        collection: DEVICE_CREDENTIALS_COLLECTION,
        id: record.id,
        data: { ...record },
      })
    }
  }

  private async deleteRecord(id: string): Promise<void> {
    const kind = this.deps.deviceCredentialsKind ?? null
    if (kind !== null) {
      await kind.delete(id)
      return
    }
    await this.store.delete.mutate({ collection: DEVICE_CREDENTIALS_COLLECTION, key: id })
  }

  private async save(record: DeviceCredentialRecord): Promise<void> {
    this.records.set(record.id, record)
    try {
      await this.persistRecord(record, 'update')
    } catch (error: unknown) {
      // The mirror holds the change (a revocation applies NOW); only its
      // survival across a restart is at risk, and that is worth saying.
      this.deps.logger?.error('Device credential write failed — the change holds until restart', {
        tags: { credentialId: record.id, userId: record.userId },
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  private refuse(
    leg: string,
    reason: DeviceCheckRefusal,
    context: { credentialId?: string; userId?: string; detail?: string },
  ): Refused {
    this.deps.logger?.warn(`Device credential ${leg} refused: ${reason}`, {
      tags: {
        ...(context.credentialId !== undefined ? { credentialId: context.credentialId } : {}),
        ...(context.userId !== undefined ? { userId: context.userId } : {}),
      },
      meta: { leg, reason, ...(context.detail !== undefined ? { detail: context.detail } : {}) },
    })
    return { ok: false, reason }
  }

  private prune(): void {
    const at = this.now()
    for (const [k, v] of this.pendingEnrollments)
      if (at > v.expiresAt) this.pendingEnrollments.delete(k)
    for (const [k, exp] of this.usedCodes)
      if (at > exp + DEVICE_ENROLLMENT_TTL_MS) this.usedCodes.delete(k)
    for (const [k, v] of this.nonces) if (at > v.expiresAt) this.nonces.delete(k)
  }
}
