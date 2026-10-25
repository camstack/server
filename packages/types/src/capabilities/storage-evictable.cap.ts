import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * `storage-evictable` — implemented by any addon that owns evictable data on a
 * storage location (recordings, event clips, thumbnails, …).
 *
 * The core `StoragePressureManager` (in storage-orchestrator) owns the TRIGGER:
 * it monitors free space per location and, on breach of a location's
 * `minFreePercent`, asks each evictable provider to free a share of the deficit.
 * The provider decides WHAT is expendable and does the deletion itself — core
 * never deletes data it doesn't understand. This inverts control so disk-space
 * arbitration is one cross-consumer concern, not re-implemented per addon.
 *
 * `internal: true` — consumed only by the orchestrator's pressure manager, never
 * a public client surface.
 */

const EvictableUsageSchema = z.object({
  /** Bytes this provider currently holds on the location (0 if none). */
  bytes: z.number().int().nonnegative(),
})
export type EvictableUsage = z.infer<typeof EvictableUsageSchema>

const EvictResultSchema = z.object({
  /** Bytes actually reclaimed (only successfully-deleted data counts). */
  reclaimedBytes: z.number().int().nonnegative(),
  /** True when the provider has nothing left it is willing to drop on this location. */
  exhausted: z.boolean(),
})
export type EvictResult = z.infer<typeof EvictResultSchema>

export const storageEvictableCapability = {
  name: 'storage-evictable',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /**
     * `internal: true` did not gate the mount (see the 2026-08-26 note on
     * `data-store-provider`) — this was reachable on the AppRouter by ANY
     * authenticated session at the default `auth: 'protected'`. The only
     * consumer is the orchestrator's `StoragePressureManager`, which calls
     * `ctx.api` — never tRPC — so `auth: 'admin'` costs it nothing.
     */
    /** Bytes this provider holds on the given location — drives proportional fan-out. */
    getEvictableUsage: method(z.object({ locationId: z.string() }), EvictableUsageSchema, {
      auth: 'admin',
    }),
    /**
     * Free approximately `targetBytes` of this provider's OWN least-valuable
     * data on the location (oldest footage, expired clips, …). Returns what it
     * actually reclaimed + whether it is now exhausted.
     */
    evict: method(
      z.object({ locationId: z.string(), targetBytes: z.number().int().positive() }),
      EvictResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IStorageEvictableProvider = InferProvider<typeof storageEvictableCapability>
