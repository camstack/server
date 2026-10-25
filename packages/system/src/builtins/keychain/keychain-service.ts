/**
 * The keychain itself: unlock, owner checks, values, audit, rotation.
 *
 * Owner rule. A caller may touch a ref only when it OWNS it: the caller is the
 * ref's owner, or the runner hosting it (a grouped runner's stamp is its group
 * id, and the group is the identity the transport can vouch for). A caller the
 * transport did not identify owns nothing. Best-effort identity against bugs
 * and misrouting — the threat model says what it is not.
 *
 * Locked is never empty. A missing key, a wrong key or an unreadable key file
 * leave the keychain `locked` with that reason: `put` refuses, `resolve`
 * answers `unavailable` per ref. A first boot generates keys only when there
 * is NOTHING to lose — no wrapped data key and no stored value; otherwise a
 * lost key would silently become a fresh, empty keychain.
 */
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import {
  EventCategory,
  formatSecretScope,
  type KeychainAuditAction,
  type KeychainAuditEntry,
  type KeychainKeySource,
  type KeychainResetRecord,
  type KeychainResolveEntry,
  type KeychainResolveResult,
  type KeychainSecretMeta,
  type KeychainSecretUsage,
  type KeychainState,
  type KeychainStatus,
  type KeychainUnavailableReason,
  type KnownEventCategory,
  normalizeSecretOwner,
  parseSecretRef,
  type SystemHeldSecretName,
} from '@camstack/types'
import { defaultKeyFilePath, type KeySourceCandidate, writeDefaultKeyFile } from './key-sources.js'
import {
  constantTimeEquals,
  decryptValue,
  encodeKeyMaterial,
  encryptValue,
  generateKey,
  generateKeyId,
  kekFingerprint,
  shortFingerprint,
  unwrapDek,
  wrapDek,
} from './keychain-crypto.js'
import type { KeychainKeyRow, KeychainRepository, KeychainSecretRow } from './keychain-store.js'
import {
  PROCESS_HELD_SECRET_REFS,
  SYSTEM_HELD_SECRET_REFS,
  SYSTEM_SECRET_OWNER,
  SYSTEM_SECRET_SETTINGS_KEYS,
} from './system-held-secrets.js'

/** The one caller that may purge a whole device scope across owners (D864). */
export const DEVICE_SCOPE_PURGER = 'device-manager'

/** `lastReadAt` is written at most this often per ref (hub I/O is the bottleneck). */
export const LAST_READ_GRANULARITY_MS: number = 60 * 60_000

export class KeychainLockedError extends Error {
  constructor(readonly reason: KeychainUnavailableReason) {
    super(`keychain is locked (${reason}) — no value can be stored or revealed`)
    this.name = 'KeychainLockedError'
  }
}

/** A reset that would archive the values and still end locked — refused before it starts. */
export class KeychainResetRefusedError extends Error {
  constructor(reason: string) {
    super(`keychain reset refused: ${reason}`)
    this.name = 'KeychainResetRefusedError'
  }
}

export class KeychainForbiddenError extends Error {
  constructor(
    readonly ref: string,
    caller: string | null,
  ) {
    super(
      `keychain: ${caller === null ? 'an unidentified caller' : `"${caller}"`} does not own ${ref}`,
    )
    this.name = 'KeychainForbiddenError'
  }
}

export interface KeychainEventSink {
  emit(payload: {
    readonly ref: string
    readonly owner: string
    readonly version: number | null
    readonly change: 'put' | 'delete'
  }): void
}

export interface KeychainLogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

/** Answers whether a stored ref is still pointed at by its owner's settings. */
export type KeychainUsageCheck = (
  rows: readonly KeychainSecretRow[],
) => Promise<ReadonlyMap<string, KeychainSecretUsage>>

export interface KeychainServiceDeps {
  readonly repo: KeychainRepository
  /** Rebuilt on every unlock / rotation — the configuration may have changed. */
  readonly candidates: () => Promise<readonly KeySourceCandidate[]>
  readonly dataDir: string
  readonly events: KeychainEventSink
  readonly logger: KeychainLogger
  /** The runner id hosting an addon (its group, or itself). */
  readonly runnerIdOf: (addonId: string) => string
  readonly usage: KeychainUsageCheck
  readonly now?: () => number
}

interface Unlocked {
  readonly state: 'ready'
  readonly dek: Buffer
  readonly keyId: string
  readonly kek: Buffer
  readonly fingerprint: string
  readonly source: KeychainKeySource
  readonly wrap: KeychainKeyRow
  readonly rotationPending: boolean
}

interface Locked {
  readonly state: 'locked'
  readonly reason: KeychainUnavailableReason
}

type Unlock = Unlocked | Locked

const NOT_INITIALIZED: Locked = { state: 'locked', reason: 'not-initialized' }

/**
 * Refs `importSecret` accepts for operator migration (D870): restream tokens and
 * record-row secret refs (`recordSecretRef` — collection `records%3A<kind>`).
 */
const IMPORTABLE_REF =
  /^(?:secret:\/\/stream-broker\/device\/[0-9]+\/rtspTokens|secret:\/\/[^/]+\/row\/records%3A[^/]+\/[^/]+\/.+)$/

export class KeychainService {
  private unlock: Unlock = NOT_INITIALIZED
  private configuredSource: KeychainKeySource | null = null
  private readonly now: () => number

  constructor(private readonly deps: KeychainServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  // ── Unlock ──────────────────────────────────────────────────────────────

  /** Load the keys and unlock. Never throws for a key problem — it locks. */
  async init(): Promise<KeychainState> {
    try {
      await this.deps.repo.init()
    } catch (err: unknown) {
      this.unlock = { state: 'locked', reason: 'store-unavailable' }
      this.deps.logger.error('keychain tables could not be declared — locked', {
        error: errMsg(err),
      })
      return this.getState()
    }
    this.unlock = await this.computeUnlock()
    if (this.unlock.state === 'ready') {
      this.deps.logger.info('keychain unlocked', {
        source: this.unlock.source.kind,
        path: this.unlock.source.path,
        fingerprint: shortFingerprint(this.unlock.fingerprint),
        rotationPending: this.unlock.rotationPending,
      })
    } else {
      this.deps.logger.error('keychain LOCKED — every secret resolves unavailable', {
        reason: this.unlock.reason,
        path: this.configuredSource?.path,
      })
    }
    try {
      await this.deps.repo.pruneAudit(this.now())
    } catch (err: unknown) {
      this.deps.logger.warn('keychain audit prune failed', { error: errMsg(err) })
    }
    return this.getState()
  }

  private async computeUnlock(): Promise<Unlock> {
    const candidates = await this.deps.candidates()
    const primary = candidates.find((c) => c.primary) ?? null
    this.configuredSource = primary?.source ?? null
    let wraps: readonly KeychainKeyRow[]
    try {
      wraps = await this.deps.repo.listKeys()
    } catch {
      return { state: 'locked', reason: 'store-unavailable' }
    }

    if (wraps.length === 0) return this.firstBoot(primary)

    let anyLoaded = false
    let primaryUnreadable = false
    for (const candidate of candidates) {
      const loaded = await candidate.load()
      if (loaded.kind === 'unreadable') {
        if (candidate.primary) primaryUnreadable = true
        this.deps.logger.warn('keychain key source unreadable', {
          source: candidate.source.kind,
          path: candidate.source.path,
          error: loaded.error,
        })
        continue
      }
      if (loaded.kind !== 'loaded') continue
      anyLoaded = true
      const fingerprint = kekFingerprint(loaded.key)
      // Active wraps first, then a retired one (a reverted configuration).
      const ordered = [...wraps].toSorted((a, b) =>
        a.state === b.state ? b.createdAt - a.createdAt : a.state === 'active' ? -1 : 1,
      )
      for (const wrap of ordered) {
        if (!constantTimeEquals(wrap.kekFingerprint, fingerprint)) continue
        const dek = unwrapDek(loaded.key, wrap.wrappedDek, wrap.keyId)
        if (dek === null) continue
        return {
          state: 'ready',
          dek,
          keyId: wrap.keyId,
          kek: loaded.key,
          fingerprint,
          source: candidate.source,
          wrap,
          rotationPending: !candidate.primary || wrap.state !== 'active',
        }
      }
    }
    if (primaryUnreadable) return { state: 'locked', reason: 'key-file-unreadable' }
    return { state: 'locked', reason: anyLoaded ? 'wrong-key' : 'key-missing' }
  }

  /** No wrapped data key yet: create one — only when nothing could be lost. */
  private async firstBoot(primary: KeySourceCandidate | null): Promise<Unlock> {
    let existing: readonly KeychainSecretRow[]
    try {
      existing = await this.deps.repo.listSecrets()
    } catch {
      return { state: 'locked', reason: 'store-unavailable' }
    }
    if (existing.length > 0) {
      // Values without a key: the keys table was lost. Generating a new key
      // would make them permanently unreadable AND look healthy.
      return { state: 'locked', reason: 'key-missing' }
    }
    if (primary === null) return { state: 'locked', reason: 'key-missing' }
    const loaded = await primary.load()
    let kek: Buffer
    if (loaded.kind === 'loaded') {
      kek = loaded.key
    } else if (loaded.kind === 'unreadable') {
      return { state: 'locked', reason: 'key-file-unreadable' }
    } else if (primary.source.kind === 'default-file') {
      kek = generateKey()
      try {
        await writeDefaultKeyFile(this.deps.dataDir, kek, { replace: false, nowMs: this.now() })
      } catch (err: unknown) {
        this.deps.logger.error('keychain master key could NOT be generated — no key stored', {
          path: primary.source.path,
          error: errMsg(err),
        })
        throw err
      }
      this.deps.logger.info('keychain master key generated', { path: primary.source.path })
    } else {
      // An operator-configured file that does not exist yet: they create it.
      return { state: 'locked', reason: 'key-missing' }
    }
    const dek = generateKey()
    const keyId = generateKeyId()
    const fingerprint = kekFingerprint(kek)
    const wrap: KeychainKeyRow = {
      wrapId: randomUUID(),
      keyId,
      wrappedDek: wrapDek(kek, dek, keyId),
      kekFingerprint: fingerprint,
      kekSource: primary.source.kind,
      createdAt: this.now(),
      state: 'active',
      recoveryDownloadedAt: null,
    }
    await this.deps.repo.putKey(wrap)
    await this.audit('initialize', 'system', null, `source=${primary.source.kind}`)
    return {
      state: 'ready',
      dek,
      keyId,
      kek,
      fingerprint,
      source: primary.source,
      wrap,
      rotationPending: false,
    }
  }

  getState(): KeychainState {
    return this.unlock.state === 'ready'
      ? { state: 'ready' }
      : { state: 'locked', reason: this.unlock.reason }
  }

  private requireReady(): Unlocked {
    if (this.unlock.state !== 'ready') throw new KeychainLockedError(this.unlock.reason)
    return this.unlock
  }

  // ── Owner rule ──────────────────────────────────────────────────────────

  /** May `caller` touch values owned by `owner`? */
  owns(caller: string | null, owner: string): boolean {
    if (caller === null) return false
    const c = normalizeSecretOwner(caller)
    const o = normalizeSecretOwner(owner)
    if (c.length === 0) return false
    if (c === o) return true
    return this.deps.runnerIdOf(o) === c
  }

  private ownerOf(ref: string, caller: string | null): string {
    const parts = parseSecretRef(ref)
    if (parts === null || !this.owns(caller, parts.owner)) {
      throw new KeychainForbiddenError(ref, caller)
    }
    return parts.owner
  }

  // ── Owner-facing (the `keychain` cap) ───────────────────────────────────

  /**
   * @param actor who the audit names — the owner addon by default; the
   *   operator (`user:<id>`) for {@link setSystemSecret}.
   */
  async put(
    caller: string | null,
    ref: string,
    value: string,
    actor: string = actorOfAddon(caller),
  ): Promise<{ ref: string; version: number }> {
    const owner = this.ownerOf(ref, caller)
    const unlocked = this.requireReady()
    if (value.length === 0)
      throw new Error('keychain.put: an empty value is not stored — delete the ref')
    const parts = parseSecretRef(ref)
    if (parts === null) throw new KeychainForbiddenError(ref, caller)
    const existing = (await this.deps.repo.getSecrets([ref])).get(ref)
    if (existing !== undefined) {
      const current = decryptValue(unlocked.dek, ref, existing.ciphertext)
      // Same value: no write, no new version — a whole-form save re-sending
      // an unchanged secret must not churn the hub's slowest resource.
      if (current !== null && constantTimeEquals(current, value)) {
        return { ref, version: existing.version }
      }
    }
    const t = this.now()
    const version = (existing?.version ?? 0) + 1
    await this.deps.repo.putSecret({
      ref,
      owner,
      scope: formatSecretScope(parts.scope),
      fieldPath: parts.fieldPath,
      ciphertext: encryptValue(unlocked.dek, unlocked.keyId, ref, value),
      keyId: unlocked.keyId,
      version,
      createdAt: existing?.createdAt ?? t,
      updatedAt: t,
      updatedBy: actor,
      lastReadAt: existing?.lastReadAt ?? null,
    })
    await this.audit('put', actor, ref, `version=${version}`)
    this.deps.events.emit({ ref, owner, version, change: 'put' })
    return { ref, version }
  }

  async resolve(caller: string | null, refs: readonly string[]): Promise<KeychainResolveResult> {
    const out: Record<string, KeychainResolveEntry> = {}
    const owned: string[] = []
    for (const ref of new Set(refs)) {
      const parts = parseSecretRef(ref)
      if (parts === null || !this.owns(caller, parts.owner)) {
        out[ref] = { kind: 'forbidden' }
        continue
      }
      owned.push(ref)
    }
    if (owned.length === 0) return out
    if (this.unlock.state !== 'ready') {
      for (const ref of owned) out[ref] = { kind: 'unavailable', reason: this.unlock.reason }
      return out
    }
    const unlocked = this.unlock
    let rows: ReadonlyMap<string, KeychainSecretRow>
    try {
      rows = await this.deps.repo.getSecrets(owned)
    } catch {
      for (const ref of owned) out[ref] = { kind: 'unavailable', reason: 'store-unavailable' }
      return out
    }
    const t = this.now()
    const stale: KeychainSecretRow[] = []
    for (const ref of owned) {
      const row = rows.get(ref)
      if (row === undefined) {
        out[ref] = { kind: 'missing' }
        continue
      }
      const value = decryptValue(unlocked.dek, ref, row.ciphertext)
      if (value === null) {
        out[ref] = { kind: 'unavailable', reason: 'decrypt-failed' }
        this.deps.logger.error('keychain value did not authenticate', { ref })
        continue
      }
      out[ref] = { kind: 'value', value, version: row.version }
      if (row.lastReadAt === null || t - row.lastReadAt >= LAST_READ_GRANULARITY_MS) stale.push(row)
    }
    if (stale.length > 0) void this.touchLastRead(stale, t)
    return out
  }

  private async touchLastRead(rows: readonly KeychainSecretRow[], at: number): Promise<void> {
    try {
      for (const row of rows) await this.deps.repo.putSecret({ ...row, lastReadAt: at })
    } catch (err: unknown) {
      this.deps.logger.warn('keychain lastReadAt not recorded', { error: errMsg(err) })
    }
  }

  async delete(caller: string | null, refs: readonly string[]): Promise<number> {
    const owners = new Map<string, string>()
    for (const ref of new Set(refs)) owners.set(ref, this.ownerOf(ref, caller))
    if (owners.size === 0) return 0
    const existing = await this.deps.repo.getSecrets([...owners.keys()])
    const present = [...owners.keys()].filter((ref) => existing.has(ref))
    if (present.length === 0) return 0
    const deleted = await this.deps.repo.deleteSecrets(present)
    for (const ref of present) {
      await this.audit('delete', actorOfAddon(caller), ref, null)
      this.deps.events.emit({ ref, owner: owners.get(ref) ?? '', version: null, change: 'delete' })
    }
    return deleted
  }

  /**
   * Delete EVERY value whose scope is `device/<deviceId>`, whatever its owner
   * (D864). A device-scoped secret is owned by the driver that declared it, so
   * the device manager — which knows only that the device is gone — cannot name
   * the owner; this is the one owner-spanning delete, and it is reserved to
   * the device manager (a removal is the only moment a whole device scope
   * stops being anybody's). Works while locked: it removes ciphertext, it
   * never reads it.
   *
   * @returns the refs removed (never values), for the caller's one log line.
   */
  async deleteDeviceScope(caller: string | null, deviceId: number): Promise<readonly string[]> {
    if (caller === null || normalizeSecretOwner(caller) !== DEVICE_SCOPE_PURGER) {
      throw new KeychainForbiddenError(`device/${deviceId}`, caller)
    }
    const scope = formatSecretScope({ kind: 'device', deviceId })
    const rows = (await this.deps.repo.listSecrets()).filter((row) => row.scope === scope)
    if (rows.length === 0) return []
    const refs = rows.map((row) => row.ref)
    await this.deps.repo.deleteSecrets(refs)
    for (const row of rows) {
      await this.audit('delete', actorOfAddon(caller), row.ref, 'device-removed')
      this.deps.events.emit({ ref: row.ref, owner: row.owner, version: null, change: 'delete' })
    }
    return refs
  }

  async listMeta(caller: string | null): Promise<readonly KeychainSecretMeta[]> {
    const rows = await this.deps.repo.listSecrets()
    return rows.filter((row) => this.owns(caller, row.owner)).map(toMeta)
  }

  // ── Operator-facing (the `keychain-admin` cap) ──────────────────────────

  async status(): Promise<KeychainStatus> {
    const wraps = await this.deps.repo.listKeys().catch(() => [])
    const secrets = await this.deps.repo.listSecrets().catch(() => [])
    const unlocked = this.unlock.state === 'ready' ? this.unlock : null
    const configured: KeychainKeySource = this.configuredSource ?? {
      kind: 'default-file',
      path: defaultKeyFilePath(this.deps.dataDir),
      sharesBackupWithDatabase: true,
    }
    return {
      keychain: this.getState(),
      keySource: unlocked?.source ?? null,
      configuredSource: configured,
      fingerprint: unlocked !== null ? shortFingerprint(unlocked.fingerprint) : null,
      activeKeyId: unlocked?.keyId ?? null,
      rotationPending: unlocked?.rotationPending ?? false,
      retiredWraps: wraps.filter((w) => w.state === 'retired').length,
      recoveryKeyDownloadedAt:
        unlocked !== null
          ? (wraps.find((w) => w.wrapId === unlocked.wrap.wrapId)?.recoveryDownloadedAt ?? null)
          : null,
      secretCount: secrets.length,
      lastReset: await this.deps.repo.latestReset().catch(() => null),
    }
  }

  async listSecrets(): Promise<readonly (KeychainSecretMeta & { usage: KeychainSecretUsage })[]> {
    const rows = await this.deps.repo.listSecrets()
    const usage = await this.deps.usage(rows).catch(() => new Map<string, KeychainSecretUsage>())
    return rows.map((row) => ({ ...toMeta(row), usage: usage.get(row.ref) ?? 'unknown' }))
  }

  /**
   * The operator replaces a system-held secret no form edits (D797) — the
   * session signing key. Stored under owner `system`, audited as the user.
   */
  async setSystemSecret(
    userId: string,
    name: SystemHeldSecretName,
    value: string,
  ): Promise<{ ref: string; version: number }> {
    const ref = SYSTEM_HELD_SECRET_REFS[name]
    return this.put(SYSTEM_SECRET_OWNER, ref, value, `user:${userId}`)
  }

  /**
   * An operator tool stores a carried-over value at a migration ref (D870):
   * restream tokens or a `recordSecretRef` row field. Stored under the ref's
   * owner, audited as the operator; never overwrites an existing value.
   */
  async importSecret(
    userId: string,
    ref: string,
    value: string,
  ): Promise<{ ref: string; version: number }> {
    // Only refs the migration may pre-seed, and never over a value that is
    // already there: an admin tool that can overwrite any addon's secret is
    // not a migration helper.
    if (!IMPORTABLE_REF.test(ref)) {
      throw new Error(
        `keychain: "${ref}" is not an importable ref (restream tokens or record row secrets)`,
      )
    }
    if ((await this.deps.repo.getSecrets([ref])).has(ref)) {
      throw new Error(`keychain: a value is already stored at ${ref} - import refuses to overwrite`)
    }
    const parts = parseSecretRef(ref)
    if (parts === null) throw new Error(`keychain: "${ref}" is not a secret ref`)
    return this.put(parts.owner, ref, value, `user:${userId}`)
  }

  async listAudit(limit: number): Promise<readonly KeychainAuditEntry[]> {
    return this.deps.repo.listAudit(limit)
  }

  async reveal(userId: string, ref: string): Promise<{ value: string; version: number }> {
    const unlocked = this.requireReady()
    const row = (await this.deps.repo.getSecrets([ref])).get(ref)
    if (row === undefined) throw new Error(`keychain: no value stored at ${ref}`)
    const value = decryptValue(unlocked.dek, ref, row.ciphertext)
    if (value === null) throw new Error(`keychain: the value at ${ref} did not authenticate`)
    await this.audit('reveal', `user:${userId}`, ref, null)
    return { value, version: row.version }
  }

  async deleteOrphans(
    userId: string,
    refs: readonly string[],
  ): Promise<{
    deleted: readonly string[]
    kept: readonly { ref: string; usage: KeychainSecretUsage }[]
  }> {
    const rows = [...(await this.deps.repo.getSecrets(refs)).values()]
    const usage = await this.deps.usage(rows)
    const deleted: string[] = []
    const kept: { ref: string; usage: KeychainSecretUsage }[] = []
    for (const row of rows) {
      const u = usage.get(row.ref) ?? 'unknown'
      if (u === 'orphan') deleted.push(row.ref)
      else kept.push({ ref: row.ref, usage: u })
    }
    if (deleted.length > 0) {
      await this.deps.repo.deleteSecrets(deleted)
      for (const ref of deleted) {
        const owner = parseSecretRef(ref)?.owner ?? ''
        this.deps.events.emit({ ref, owner, version: null, change: 'delete' })
      }
      await this.audit('delete-orphans', `user:${userId}`, null, `deleted=${deleted.length}`)
    }
    return { deleted, kept }
  }

  async downloadRecoveryKey(
    userId: string,
  ): Promise<{ key: string; fingerprint: string; keySource: KeychainKeySource }> {
    const unlocked = this.requireReady()
    const t = this.now()
    await this.deps.repo.putKey({ ...unlocked.wrap, recoveryDownloadedAt: t })
    this.unlock = { ...unlocked, wrap: { ...unlocked.wrap, recoveryDownloadedAt: t } }
    await this.audit(
      'download-recovery-key',
      `user:${userId}`,
      null,
      `source=${unlocked.source.kind}`,
    )
    return {
      key: encodeKeyMaterial(unlocked.kek),
      fingerprint: shortFingerprint(unlocked.fingerprint),
      keySource: unlocked.source,
    }
  }

  /** See `keychain-admin.rotateMasterKey`. */
  async rotateMasterKey(
    userId: string,
  ): Promise<{ fingerprint: string; keySource: KeychainKeySource }> {
    const unlocked = this.requireReady()
    const candidates = await this.deps.candidates()
    const primary = candidates.find((c) => c.primary)
    if (primary === undefined) throw new Error('keychain: no primary key source is configured')
    let newKek: Buffer
    if (unlocked.rotationPending && primary.source.kind !== unlocked.source.kind) {
      const loaded = await primary.load()
      if (loaded.kind !== 'loaded') {
        throw new Error(`keychain: the configured ${primary.source.kind} key could not be loaded`)
      }
      newKek = loaded.key
    } else if (primary.source.kind === 'default-file') {
      newKek = generateKey()
      await writeDefaultKeyFile(this.deps.dataDir, newKek, { replace: true, nowMs: this.now() })
    } else {
      throw new Error(
        `keychain: the ${primary.source.kind} key is already in use. Put the new key at its ` +
          'source, set the old one as keychain.previousKeyFile, restart, then rotate.',
      )
    }
    const fingerprint = kekFingerprint(newKek)
    if (constantTimeEquals(fingerprint, unlocked.fingerprint)) {
      throw new Error('keychain: the new master key is the one already in use')
    }
    const wrap: KeychainKeyRow = {
      wrapId: randomUUID(),
      keyId: unlocked.keyId,
      wrappedDek: wrapDek(newKek, unlocked.dek, unlocked.keyId),
      kekFingerprint: fingerprint,
      kekSource: primary.source.kind,
      createdAt: this.now(),
      state: 'active',
      recoveryDownloadedAt: null,
    }
    // New wrap first, then retire the old one: a crash between the two leaves
    // two usable wraps, never none.
    await this.deps.repo.putKey(wrap)
    for (const old of await this.deps.repo.listKeys()) {
      if (old.wrapId !== wrap.wrapId && old.state === 'active') {
        await this.deps.repo.putKey({ ...old, state: 'retired' })
      }
    }
    this.unlock = {
      state: 'ready',
      dek: unlocked.dek,
      keyId: unlocked.keyId,
      kek: newKek,
      fingerprint,
      source: primary.source,
      wrap,
      rotationPending: false,
    }
    this.configuredSource = primary.source
    await this.audit('rotate-master-key', `user:${userId}`, null, `source=${primary.source.kind}`)
    return { fingerprint: shortFingerprint(fingerprint), keySource: primary.source }
  }

  /** Delete retired wraps, and the default file's previous copies with them. */
  async purgeRetiredKeys(userId: string): Promise<number> {
    this.requireReady()
    const retired = (await this.deps.repo.listKeys()).filter((w) => w.state === 'retired')
    for (const wrap of retired) await this.deps.repo.deleteKey(wrap.wrapId)
    const dir = path.dirname(defaultKeyFilePath(this.deps.dataDir))
    try {
      for (const name of await fsp.readdir(dir)) {
        if (name.startsWith('master.key.prev-')) await fsp.rm(path.join(dir, name), { force: true })
      }
    } catch {
      /* no default directory — nothing to purge there */
    }
    await this.audit('purge-retired-keys', `user:${userId}`, null, `purged=${retired.length}`)
    return retired.length
  }

  /** Lost-key recovery from System → Secrets — see `keychain-admin.resetKeychain`. */
  async resetKeychain(
    userId: string,
  ): Promise<{ archivedCollection: string | null; archived: number }> {
    const record = await this.resetAs(`user:${userId}`)
    return { archivedCollection: record.archivedCollection, archived: record.archived }
  }

  /**
   * Start over with a new master key and a new data key.
   *
   * 1. Refuse BEFORE touching anything when the configured primary source
   *    cannot give a key (a configured file that is missing or unreadable, a
   *    desktop key that did not arrive): archiving the values and then staying
   *    locked would lose them for nothing. The default file is always usable —
   *    the reset writes a new one (the old one is kept as `master.key.prev-*`).
   * 2. Archive every value AND every wrapped data key — the archive stays
   *    openable if the lost master key turns up.
   * 3. New data key under the new master key ({@link firstBoot}).
   * 4. Clear the system-held markers (none remain since D857). The
   *    session signing key has no marker; it now resolves `missing`, and
   *    `local-auth` generates a new one (everyone signs in again).
   * 5. One `delete` event per archived ref, so every keeper reloads.
   * 6. A reset record for the Secrets page, and an audit row.
   */
  async resetAs(actor: string): Promise<KeychainResetRecord> {
    const t = this.now()
    const lockedReason = this.unlock.state === 'locked' ? this.unlock.reason : null
    const candidates = await this.deps.candidates()
    const primary = candidates.find((c) => c.primary) ?? null
    await this.assertResettable(primary)

    const archiveName = `keychain:secrets-orphaned-${t}`
    const keysArchiveName = `keychain:keys-orphaned-${t}`
    const archivedRows = await this.deps.repo.listSecrets()
    const archivedKeys = await this.deps.repo.archiveAllKeys(keysArchiveName)
    const archived = await this.deps.repo.archiveAllSecrets(archiveName)
    for (const wrap of await this.deps.repo.listKeys()) await this.deps.repo.deleteKey(wrap.wrapId)
    if (primary?.source.kind === 'default-file') {
      const loaded = await primary.load()
      if (loaded.kind !== 'absent') {
        await writeDefaultKeyFile(this.deps.dataDir, generateKey(), { replace: true, nowMs: t })
      }
    }
    this.unlock = await this.firstBoot(primary)
    const clearedSettingsKeys = await this.deps.repo.clearSystemSettingsKeys(
      SYSTEM_SECRET_SETTINGS_KEYS,
    )
    for (const row of archivedRows) {
      this.deps.events.emit({ ref: row.ref, owner: row.owner, version: null, change: 'delete' })
    }
    const record: KeychainResetRecord = {
      id: randomUUID(),
      at: t,
      actor,
      lockedReason,
      archived,
      archivedCollection: archived > 0 ? archiveName : null,
      archivedKeysCollection: archivedKeys > 0 ? keysArchiveName : null,
      clearedSettingsKeys,
      acknowledgedAt: null,
    }
    await this.deps.repo.putReset(record)
    await this.audit(
      'reset',
      actor,
      null,
      `archived=${archived} lockedReason=${lockedReason ?? 'none'} cleared=${clearedSettingsKeys.join(',') || 'none'}`,
    )
    return record
  }

  /** Throws {@link KeychainResetRefusedError} when no new master key could be had. */
  private async assertResettable(primary: KeySourceCandidate | null): Promise<void> {
    if (primary === null) throw new KeychainResetRefusedError('no key source is configured')
    if (primary.source.kind === 'default-file') return
    const loaded = await primary.load()
    if (loaded.kind === 'loaded') return
    const where = primary.source.path ?? primary.source.kind
    throw new KeychainResetRefusedError(
      loaded.kind === 'absent'
        ? `the configured master key ${where} does not exist — put a new 32-byte key there (or remove keychain.keyFile to use the default file) first`
        : `the configured master key ${where} cannot be read (${loaded.error})`,
    )
  }

  /** What the last reset left to re-enter (see `keychain-admin.resetReport`). */
  async resetReport(): Promise<{
    reset: KeychainResetRecord | null
    pendingReentry: readonly KeychainSecretMeta[]
  }> {
    const reset = await this.deps.repo.latestReset()
    if (reset === null || reset.archivedCollection === null) {
      return { reset, pendingReentry: [] }
    }
    const archived = await this.deps.repo.listArchivedSecrets(reset.archivedCollection)
    const live = await this.deps.repo.getSecrets(archived.map((r) => r.ref))
    const pendingReentry = archived
      .filter((r) => !live.has(r.ref) && !PROCESS_HELD_SECRET_REFS.has(r.ref))
      .map(toMeta)
    return { reset, pendingReentry }
  }

  async acknowledgeReset(userId: string): Promise<{ acknowledged: boolean }> {
    const reset = await this.deps.repo.latestReset()
    if (reset === null || reset.acknowledgedAt !== null) return { acknowledged: false }
    await this.deps.repo.putReset({ ...reset, acknowledgedAt: this.now() })
    await this.audit('acknowledge-reset', `user:${userId}`, null, `reset=${reset.id}`)
    return { acknowledged: true }
  }

  // ── Audit ───────────────────────────────────────────────────────────────

  private async audit(
    action: KeychainAuditAction,
    actor: string,
    ref: string | null,
    detail: string | null,
  ): Promise<void> {
    try {
      await this.deps.repo.appendAudit({
        id: randomUUID(),
        at: this.now(),
        action,
        actor,
        ref,
        detail,
      })
    } catch (err: unknown) {
      this.deps.logger.warn('keychain audit row not written', { action, ref, error: errMsg(err) })
    }
  }

  /** Daily ring prune, driven by the addon's timer. */
  async pruneAudit(): Promise<void> {
    await this.deps.repo.pruneAudit(this.now())
  }
}

function toMeta(row: KeychainSecretRow): KeychainSecretMeta {
  return {
    ref: row.ref,
    owner: row.owner,
    scope: row.scope,
    fieldPath: row.fieldPath,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    lastReadAt: row.lastReadAt,
  }
}

function actorOfAddon(caller: string | null): string {
  return caller === null ? 'system' : `addon:${normalizeSecretOwner(caller)}`
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The event the provider emits — exported for the addon's bus adapter. */
export const KEYCHAIN_CHANGED: KnownEventCategory = EventCategory.KeychainChanged
