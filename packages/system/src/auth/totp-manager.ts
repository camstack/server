import { generateSecret, verifySync, generateURI } from 'otplib'
import {
  isSecretMarker,
  makeSecretMarker,
  type RawSecretMigrationReport,
  type IScopedLogger,
  type RecordKindHandle,
  type SecretsAccess,
  type SettingsStoreClient,
} from '@camstack/types'
import { readAllRows } from '../records/read-all-rows.js'
import type { UserTotpBody } from '../builtins/local-auth/record-kinds.js'
import { localAuthRecordKinds } from '../builtins/local-auth/record-kinds.js'

/**
 * TOTP / 2FA enrollment manager.
 *
 * Three-state lifecycle keyed by `userId` (PK of `user_totp` collection):
 *
 *   - No row              → not set up. `setup()` inserts a row with a
 *                           fresh secret and `confirmedAt = null`.
 *   - `confirmedAt = null` → setup in progress; user has the secret but
 *                            hasn't proved possession of the
 *                            authenticator yet. `verify()` returns
 *                            false even with a valid code — the row is
 *                            inert until confirmed.
 *   - `confirmedAt != null` → enrolled; `verify()` accepts codes.
 *
 * Disable removes the row entirely. The next `setup()` starts fresh —
 * we do NOT reuse the old secret on re-enroll (avoids the case where a
 * leaked secret stays valid after a "rotation").
 *
 * ## Where the seed lives (D878)
 *
 * The seed is a keychain secret (owner `system`, ref
 * `secret://system/row/user_totp/<userId>/secret`); the row's `secret` column
 * holds the JSON keychain marker, never the seed. A row written before D878
 * still holds the seed inline and keeps working until the operator's
 * `migrateRawSecrets` moves it (nothing migrates at boot). A seed the keychain
 * cannot serve makes `confirm`/`verify` THROW {@link TotpSecretUnavailableError}:
 * 2FA fails closed, never accepts a code and never reads as "not enrolled".
 *
 * `otplib` v13's functional API (`generateSync`/`verifySync`) uses RFC 6238
 * TOTP with a default 30-second period. We pass a per-call `epochTolerance`
 * of one step in either direction (±30 s) — operator clock skew is the usual
 * culprit for "valid code rejected" complaints.
 */

const TOTP_COLLECTION = 'user_totp'
const ISSUER = 'CamStack'
/** RFC 6238 default time step. otplib v13 measures `epochTolerance` in
 *  seconds, so a `window` of N steps maps to `N * TOTP_PERIOD_SECONDS`. */
const TOTP_PERIOD_SECONDS = 30

interface TotpRow {
  userId: string
  /** The stored column: a JSON keychain marker, or (pre-D878) the inline seed. */
  secret: string
  confirmedAt: number | null
  createdAt: number
}

function parseRow(data: Record<string, unknown>): TotpRow {
  const userId = data['userId']
  const secret = data['secret']
  const confirmedAt = data['confirmedAt']
  const createdAt = data['createdAt']
  if (typeof userId !== 'string') throw new Error('user_totp row: missing userId')
  if (typeof secret !== 'string') throw new Error('user_totp row: missing secret')
  if (typeof createdAt !== 'number') throw new Error('user_totp row: missing createdAt')
  return {
    userId,
    secret,
    confirmedAt: typeof confirmedAt === 'number' ? confirmedAt : null,
    createdAt,
  }
}

/**
 * The seed cannot be used right now. The message is what a not-yet-logged-in
 * caller sees, so it is generic; `reason` (keychain detail) is for the server log only.
 */
export class TotpSecretUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(
      'two-factor verification is temporarily unavailable; try again later or ask an administrator',
    )
    this.name = 'TotpSecretUnavailableError'
  }
}

/** A seed cannot be stored: setup is refused, never written as plaintext. */
export class TotpSecretStorageUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `two-factor setup is unavailable: the TOTP seed cannot be stored in the keychain (${reason}).`,
    )
    this.name = 'TotpSecretStorageUnavailableError'
  }
}

type Column =
  | { readonly kind: 'marker'; readonly ref: string }
  | { readonly kind: 'inline' }
  | { readonly kind: 'invalid' }

/** What the stored column is: a keychain marker, a pre-D878 inline seed, or garbage (never an inline seed). */
function classify(column: string): Column {
  if (column.length === 0) return { kind: 'invalid' }
  if (!column.startsWith('{')) return { kind: 'inline' }
  try {
    const parsed: unknown = JSON.parse(column)
    return isSecretMarker(parsed) ? { kind: 'marker', ref: parsed.$secret } : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

export interface TotpSetupResult {
  readonly secret: string
  readonly otpauthUrl: string
}

export interface TotpStatus {
  readonly enabled: boolean
  readonly confirmedAt: number | null
}

export interface TotpRecordsDeps {
  readonly userTotpKind: RecordKindHandle<UserTotpBody>
  readonly legacyStore?: SettingsStoreClient
}

function rowToBody(row: TotpRow): UserTotpBody {
  return {
    confirmedAt: row.confirmedAt,
    createdAt: row.createdAt,
    secret: row.secret,
  }
}

function bodyToRow(userId: string, body: UserTotpBody): TotpRow {
  return {
    userId,
    secret: body.secret,
    confirmedAt: body.confirmedAt ?? null,
    createdAt: body.createdAt,
  }
}

export class TotpManager {
  /** ±N steps of clock-skew tolerance, expressed in seconds for otplib v13's
   *  per-call `epochTolerance`. Default window 1 = ±30 s. */
  private readonly epochTolerance: number
  private readonly secrets: SecretsAccess | null
  private readonly logger: IScopedLogger | null
  private readonly userTotpKind: RecordKindHandle<UserTotpBody> | null
  private readonly store: SettingsStoreClient | null
  /** Per-user queue: setup / confirm / disable / migration never interleave on one user. */
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(
    deps: SettingsStoreClient | TotpRecordsDeps,
    opts: {
      /** ±N 30-second windows tolerated. Default 1 = ±30 s clock skew. */
      readonly window?: number
      /** Keychain handle for owner `system`; `null` = no keychain door (setup refuses). */
      readonly secrets?: SecretsAccess | null
      /** Server-side log for the keychain detail of a refused read. */
      readonly logger?: IScopedLogger
    } = {},
  ) {
    if ('userTotpKind' in deps) {
      this.userTotpKind = deps.userTotpKind
      this.store = deps.legacyStore ?? null
    } else {
      this.userTotpKind = null
      this.store = deps
    }
    this.secrets = opts.secrets ?? null
    this.logger = opts.logger ?? null
    // otplib v13 exposes no shared mutable `authenticator` singleton — the
    // functional API takes options per call. Precompute the skew tolerance
    // (seconds) from the requested step window.
    this.epochTolerance = (opts.window ?? 1) * TOTP_PERIOD_SECONDS
  }

  /**
   * Begin enrollment. Always generates a fresh secret — calling `setup`
   * a second time on the same user replaces any pending half-enrollment
   * (the user must rescan the QR / re-enter the secret).
   *
   * The user identity (`label`) is what an authenticator displays as
   * the account name; we use the supplied `username` for human-readable
   * recognition. `ISSUER` is the CamStack brand.
   */
  setup(userId: string, username: string): Promise<TotpSetupResult> {
    return this.serialize(userId, () => this.setupLocked(userId, username))
  }

  private async setupLocked(userId: string, username: string): Promise<TotpSetupResult> {
    const secret = generateSecret()
    const otpauthUrl = generateURI({ secret, label: username, issuer: ISSUER })
    // Keychain FIRST: a locked keychain refuses the setup before the user's
    // previous enrolment is touched, and nothing is ever written inline.
    const ref = this.refFor(userId)
    if (this.secrets === null || ref === null) {
      throw new TotpSecretStorageUnavailableError('this process has no keychain door')
    }
    // Refuse before touching anything when the keychain is locked ...
    const state = await this.secrets.state().catch(() => null)
    if (state === null || state.state !== 'ready') {
      throw new TotpSecretStorageUnavailableError('the keychain is locked')
    }
    // ... then drop the old row BEFORE the seed under the same ref changes, so
    // a confirmed row can never verify against an unconfirmed seed.
    await this.removeRow(userId)
    const onRecords = this.userTotpKind !== null
    if (!onRecords) {
      try {
        await this.secrets.put(ref, secret)
      } catch (err: unknown) {
        throw new TotpSecretStorageUnavailableError(
          err instanceof Error ? err.message : String(err),
        )
      }
    }
    const row: TotpRow = {
      userId,
      secret: onRecords ? secret : JSON.stringify(makeSecretMarker(ref)),
      confirmedAt: null,
      createdAt: Date.now(),
    }
    await this.writeRow(row)
    return { secret, otpauthUrl }
  }

  /**
   * Confirm enrollment by checking a code from the authenticator
   * against the pending secret. On success, flips `confirmedAt` so
   * `verify()` starts accepting codes. Idempotent on already-confirmed
   * rows: re-confirming a valid code just succeeds with no state
   * change.
   */
  confirm(userId: string, code: string): Promise<boolean> {
    return this.serialize(userId, () => this.confirmLocked(userId, code))
  }

  private async confirmLocked(userId: string, code: string): Promise<boolean> {
    const row = await this.find(userId)
    if (!row) return false
    const seed = await this.seedOf(row)
    if (!verifySync({ token: code, secret: seed, epochTolerance: this.epochTolerance }).valid)
      return false
    if (row.confirmedAt === null) {
      const next: TotpRow = { ...row, confirmedAt: Date.now() }
      await this.writeRow(next)
    }
    return true
  }

  /**
   * Remove enrollment. Idempotent — no error if the user had no row.
   */
  disable(userId: string): Promise<void> {
    return this.serialize(userId, async () => {
      await this.removeRow(userId)
      await this.dropSeed(userId)
    })
  }

  private serialize<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(userId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => undefined)
    this.chains.set(userId, tail)
    void tail.then(() => {
      if (this.chains.get(userId) === tail) this.chains.delete(userId)
    })
    return run
  }

  /**
   * Verify a code against the confirmed secret. Returns `false` when:
   *   - The user has no row (not set up).
   *   - The row is pending (`confirmedAt === null`).
   *   - The code doesn't match within the configured window.
   */
  async verify(userId: string, code: string): Promise<boolean> {
    const row = await this.find(userId)
    if (!row) return false
    if (row.confirmedAt === null) return false
    const seed = await this.seedOf(row)
    return verifySync({ token: code, secret: seed, epochTolerance: this.epochTolerance }).valid
  }

  /**
   * Read the user's enrollment status. Pending half-enrollments are
   * reported as `enabled: false` — only a confirmed row counts.
   */
  async getStatus(userId: string): Promise<TotpStatus> {
    const row = await this.find(userId)
    if (!row) return { enabled: false, confirmedAt: null }
    return {
      enabled: row.confirmedAt !== null,
      confirmedAt: row.confirmedAt,
    }
  }

  private refFor(userId: string): string | null {
    return this.secrets === null
      ? null
      : this.secrets.ref({ kind: 'row', collection: TOTP_COLLECTION, rowId: userId }, 'secret')
  }

  /** A refused read: generic to the caller, the keychain detail to the server log. */
  private unavailable(userId: string, reason: string): TotpSecretUnavailableError {
    this.logger?.warn('TOTP seed unavailable', { tags: { userId }, meta: { reason } })
    return new TotpSecretUnavailableError(reason)
  }

  /** The seed in clear: from the keychain for a marker row, inline for a pre-D878 row. Throws when unreadable. */
  private async seedOf(row: TotpRow): Promise<string> {
    const column = classify(row.secret)
    if (column.kind === 'inline') return row.secret
    if (column.kind === 'invalid') throw this.unavailable(row.userId, 'malformed seed column')
    // A marker is honoured only for ITS user: a forged row must not reach
    // another user's seed or any other `system` secret.
    if (this.secrets === null || column.ref !== this.refFor(row.userId)) {
      throw this.unavailable(row.userId, 'marker does not belong to this user')
    }
    let answer: Awaited<ReturnType<SecretsAccess['resolve']>>[string] | undefined
    try {
      answer = (await this.secrets.resolve([column.ref]))[column.ref]
    } catch (err: unknown) {
      throw this.unavailable(row.userId, err instanceof Error ? err.message : String(err))
    }
    if (answer?.kind === 'value') return answer.value
    throw this.unavailable(
      row.userId,
      answer?.kind === 'unavailable' ? answer.reason : (answer?.kind ?? 'no-answer'),
    )
  }

  /** Remove a user's seed from the keychain; a miss leaves an orphan the Secrets page shows. */
  private async dropSeed(userId: string): Promise<void> {
    const ref = this.refFor(userId)
    if (ref === null) return
    try {
      await this.secrets?.delete([ref])
    } catch {
      /* the enrolment is already gone; an orphan is reported by System -> Secrets */
    }
  }

  /**
   * D878: move every inline seed into the keychain. Dry run unless `apply`.
   * Per row: put -> read back and compare -> only then rewrite the row with the
   * marker, so the inline seed is cleared by the verified move and nowhere
   * else. Counts only; idempotent.
   */
  async migrateRawSecrets(apply: boolean): Promise<RawSecretMigrationReport> {
    const rows = await this.readAll()
    let raw = 0
    let markers = 0
    let migrated = 0
    let failed = 0
    for (const row of rows) {
      const kind = classify(row.secret).kind
      if (kind === 'marker') {
        markers += 1
        continue
      }
      if (kind !== 'inline') continue
      raw += 1
      if (!apply) continue
      if (await this.moveRow(row)) migrated += 1
      else failed += 1
    }
    let remainingRaw = 0
    let unresolvedMarkers = 0
    for (const row of await this.readAll()) {
      if (classify(row.secret).kind === 'inline') {
        remainingRaw += 1
        continue
      }
      try {
        await this.seedOf(row)
      } catch {
        unresolvedMarkers += 1
      }
    }
    return {
      apply,
      rows: rows.length,
      raw,
      markers,
      migrated,
      failed,
      remainingRaw,
      unresolvedMarkers,
      verified: remainingRaw === 0 && unresolvedMarkers === 0,
    }
  }

  /**
   * Compare-and-set under the user's queue: the row is re-read and moved only if
   * it still holds the very inline seed we planned to move, so a concurrent
   * `setup` (its seed and marker) is never overwritten. The ref is always the
   * user's own, never taken from the row.
   */
  private moveRow(planned: TotpRow): Promise<boolean> {
    return this.serialize(planned.userId, async () => {
      const ref = this.refFor(planned.userId)
      if (this.secrets === null || ref === null) return false
      try {
        const current = await this.find(planned.userId)
        if (current === null || current.secret !== planned.secret) return false
        await this.secrets.put(ref, planned.secret)
        const back = (await this.secrets.resolve([ref]))[ref]
        if (back?.kind !== 'value' || back.value !== planned.secret) return false
        const next: TotpRow = { ...current, secret: JSON.stringify(makeSecretMarker(ref)) }
        await this.writeRow(next)
        return true
      } catch {
        return false
      }
    })
  }

  private async readAll(): Promise<TotpRow[]> {
    const kind = this.userTotpKind
    if (kind !== null) {
      const rows = await readAllRows(kind)
      const out: TotpRow[] = []
      for (const r of rows) {
        try {
          out.push(bodyToRow(r.id, r.data))
        } catch {
          /* skip malformed */
        }
      }
      return out
    }
    const results = await this.store!.query.query({ collection: TOTP_COLLECTION })
    const out: TotpRow[] = []
    for (const r of results) {
      try {
        out.push(parseRow(r.data as Record<string, unknown>))
      } catch {
        /* a malformed row is not ours to move */
      }
    }
    return out
  }

  private async find(userId: string): Promise<TotpRow | null> {
    const kind = this.userTotpKind
    if (kind !== null) {
      const row = await kind.getResolved(userId)
      return row === null ? null : bodyToRow(row.id, row.data)
    }
    const results = await this.store!.query.query({
      collection: TOTP_COLLECTION,
      filter: { where: { userId } },
    })
    if (results.length === 0) return null
    return parseRow(results[0]!.data as Record<string, unknown>)
  }

  private async writeRow(row: TotpRow): Promise<void> {
    const kind = this.userTotpKind
    if (kind !== null) {
      const parsed = localAuthRecordKinds['user-totp'].schema.safeParse(rowToBody(row))
      if (!parsed.success) throw new Error(parsed.error.message)
      await kind.put({ id: row.userId, data: parsed.data })
      return
    }
    const existing = await this.store!.query.query({
      collection: TOTP_COLLECTION,
      filter: { where: { userId: row.userId } },
    })
    if (existing.length > 0) {
      await this.store!.update.mutate({
        collection: TOTP_COLLECTION,
        id: row.userId,
        data: { ...row },
      })
    } else {
      await this.store!.insert.mutate({
        collection: TOTP_COLLECTION,
        record: { id: row.userId, data: { ...row } },
      })
    }
  }

  private async removeRow(userId: string): Promise<void> {
    const kind = this.userTotpKind
    if (kind !== null) {
      await kind.delete(userId)
      return
    }
    await this.store!.delete.mutate({ collection: TOTP_COLLECTION, key: userId })
  }
}
