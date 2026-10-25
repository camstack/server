import { z } from 'zod'
import type { StorageLocationMode } from './storage-location-mode.js'
import { mayWriteToLocation, StorageLocationModeSchema } from './storage-location-mode.js'

/**
 * `StorageLocationType` — an addon-declared id that identifies the *kind* of
 * storage a location serves. Defined here (not in `capabilities/storage.cap.ts`)
 * so the persisted record schema and the consumer-facing cap can both consume it
 * without forming a circular import. The `storage` cap re-exports it
 * verbatim for back-compat.
 *
 * This Zod schema is the **authoritative source** for `StorageLocationType`.
 * The TS alias in `./storage.ts` re-exports `z.infer<typeof
 * StorageLocationTypeSchema>` so the wire surface (cap) and the legacy
 * `IStorageProvider` interface stay in lockstep.
 *
 * The type is now an **open string** (not a closed enum) — addons declare
 * their own location kinds via `StorageLocationDeclaration.id`. The regex
 * enforces a safe id format: lowercase-start, alphanumeric + hyphens.
 */
export const StorageLocationTypeSchema = z.string().regex(/^[a-z][a-zA-Z0-9-]*$/)

/**
 * `StorageLocationType` — TS alias for the open string schema above (`string`).
 * Re-exported by `./storage.ts` so the legacy `IStorageProvider` interface
 * keeps the same name without duplicating the schema.
 */
export type StorageLocationType = z.infer<typeof StorageLocationTypeSchema>

/**
 * Persisted record for a storage location instance. Operators can register
 * multiple instances for multi-cardinality types (e.g. two `backups`
 * locations with different `providerId`s). Cardinality is now declared per
 * location via `StorageLocationDeclaration.cardinality` — the static
 * `STORAGE_LOCATION_CARDINALITY` map has been removed.
 *
 * `id` is a stable namespaced string of the form `<type>:<slug>`.
 * The seed names its first instance `<type>:default` — a NAME, not a flag.
 * There is no default location any more (D383): `enabled` is the whole write
 * model, and a bare type ref resolves to the sole location of the type, or —
 * transitionally, only while legacy NULL-stamped rows exist — to the row whose
 * slug is `default`.
 *
 * `isSystem` is a legacy persisted flag. Seed still creates the initial
 * `<type>:default` locations; the flag is no longer a lock, a badge, or a
 * prune selector. New writes leave it false. Deletion is gated on uniqueness
 * / last-enabled, not on this bit.
 */
export const StorageLocationSchema = z.object({
  id: z.string().regex(/^[a-z][a-zA-Z0-9-]*:[a-zA-Z0-9-]+$/),
  // Open string — the location's *kind* is an addon-declared id matching
  // `StorageLocationDeclaration.id`. All built-in ids are valid plain
  // strings, and addon-declared ids are admitted without schema changes.
  type: z.string(),
  displayName: z.string().min(1),
  providerId: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  /**
   * Cluster node this location physically lives on. REQUIRED for node-local
   * providers (filesystem — the path exists on one node's disk), null/absent
   * for node-agnostic providers (S3/SFTP/WebDAV, reachable from any node).
   * `'hub'` is the hub node. Validated against the provider's `nodeLocal`
   * flag at upsert time, not here (the schema is provider-agnostic).
   */
  nodeId: z.string().optional(),
  isSystem: z.boolean().default(false),
  /**
   * THE write switch, and the only one (D383). `enabled: true` means every
   * consumer that chooses a write target for this type may write here, and all
   * enabled locations of a type are used TOGETHER; `false` means read-only —
   * still read, still played back, still age-swept, still drained, never
   * written.
   *
   * OPTIONAL only for the wire: an upsert that omits it means "leave what is
   * stored" on an update and "born inert unless it is the first location of its
   * type" on a create. On a PERSISTED row absence is legacy and it means
   * enabled — {@link isLocationEnabled} is the one place that says so, and the
   * orchestrator stamps every flagless row `true` once at hydrate so absence
   * stops existing rather than being re-derived on every read.
   */
  enabled: z.boolean().optional(),
  /**
   * THE state of this location (D385), and the only authority on what may be
   * written, read or evicted here. Interpreted in exactly one place —
   * `storage-location-mode.ts` — which also folds the legacy
   * `enabled` / `config.readOnly` pair into a mode so an old row is never
   * ambiguous.
   *
   * OPTIONAL only for the wire and for rows written before D385: absence is
   * resolved by `resolveLocationMode`, and the orchestrator stamps every
   * unstamped row ONCE at hydrate so absence stops existing rather than being
   * re-derived on every read. `enabled` survives one release as a DERIVED
   * mirror (`mode === 'active'`); `withLocationMode` is the only writer of
   * either, so the two cannot disagree.
   */
  mode: StorageLocationModeSchema.optional(),
  /** COMPUTED at read time by the orchestrator (statfs of the backing volume
   *  for node-local locations it can reach) — never persisted, absent when the
   *  volume is remote/unreachable. The single capacity truth every UI reads. */
  capacity: z.object({ totalBytes: z.number(), availableBytes: z.number() }).nullable().optional(),
  /**
   * How much of that volume CamStack ITSELF holds on this location (D388) —
   * COMPUTED at read time from the `storage-occupancy` providers' own figures,
   * never persisted, never a filesystem walk.
   *
   * **ABSENT MEANS UNKNOWN, never zero.** No provider has reported for this
   * location yet — nobody stores here, the owning addon is down, or the first
   * refresh has not completed. A UI must omit the segment rather than draw it
   * at zero, which would claim we occupy nothing (D315). It is an OBJECT and
   * not a bare number precisely so that a `?? 0` on the consuming side has to
   * be spelled out loud instead of appearing by accident.
   *
   * `measuredAtMs` is the OLDEST contributing measurement, so it is honest
   * about the whole figure rather than about its freshest part.
   */
  owned: z
    .object({
      bytes: z.number().int().nonnegative(),
      measuredAtMs: z.number().int().nonnegative(),
    })
    .optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type StorageLocation = z.infer<typeof StorageLocationSchema>

/**
 * The retired `isDefault` key, DECLARED rather than dropped.
 *
 * A key removed from a non-strict `z.object` is stripped in silence (D380,
 * D381): a reader that still needs the old value gets `undefined` and cannot
 * tell "absent" from "never sent". The one reader that legitimately needs it —
 * the location store's boot migration, which turns the old default flag into
 * the `enabled` write set — parses THIS schema against the raw row instead, so
 * the migration is explicit and the live schema stays clean. Nothing else in
 * the repo may read it; `scripts/check-no-storage-default.ts` enforces that.
 */
export const LegacyStorageLocationDefaultSchema = z.object({
  isDefault: z.boolean().optional(),
})
export type LegacyStorageLocationDefault = z.infer<typeof LegacyStorageLocationDefaultSchema>

/**
 * Is this location a write target?
 *
 * A THIN delegate to the policy module (D385) — `mode` is the state, and
 * `mayWriteToLocation` is the only thing that interprets it (folding the legacy
 * `enabled` / `config.readOnly` pair for rows that predate the stamp). Kept for
 * one release because the name is spelled in a dozen call sites; new code asks
 * `mayWriteToLocation` directly.
 */
export interface LocationWriteTargetQuery {
  readonly mode?: StorageLocationMode
  readonly enabled?: boolean
  readonly config?: Readonly<Record<string, unknown>>
}

export function isLocationEnabled(location: LocationWriteTargetQuery): boolean {
  return mayWriteToLocation({ ...location, config: location.config ?? {} })
}

/**
 * Bytes in one GB, for every storage figure an operator types.
 *
 * BINARY (1024³), everywhere. The repo had both: the orchestrator's
 * `maxUsedGb` → bytes conversion used 1024³ while the recorder's placement
 * headroom used 10⁹ for the SAME stored key, so a location with a cap set was
 * silently 7.4% off depending on which side of the pipe asked. The persisted
 * values were entered against the binary unit and the admin UI reads it, so
 * that is the one that stays. Every GB knob — `maxUsedGb`, `minFreeGb` —
 * converts through {@link gbToBytes} and nowhere else.
 */
export const STORAGE_BYTES_PER_GB = 1024 ** 3

/** GB → bytes, binary. Fractional GB is admitted and floored. */
export function gbToBytes(gb: number): number {
  return Math.floor(gb * STORAGE_BYTES_PER_GB)
}

/**
 * How far a `drain` has got (D386) — the read a UI renders, and nothing more.
 *
 * `estimatedEmptyAtMs` is derived from the growth the ratchet has actually
 * OBSERVED and is `null` when it has observed none. Never a fabricated date: a
 * drain with no observed growth has no honest ETA, and inventing one is how an
 * operator learns not to believe the screen.
 */
export const StorageDrainProgressSchema = z.object({
  locationId: z.string(),
  startedAtMs: z.number(),
  startBytes: z.number(),
  bytesRemaining: z.number(),
  drained: z.boolean(),
  estimatedEmptyAtMs: z.number().nullable(),
})
export type StorageDrainProgress = z.infer<typeof StorageDrainProgressSchema>

/**
 * Reference accepted by consumer-facing `api.storage.*` calls.
 * Either:
 *  - a `StorageLocationType` (e.g. `'backups'`) → the sole location of that type
 *    (transitionally, the `<type>:default`-slugged row when several exist)
 *  - a fully-qualified id (e.g. `'backups:nas-01'`) → addresses a specific instance
 *
 * The orchestrator's `resolveRef(ref)` handles both cases.
 */
export const StorageLocationRefSchema = z.union([
  StorageLocationTypeSchema,
  z.string().regex(/^[a-z][a-zA-Z0-9-]*:[a-zA-Z0-9-]+$/),
])
export type StorageLocationRef = z.infer<typeof StorageLocationRefSchema>
