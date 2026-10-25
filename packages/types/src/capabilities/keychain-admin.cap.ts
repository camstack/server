import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { KeychainSecretMetaSchema, KeychainStateSchema } from './keychain.cap.js'

/**
 * `keychain-admin` — the operator's view of the keychain (System → Secrets).
 *
 * Every method is `admin`. Two methods hand out material, each audited and
 * each named for exactly that: {@link keychainAdminCapability.methods.reveal}
 * (one value, shown briefly by the UI) and `downloadRecoveryKey` (the master
 * key itself, so the operator can keep a copy off the hub). Nothing else
 * returns a value.
 *
 * The master key's LOCATION is configuration, never an env var (D788):
 * `keychain.keyFile` in `config.yaml`, the OS keychain on a desktop hub, else
 * `<dataDir>/.keychain/master.key` — which sits beside the database in every
 * whole-volume backup, and the status says so.
 */

/** Where the master key in use came from. */
export const KeychainKeySourceKindSchema = z.enum([
  /** `keychain.keyFile` in config.yaml. */
  'config-file',
  /** `keychain.previousKeyFile` — kept only until a rotation moves off it. */
  'previous-config-file',
  /** The desktop app's OS keychain (Electron `safeStorage`). */
  'platform',
  /** `<dataDir>/.keychain/master.key`. */
  'default-file',
])
export type KeychainKeySourceKind = z.infer<typeof KeychainKeySourceKindSchema>

export const KeychainKeySourceSchema = z.object({
  kind: KeychainKeySourceKindSchema,
  /** File sources only — a path is not a secret. */
  path: z.string().optional(),
  /**
   * True when a whole-volume backup of the data directory carries this key
   * next to the database it protects (the default file). The page warns.
   */
  sharesBackupWithDatabase: z.boolean(),
})
export type KeychainKeySource = z.infer<typeof KeychainKeySourceSchema>

/**
 * Who reset the keychain: an operator from System → Secrets (`user:<id>`), or
 * the one-shot `<dataDir>/.keychain/RESET_KEYCHAIN` trigger file at boot
 * (`trigger-file`) — the only way back into a hub whose master key is lost,
 * because a locked keychain leaves no session that could reach the page (D797).
 */
export const KEYCHAIN_RESET_TRIGGER_ACTOR = 'trigger-file'

/**
 * One keychain reset, as the Secrets page reports it until the operator
 * acknowledges it. Never a value: refs, counts and table names only.
 */
export const KeychainResetRecordSchema = z.object({
  id: z.string(),
  at: z.number(),
  /** `user:<id>` or {@link KEYCHAIN_RESET_TRIGGER_ACTOR}. */
  actor: z.string(),
  /** Why the keychain was locked when it was reset; `null` when it was not locked. */
  lockedReason: z.string().nullable(),
  /** Values moved into the archive table (ciphertext under the lost key). */
  archived: z.number().int(),
  /** `keychain:secrets-orphaned-<ts>`, or `null` when nothing was stored. */
  archivedCollection: z.string().nullable(),
  /**
   * `keychain:keys-orphaned-<ts>`: the wrapped data keys of the archive, kept
   * so the archive can still be opened if the lost master key turns up.
   */
  archivedKeysCollection: z.string().nullable(),
  /**
   * `system-settings` keys whose marker the reset cleared — the cluster
   * secret's: a marker left pointing at an archived value would refuse every
   * agent forever (D797).
   */
  clearedSettingsKeys: z.array(z.string()).readonly(),
  /** When an operator dismissed the notice on the Secrets page; `null` until then. */
  acknowledgedAt: z.number().nullable(),
})
export type KeychainResetRecord = z.infer<typeof KeychainResetRecordSchema>

export const KeychainStatusSchema = z.object({
  keychain: KeychainStateSchema,
  /** The source of the master key in use; `null` while locked. */
  keySource: KeychainKeySourceSchema.nullable(),
  /** The source configured to be primary — differs from `keySource` while a rotation is pending. */
  configuredSource: KeychainKeySourceSchema,
  /** Short fingerprint of the master key in use (`HMAC(KEK, label)`, 16 hex). */
  fingerprint: z.string().nullable(),
  activeKeyId: z.string().nullable(),
  /**
   * The keychain unlocked with a NON-primary source: the configured primary
   * key is not the one that wraps the data key yet. `rotateMasterKey` moves it.
   */
  rotationPending: z.boolean(),
  /** Wrapped copies of the data key under a previous master key, kept until purged. */
  retiredWraps: z.number().int(),
  recoveryKeyDownloadedAt: z.number().nullable(),
  secretCount: z.number().int(),
  /** The most recent reset, acknowledged or not; `null` when the keychain was never reset. */
  lastReset: KeychainResetRecordSchema.nullable(),
})
export type KeychainStatus = z.infer<typeof KeychainStatusSchema>

/**
 * Whether a stored value is still pointed at by its owner's settings.
 * `unknown` is a first-class answer: a scope whose blob could not be read is
 * never reported as an orphan (and never deleted as one).
 */
export const KeychainSecretUsageSchema = z.enum(['in-use', 'orphan', 'unknown'])
export type KeychainSecretUsage = z.infer<typeof KeychainSecretUsageSchema>

export const KeychainAdminSecretSchema = KeychainSecretMetaSchema.extend({
  usage: KeychainSecretUsageSchema,
})
export type KeychainAdminSecret = z.infer<typeof KeychainAdminSecretSchema>

export const KeychainAuditActionSchema = z.enum([
  'put',
  'delete',
  'reveal',
  'rotate-master-key',
  'purge-retired-keys',
  'download-recovery-key',
  'delete-orphans',
  'reset',
  'acknowledge-reset',
  'initialize',
])
export type KeychainAuditAction = z.infer<typeof KeychainAuditActionSchema>

export const KeychainAuditEntrySchema = z.object({
  id: z.string(),
  at: z.number(),
  action: KeychainAuditActionSchema,
  /** `addon:<id>` | `user:<id>` | `system` | `trigger-file`. */
  actor: z.string(),
  ref: z.string().nullable(),
  detail: z.string().nullable(),
})
export type KeychainAuditEntry = z.infer<typeof KeychainAuditEntrySchema>

export const KEYCHAIN_RESET_CONFIRMATION = 'RESET KEYCHAIN'

/**
 * Secrets the HUB itself holds (owner `system`) that no settings form shows:
 * `jwt-signing-key` — the session signing key (D797). It is always "in use",
 * never an orphan; it is generated on a fresh hub and replaced only through
 * {@link keychainAdminCapability.methods.setSystemSecret}.
 */
export const SystemHeldSecretNameSchema = z.enum(['jwt-signing-key'])
export type SystemHeldSecretName = z.infer<typeof SystemHeldSecretNameSchema>

export const keychainAdminCapability = {
  name: 'keychain-admin',
  scope: 'system',
  mode: 'singleton',
  methods: {
    status: method(z.object({}), KeychainStatusSchema, { auth: 'admin' }),
    listSecrets: method(z.object({}), z.array(KeychainAdminSecretSchema).readonly(), {
      auth: 'admin',
    }),
    listAudit: method(
      z.object({ limit: z.number().int().min(1).max(500).optional() }),
      z.array(KeychainAuditEntrySchema).readonly(),
      { auth: 'admin' },
    ),
    /**
     * Show one value to the operator. Audited. The UI hides it again after a
     * few seconds; nothing caches it.
     */
    reveal: method(
      z.object({ ref: z.string().min(1) }),
      z.object({ value: z.string(), version: z.number().int() }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),
    /**
     * Replace a system-held secret (no form edits it) with an operator-supplied
     * value — e.g. importing the session signing key a pre-keychain hub kept in
     * config.yaml, so the tokens it signed stay valid. Audited as the operator.
     * Replacing the session signing key invalidates every token signed with the
     * previous one.
     */
    setSystemSecret: method(
      z.object({ name: SystemHeldSecretNameSchema, value: z.string().min(16) }),
      z.object({ ref: z.string(), version: z.number().int() }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),
    /**
     * Store a value an operator tool carries over from a retired store at an
     * addon's own ref (`secret://<owner>/<scope>/<path>`) and answer the ref -
     * the D870 migration moves a camera's restream tokens this way, so they
     * never sit in a settings row as plaintext. Audited as the operator; the
     * caller then writes the MARKER of the ref where the value used to be.
     */
    importSecret: method(
      z.object({ ref: z.string().min(1), value: z.string().min(1) }),
      z.object({ ref: z.string(), version: z.number().int() }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),
    /** Delete refs no owner points at any more. Re-checked here; `unknown` is kept. */
    deleteOrphans: method(
      z.object({ refs: z.array(z.string().min(1)).max(1000) }),
      z.object({
        deleted: z.array(z.string()).readonly(),
        kept: z.array(z.object({ ref: z.string(), usage: KeychainSecretUsageSchema })).readonly(),
      }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),
    /**
     * Wrap the data key under the configured primary master key.
     *
     * Pending rotation (the keychain unlocked with a previous source): re-wrap
     * under the primary. Otherwise, with the default file as primary: generate
     * a new master key, write it there, re-wrap. A file or OS-keychain primary
     * that is already in use cannot be replaced from here — put the new key at
     * the source, keep the old one as `keychain.previousKeyFile`, restart, and
     * rotate. No value is re-encrypted either way; the previous wrap is kept
     * (retired) until purged.
     */
    rotateMasterKey: method(
      z.object({}),
      z.object({ fingerprint: z.string(), keySource: KeychainKeySourceSchema }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),
    purgeRetiredKeys: method(z.object({}), z.object({ purged: z.number().int() }), {
      kind: 'mutation',
      auth: 'admin',
      caller: 'required',
    }),
    /** The master key, base64. Audited; marks the recovery copy as taken. */
    downloadRecoveryKey: method(
      z.object({}),
      z.object({ key: z.string(), fingerprint: z.string(), keySource: KeychainKeySourceSchema }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),
    /**
     * Lost-key recovery: archive every stored value into a
     * `keychain:secrets-orphaned-<ts>` table and start over with a new data
     * key. Every secret field then reads "not set". Requires the typed
     * confirmation {@link KEYCHAIN_RESET_CONFIRMATION}.
     */
    resetKeychain: method(
      z.object({ confirm: z.literal(KEYCHAIN_RESET_CONFIRMATION) }),
      z.object({ archivedCollection: z.string().nullable(), archived: z.number().int() }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),
    /**
     * What the last reset left to re-enter: the archived refs (owner, scope,
     * field — never a value) that hold no value again yet. Process-held refs
     * the hub regenerates itself (the session signing key) are not listed.
     */
    resetReport: method(
      z.object({}),
      z.object({
        reset: KeychainResetRecordSchema.nullable(),
        pendingReentry: z.array(KeychainSecretMetaSchema).readonly(),
      }),
      { auth: 'admin' },
    ),
    /** Dismiss the "keychain was reset" notice. Audited. */
    acknowledgeReset: method(z.object({}), z.object({ acknowledged: z.boolean() }), {
      kind: 'mutation',
      auth: 'admin',
      caller: 'required',
    }),
  },
} as const satisfies CapabilityDefinition

export type IKeychainAdminProvider = InferProvider<typeof keychainAdminCapability>
