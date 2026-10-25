import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * `storage-occupancy` — how many bytes an addon actually HOLDS on a storage
 * location (D388).
 *
 * ## Why this is not `storage-evictable`
 *
 * `storage-evictable.getEvictableUsage` looks like the same question and is
 * not, in two ways that both matter and both bite hardest on the locations an
 * operator most wants a figure for:
 *
 *  - it reports the whole eviction DOMAIN, not the location. `recordings:default`
 *    and `recordingsLow:default` deliberately share one root and evict as one
 *    oldest-first pool, so both answer with the SAME combined total. As an
 *    occupancy figure that double-counts the disk.
 *  - it reports ZERO for a location whose eviction policy is `never` (D385) —
 *    a `readonly` or `disabled` disk. Those are exactly the disks an operator
 *    is retiring and staring at.
 *
 * So this is its own contract with its own quantity, and the quantity is
 * OCCUPIED: every byte the addon holds on that location, whether or not it
 * would ever be willing to delete it. A provider that can only answer
 * "evictable" must not register here — a number that silently means different
 * things per class is worse than no number.
 *
 * ## Absence is an answer
 *
 * A location nobody reports for is UNKNOWN, never zero (D315). The orchestrator
 * stamps `StorageLocation.owned` only for locations it has a report for, and
 * the field is an OBJECT rather than a bare number so that a `?? 0` on the
 * consuming side has to be written out loud instead of appearing by accident.
 *
 * `internal: true` — consumed by the orchestrator's `listLocations` stamp, never
 * a public client surface. Clients read the stamped `StorageLocation.owned`.
 */

/** One provider's occupancy answer for one location. */
export const StorageOccupancyReportSchema = z.object({
  locationId: z.string(),
  /** Bytes this provider holds on THAT location — not its eviction domain, and
   *  not net of what it is willing to delete. */
  ownedBytes: z.number().int().nonnegative(),
  /** When the provider last actually measured this. The orchestrator carries it
   *  through so a UI can say how old the figure is instead of implying "now". */
  measuredAtMs: z.number().int().nonnegative(),
})
export type StorageOccupancyReport = z.infer<typeof StorageOccupancyReportSchema>

export const storageOccupancyCapability = {
  name: 'storage-occupancy',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /**
     * Occupancy for the given locations, in ONE round trip.
     *
     * A provider answers only for the locations it actually holds bytes on and
     * OMITS the rest — an omitted location is "I hold nothing measurable here",
     * which the orchestrator merges as a contribution of nothing rather than as
     * a claim that the location is empty. Only a location no provider reports
     * at all stays unknown.
     *
     * This must be CHEAP and must never walk a filesystem: it is on the admin
     * UI's `listLocations` path. The owner keeps its own figure fresh (D224) and
     * answers from what it already has.
     */
    getOccupancy: method(
      z.object({ locationIds: z.array(z.string()).readonly() }),
      z.array(StorageOccupancyReportSchema).readonly(),
      { auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IStorageOccupancyProvider = InferProvider<typeof storageOccupancyCapability>
