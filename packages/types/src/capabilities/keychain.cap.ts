import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * `keychain` — the hub's encrypted store of secret values (D787).
 *
 * Settings blobs never hold a secret: they hold a marker
 * `{"$secret":"secret://<owner>/<scope>/<fieldPath>","v":1}` and the value
 * lives here, AES-256-GCM under a data key that a master key wraps. This cap
 * is the OWNER's door to its own values: every method is owner-checked
 * against the CALLER, never against anything the caller claims.
 *
 * Who the caller is: the transport stamps `callerAddonId` into the args of a
 * call that crossed a process (the parent `LocalChildRegistry` from the UDS
 * connection, the agent from its child's connection carried in
 * `$hub-cap-fwd`'s envelope). A stamp always overwrites; a wire call with no
 * stamp has its claim stripped. Only a hub in-process caller may state its own
 * identity — `ctx.secrets` does that with the addon id closed over. This is
 * identity against BUGS and misrouting, not against a malicious addon (every
 * runner is the same OS user): see the threat model in
 * `docs/design/2026-10-08-secrets-keychain.md`.
 *
 * `callerAddonId` is deliberately NOT in any input schema: the tRPC router
 * parses the input, so a session can never supply it, and the internal mount
 * floors every method to admin anyway (D240).
 *
 * Internal: addons reach it through `ctx.secrets`, never directly.
 */

/** Why a value cannot be served right now. Never folded into "missing". */
export const KeychainUnavailableReasonSchema = z.enum([
  /** No master key could be loaded from any configured source. */
  'key-missing',
  /** A master key loaded, but it is not the one that wrapped the data key. */
  'wrong-key',
  /** The configured key file exists but could not be read or parsed. */
  'key-file-unreadable',
  /** The keychain tables could not be read. */
  'store-unavailable',
  /** The provider has not finished booting. */
  'not-initialized',
  /** The value's ciphertext did not authenticate under the data key. */
  'decrypt-failed',
])
export type KeychainUnavailableReason = z.infer<typeof KeychainUnavailableReasonSchema>

export const KeychainStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready') }),
  z.object({ state: z.literal('locked'), reason: KeychainUnavailableReasonSchema }),
])
export type KeychainState = z.infer<typeof KeychainStateSchema>

export const KeychainResolveEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.string(), version: z.number().int() }),
  z.object({ kind: z.literal('missing') }),
  z.object({ kind: z.literal('unavailable'), reason: KeychainUnavailableReasonSchema }),
  /** The caller does not own this ref. */
  z.object({ kind: z.literal('forbidden') }),
])
export type KeychainResolveEntry = z.infer<typeof KeychainResolveEntrySchema>

export const KeychainResolveResultSchema = z.record(z.string(), KeychainResolveEntrySchema)
export type KeychainResolveResult = z.infer<typeof KeychainResolveResultSchema>

/** Metadata of one stored value — never the value. */
export const KeychainSecretMetaSchema = z.object({
  ref: z.string(),
  owner: z.string(),
  /** Formatted scope (`global`, `node/<id>`, `device/<id>`, …). */
  scope: z.string(),
  fieldPath: z.string(),
  version: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** `addon:<id>` | `user:<id>` | `system`. */
  updatedBy: z.string(),
  /** Coarse — written at most once an hour per ref. `null` = never read. */
  lastReadAt: z.number().nullable(),
})
export type KeychainSecretMeta = z.infer<typeof KeychainSecretMetaSchema>

/** A batch bound: one `resolveConfig` resolves every marker of one blob at once. */
export const KEYCHAIN_MAX_REFS_PER_CALL = 512

const RefListSchema = z.array(z.string().min(1)).max(KEYCHAIN_MAX_REFS_PER_CALL)

export const keychainCapability = {
  name: 'keychain',
  scope: 'system',
  mode: 'singleton',
  internal: true,
  methods: {
    /** Store (or replace) the caller's value at `ref`. Refused while locked. */
    put: method(
      z.object({ ref: z.string().min(1), value: z.string().min(1) }),
      z.object({ ref: z.string(), version: z.number().int() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Resolve the caller's refs in one round-trip. A locked keychain answers
     * `unavailable` per ref — never `missing`, never an empty value.
     */
    resolve: method(z.object({ refs: RefListSchema }), KeychainResolveResultSchema, {
      auth: 'admin',
    }),
    /** Remove the caller's refs. Unknown refs are ignored. */
    delete: method(z.object({ refs: RefListSchema }), z.object({ deleted: z.number().int() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Delete every value scoped `device/<deviceId>`, whatever its owner (D864).
     * Reserved to `device-manager`, on the device-removed path: a driver's
     * device-scoped secret is not anybody's once the device is gone. Answers the
     * refs removed (never values).
     */
    deleteDeviceScope: method(
      z.object({ deviceId: z.number().int() }),
      z.object({ refs: z.array(z.string()).readonly() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** The caller's own refs, metadata only. */
    listMeta: method(z.object({}), z.array(KeychainSecretMetaSchema).readonly(), {
      auth: 'admin',
    }),
    /** Whether values can be served — the save path refuses a write while locked. */
    getState: method(z.object({}), KeychainStateSchema, { auth: 'admin' }),
  },
} as const satisfies CapabilityDefinition

export type IKeychainProvider = InferProvider<typeof keychainCapability>
