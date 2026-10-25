/**
 * Profile store over the `llm-profiles` and `llm-meta` record kinds.
 *
 * A profile is common fields + `providerConfig` (D893); the row keeps the same
 * shape minus the kind's ONE secret field, which lives in the row's keychain
 * slot (`apiKey`, `.meta({ secret: true })`). This store moves the value
 * between the two: `providerConfig[secretFieldOf(kind)]` ↔ the slot. The
 * records facade writes the value to the keychain FIRST and the row holds only
 * a marker bound to its own ref, so this store never sees a marker, never
 * builds a ref and never decides what is a secret (D878, D879). A read shows the
 * redaction token; this store asks for the value (`resolveSecrets`) because the
 * provider needs it for a call, and the provider redacts again for the wire
 * (secrets.ts).
 *
 * A key the keychain cannot serve right now is left off the profile and
 * reported by `lockedReason`, so a call fails explicitly instead of going out
 * unauthenticated. Invalid rows are dropped on read (`LlmProfileSchema.safeParse`).
 * A row still in the flat pre-D893 shape is read through `migrateProfileBody`
 * and rewritten by `migrateLegacyRows` (boot).
 */
import {
  type IScopedLogger,
  type LlmProfile,
  LlmProfileSchema,
  type RawSecretMigrationReport,
  type RecordKindHandle,
  type RecordRow,
  type RecordsAccess,
  RecordSecretUnavailableError,
  REDACTED_SECRET,
} from '@camstack/types'
import { secretFieldOf } from './kinds/provider-config.js'
import { migrateProfileBody } from './profile-migration.js'
import { aiRecordKinds, type LlmMetaBody, type LlmProfileBody } from './record-kinds.js'
import { readAllRows } from './record-pages.js'

/** Legacy collection names — kept for the adoption mappers / docs. */
export const PROFILES_COLLECTION = 'ai:llm-profiles'
export const META_COLLECTION = 'ai:llm-meta'
export const SEED_PROFILE_ID = 'seed-ollama-lan'
const SEED_MARKER_ID = 'seededDefaults'

/** Why the API key of a profile cannot be used right now. */
export type KeyLockReason = string

/** The key could not be stored: refused, never written as plaintext. */
export class ApiKeyStorageUnavailableError extends Error {
  constructor(
    readonly profileId: string,
    reason: string,
  ) {
    super(
      `the API key of profile "${profileId}" cannot be stored: ${reason}. ` +
        'Unlock the keychain (System -> Secrets) and save again.',
    )
    this.name = 'ApiKeyStorageUnavailableError'
  }
}

/** A row with its key resolved (or the reason it could not be). */
interface ProfileRead {
  readonly id: string
  readonly body: LlmProfileBody
  /** The key is set in the row (resolved or not). */
  readonly hasKey: boolean
  readonly key?: string
  readonly lock?: KeyLockReason
}

function withoutKey(body: Record<string, unknown>): Record<string, unknown> {
  const { apiKey: _drop, ...rest } = body
  return rest
}

function providerConfigOf(body: Record<string, unknown>): Record<string, unknown> {
  const config = body.providerConfig
  return typeof config === 'object' && config !== null && !Array.isArray(config)
    ? { ...config }
    : {}
}

/** The kind's secret field, out of a `providerConfig`: `[the bag without it, its value]`. */
function splitSecret(
  kind: string,
  config: Record<string, unknown>,
): readonly [Record<string, unknown>, unknown] {
  const field = secretFieldOf(kind)
  if (field === null) return [config, undefined]
  const { [field]: secret, ...rest } = config
  return [rest, secret]
}

function toProfile(read: ProfileRead): LlmProfile | null {
  const { body } = migrateProfileBody({ ...read.body })
  const kind = typeof body.kind === 'string' ? body.kind : ''
  const [config] = splitSecret(kind, providerConfigOf(body))
  const field = secretFieldOf(kind)
  const parsed = LlmProfileSchema.safeParse({
    ...withoutKey(body),
    id: read.id,
    providerConfig:
      field !== null && read.key !== undefined ? { ...config, [field]: read.key } : config,
  })
  return parsed.success ? parsed.data : null
}

export class ProfileStore {
  /** profileId -> why its key is unusable, from the latest read of that profile. */
  private readonly locked = new Map<string, KeyLockReason>()

  constructor(
    private readonly profiles: RecordKindHandle<LlmProfileBody>,
    private readonly meta: RecordKindHandle<LlmMetaBody>,
    private readonly logger?: IScopedLogger,
  ) {}

  static of(records: Pick<RecordsAccess, 'kind'>, logger?: IScopedLogger): ProfileStore {
    return new ProfileStore(
      records.kind(aiRecordKinds['llm-profiles']),
      records.kind(aiRecordKinds['llm-meta']),
      logger,
    )
  }

  /** Why this profile's key cannot be used right now; `null` = usable (or none). */
  lockedReason(profileId: string): KeyLockReason | null {
    return this.locked.get(profileId) ?? null
  }

  /** A row whose keychain value was served: the key is resolved. */
  private served(row: RecordRow<LlmProfileBody>): ProfileRead {
    const key = row.data.apiKey
    return {
      id: row.id,
      body: row.data,
      hasKey: key !== undefined,
      ...(key === undefined ? {} : { key }),
    }
  }

  /** A row whose key the keychain could not serve: a LOCK on that profile, never an empty key. */
  private lockedRow(row: RecordRow<LlmProfileBody>, reason: KeyLockReason): ProfileRead {
    return { id: row.id, body: row.data, hasKey: true, lock: reason }
  }

  private remember(reads: readonly ProfileRead[]): ProfileRead[] {
    for (const read of reads) {
      if (read.lock !== undefined) this.locked.set(read.id, read.lock)
      else this.locked.delete(read.id)
    }
    return [...reads]
  }

  /** Every row with its key resolved; a row the keychain cannot serve is locked alone. */
  private async readAll(): Promise<ProfileRead[]> {
    try {
      const rows = await readAllRows(this.profiles, {}, { resolveSecrets: true })
      return this.remember(rows.map((row) => this.served(row)))
    } catch (err: unknown) {
      if (!(err instanceof RecordSecretUnavailableError)) throw err
    }
    // At least one key cannot be served: say which, and serve the others.
    const rows = await readAllRows(this.profiles)
    return this.remember(await Promise.all(rows.map((row) => this.readOne(row))))
  }

  private async readOne(row: RecordRow<LlmProfileBody>): Promise<ProfileRead> {
    if (row.data.apiKey === undefined) return this.served(row)
    try {
      const resolved = await this.profiles.getResolved(row.id)
      return resolved === null ? this.lockedRow(row, 'the row is gone') : this.served(resolved)
    } catch (err: unknown) {
      if (err instanceof RecordSecretUnavailableError) return this.lockedRow(row, err.message)
      throw err
    }
  }

  /** Profiles with the key RESOLVED (secrets.ts redacts for the wire); invalid rows dropped. */
  async list(): Promise<LlmProfile[]> {
    return (await this.readAll()).flatMap((read) => {
      const profile = toProfile(read)
      return profile === null ? [] : [profile]
    })
  }

  async getById(id: string): Promise<LlmProfile | null> {
    const row = await this.profiles.get(id)
    if (row === null) return null
    const [read] = this.remember([await this.readOne(row)])
    return read === undefined ? null : toProfile(read)
  }

  /**
   * Save a profile. A non-empty secret field (`providerConfig[secretFieldOf(kind)]`)
   * goes to the keychain FIRST (the facade) and the row gets the marker; a
   * locked keychain refuses the whole save. No secret removes the stored key
   * (and its keychain value). `keepStoredKey` leaves the row's stored key
   * exactly as it is - for a save that carried no new key while the stored one
   * cannot be read.
   */
  async upsert(
    profile: LlmProfile,
    opts: { readonly keepStoredKey?: boolean } = {},
  ): Promise<void> {
    const { id, providerConfig, ...rest } = profile
    const [config, secret] = splitSecret(profile.kind, providerConfig)
    const common: LlmProfileBody = { ...rest, providerConfig: config }
    let data: LlmProfileBody = common
    if (opts.keepStoredKey === true) {
      const stored = await this.profiles.get(id)
      if (stored?.data.apiKey !== undefined) data = { ...common, apiKey: REDACTED_SECRET }
    } else if (typeof secret === 'string' && secret.length > 0) {
      data = { ...common, apiKey: secret }
    }
    try {
      await this.profiles.put({ id, data })
    } catch (err: unknown) {
      if (err instanceof RecordSecretUnavailableError) {
        throw new ApiKeyStorageUnavailableError(id, err.message)
      }
      throw err
    }
    this.locked.delete(id)
  }

  async delete(id: string): Promise<void> {
    await this.profiles.delete(id)
    this.locked.delete(id)
  }

  /**
   * Rewrite every row still in the flat pre-D893 shape (boot, idempotent).
   *
   * The body is read UNRESOLVED and written back with its secret slot as the
   * redaction token, which the facade answers by keeping the stored marker: a
   * key is never read, copied or re-written to do this, so a locked keychain
   * does not stop it. Returns how many rows were rewritten.
   */
  async migrateLegacyRows(): Promise<number> {
    const rows = await readAllRows(this.profiles)
    let migrated = 0
    for (const row of rows) {
      const { body, changed } = migrateProfileBody({ ...row.data })
      if (!changed) continue
      const kind = typeof body.kind === 'string' ? body.kind : ''
      const [config] = splitSecret(kind, providerConfigOf(body))
      const parsed = LlmProfileSchema.omit({ id: true }).safeParse({
        ...withoutKey(body),
        providerConfig: config,
      })
      if (!parsed.success) {
        // Left exactly as it was: the read path still migrates it on the fly,
        // and a row nothing can parse is dropped on read either way.
        this.logger?.warn('addon-ai: a flat LLM profile row does not parse; left as is', {
          meta: { profileId: row.id, error: parsed.error.message },
        })
        continue
      }
      const data: LlmProfileBody =
        row.data.apiKey !== undefined ? { ...parsed.data, apiKey: REDACTED_SECRET } : parsed.data
      await this.profiles.put({ id: row.id, data })
      migrated += 1
    }
    if (migrated > 0) {
      this.logger?.info('addon-ai: LLM profiles moved to providerConfig', {
        meta: { migrated, rows: rows.length },
      })
    }
    return migrated
  }

  /**
   * D878 operator migration, kept for the cap method. A record never holds a
   * plaintext key (the engine refuses one), so there is nothing to move: the
   * report only says how many rows carry a key and whether each can be served.
   * Counts only.
   */
  async migrateRawKeys(apply: boolean): Promise<RawSecretMigrationReport> {
    const reads = await this.readAll()
    const markers = reads.filter((r) => r.hasKey).length
    const unresolvedMarkers = reads.filter((r) => r.lock !== undefined).length
    return {
      apply,
      rows: reads.length,
      raw: 0,
      markers,
      migrated: 0,
      failed: 0,
      remainingRaw: 0,
      unresolvedMarkers,
      verified: unresolvedMarkers === 0,
    }
  }

  /** Idempotent template seed (spec §2): one DISABLED LAN-Ollama example,
   *  guarded by a marker so a deleted seed never re-appears. */
  async ensureSeeded(): Promise<void> {
    if ((await this.meta.get(SEED_MARKER_ID)) !== null) return
    // Parsed, not written literally: every bound and policy field carries a
    // schema default, and the seed must acquire them the same way an operator's
    // profile does. A hand-written literal here silently drifts from the schema.
    await this.upsert(
      LlmProfileSchema.parse({
        id: SEED_PROFILE_ID,
        name: 'LAN Ollama (example)',
        kind: 'openai-compatible',
        addonId: 'ai',
        enabled: false, // discoverability hint, not a working profile (spec §2)
        model: 'llama3.2:3b',
        providerConfig: { baseUrl: 'http://ollama.lan:11434/v1' },
        supportsVision: false,
      }),
    )
    await this.meta.put({ id: SEED_MARKER_ID, data: { at: Date.now() } })
  }
}
