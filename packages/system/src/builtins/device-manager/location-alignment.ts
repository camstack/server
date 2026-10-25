/**
 * Location alignment — closes the RETROACTIVITY hole D252/D329 left open, and
 * makes the broken state LOUD wherever it survives.
 *
 * The cascade (`setLocation` → every descendant's own `location` column,
 * device-meta-actions.ts) runs only when `setLocation` is CALLED. Both records
 * said so out loud ("Nothing retroactive") and the fleet paid for it: measured
 * on the live hub 2026-09-04, 40 containers whose location predated the
 * cascade carried 373 children at `location: null` — every one of those
 * containers invisible to auto-mode linking-by-location (the container itself
 * is deliberately never a link; its children never matched), and not one log
 * line said so. Camera 101 showed one siren where four appliances belonged.
 *
 * Two mechanisms close it, both WRITE-time — read-time inheritance stays
 * rejected (D252's context: a live-resolved location is invisible everywhere
 * except the one call site that resolves it):
 *
 *  1. **A one-shot boot backfill** (`runLocationBackfillAtBoot`). For every
 *     device whose `location` is null and whose parent chain reaches a located
 *     CONTAINER ancestor (container-only — see `planNullLocationFills` for
 *     why a camera's subtree is deliberately left alone), the NEAREST located
 *     ancestor's location is written onto the
 *     row — once per install, marker-guarded. It fills NULL ONLY: an automated
 *     pass carries no operator intent, so it must never overwrite an explicit
 *     different location the way an operator's `setLocation` deliberately
 *     does. Runs under `withMetaWriteLock` and re-verifies each row is still
 *     null before patching, so it cannot fight a concurrent edit. The marker
 *     is only advanced when every planned write LANDED — a partial repair
 *     retries next boot (bounded: once per boot), never silently half-done.
 *
 *  2. **Registration-time inheritance** (`resolveInheritedLocation`, consumed
 *     by `registerDevice` in device-meta-actions.ts). A child adopted AFTER
 *     its parent's location was set is the same hole reopened — the cascade
 *     only fires on `setLocation`, and nobody re-saves a container because HA
 *     grew an entity. So a newly-registered (or re-parented) row whose own
 *     location is null inherits the nearest located CONTAINER ancestor's
 *     location the instant it registers, and pulls it down onto its own
 *     null-location descendants (out-of-order adoption registers children
 *     before parents).
 *
 * And one detection: every boot, read-only, the fleet is checked for the
 * broken state and each misaligned ancestor is WARNED about, device-tagged —
 * the state can re-enter (a partially-failed cascade, a hand-edited ledger)
 * and a branch that drops work must say so.
 */
import { randomUUID } from 'node:crypto'
import { DeviceType, EventCategory } from '@camstack/types'
import type { PersistedDeviceMeta } from './device-meta-types.js'
import type { ProviderContext } from './device-provider-context.js'
import type { DeviceRow } from './device-row-store.js'

/** Addon-store key of the one-shot marker. A number: the highest backfill
 *  version that COMPLETED (every planned write landed). */
export const LOCATION_BACKFILL_MARKER_KEY = 'locationBackfillVersion'
export const LOCATION_BACKFILL_VERSION = 1

/** One planned repair: write `location` onto row `id`, inherited from the
 *  nearest located ancestor `ancestorId`. */
export interface NullLocationFill {
  readonly id: number
  readonly location: string
  readonly ancestorId: number
}

/** Walk the parent chain of `startParentId` over an in-memory fleet snapshot
 *  and return the nearest ancestor carrying a non-null location. Cycle-guarded:
 *  a chain that revisits a node answers null rather than spinning. */
function nearestLocatedAncestor(
  byId: ReadonlyMap<number, PersistedDeviceMeta>,
  startParentId: number | null,
): PersistedDeviceMeta | null {
  const visited = new Set<number>()
  let cursor = startParentId
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor)
    const ancestor = byId.get(cursor)
    if (!ancestor) return null
    if (ancestor.location !== null) return ancestor
    cursor = ancestor.parentDeviceId
  }
  return null
}

/**
 * Pure planning core of the backfill: every row whose own `location` is null
 * and whose parent chain reaches a located CONTAINER ancestor gets that
 * ancestor's location. Nearest located ancestor wins — and DECIDES: a located
 * non-container between the row and a located container blocks the fill.
 *
 * The container-only predicate is an operator decision (2026-09-05), the
 * automated mirror of the structural-children rule: a non-container parent's
 * subtree (a camera and its siren/floodlight) is already fully reachable
 * through `resolveLinkedDeviceIds`' children-of-self rule, so a location buys
 * its own camera nothing — and COSTS cross-camera noise, verified against the
 * real fleet shape with the real resolver: a camera child that gains the room
 * matches every OTHER camera in that room individually (`ids.add`; only a
 * Container parent routes through `expand`), so camera B lists camera A's
 * siren as a companion. A container's descendants, by contrast, are reachable
 * by location ONLY through their own columns — the container itself is never
 * a link — which is the whole reason the cascade writes them (D252). Note the
 * asymmetry with the OPERATOR's cascade, which has no type predicate (D329):
 * an operator re-saving a camera accepts that trade explicitly; an automated
 * pass must not manufacture it.
 */
export function planNullLocationFills(
  rows: readonly PersistedDeviceMeta[],
): readonly NullLocationFill[] {
  const byId = new Map<number, PersistedDeviceMeta>(rows.map((r) => [r.id, r]))
  const plan: NullLocationFill[] = []
  for (const row of rows) {
    if (row.location !== null) continue
    if (row.parentDeviceId === null) continue
    const hit = nearestLocatedAncestor(byId, row.parentDeviceId)
    if (hit === null) continue
    if (hit.type !== DeviceType.Container) continue
    // `nearestLocatedAncestor` only returns a row with a non-null location;
    // the guard narrows the type without a cast.
    if (hit.location === null) continue
    plan.push({ id: row.id, location: hit.location, ancestorId: hit.id })
  }
  return plan
}

/** The one row-store method the async ancestor walk needs. */
export interface RowReader {
  get(deviceId: number): Promise<DeviceRow | null>
}

/**
 * Async ancestor walk for `registerDevice`: the nearest located CONTAINER
 * ancestor's location, read row by row (registration has no fleet snapshot in
 * hand and must not pay for one). Same container-only predicate as
 * {@link planNullLocationFills}, and for the same reason — a child adopted
 * under a located CAMERA is already linked structurally to that camera, and a
 * location on its own column would make it a companion of every other camera
 * in the room. The nearest located ancestor decides: a located non-container
 * on the way up answers null. Cycle-guarded like the pure walk; a missing row
 * — a parent registered out of order — answers null, and the parent's own
 * later registration pulls the location down instead (see `registerDevice`).
 */
export async function resolveInheritedLocation(
  rows: RowReader,
  parentDeviceId: number | null,
): Promise<string | null> {
  const visited = new Set<number>()
  let cursor = parentDeviceId
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor)
    const ancestor = await rows.get(cursor)
    if (ancestor === null) return null
    if (ancestor.meta.location !== null) {
      return ancestor.meta.type === DeviceType.Container ? ancestor.meta.location : null
    }
    cursor = ancestor.meta.parentDeviceId
  }
  return null
}

/** `fills` grouped by the ancestor whose location they inherit — the unit the
 *  logs speak in, because the ancestor is the device an operator would act on. */
function groupByAncestor(
  fills: readonly NullLocationFill[],
): ReadonlyMap<number, readonly NullLocationFill[]> {
  const grouped = new Map<number, NullLocationFill[]>()
  for (const fill of fills) {
    const bucket = grouped.get(fill.ancestorId)
    if (bucket) bucket.push(fill)
    else grouped.set(fill.ancestorId, [fill])
  }
  return grouped
}

/**
 * Boot entrypoint: the one-shot repair (marker-guarded) plus the every-boot
 * detection. `bootRows` is the fleet listing the addon's warm-boot pass
 * already paid for — reused for the detection so a clean boot costs no extra
 * fleet read; ignored by the repair, which takes its own listing UNDER the
 * meta write lock (the snapshot must not predate the lock).
 */
export async function runLocationBackfillAtBoot(
  pctx: ProviderContext,
  bootRows?: readonly DeviceRow[],
): Promise<void> {
  const logger = pctx.host.ctx.logger
  const addonStore = await pctx.settings.readAddonStore()
  const markerRaw = addonStore[LOCATION_BACKFILL_MARKER_KEY]
  const completedVersion = typeof markerRaw === 'number' ? markerRaw : 0
  let repaired = false

  if (completedVersion < LOCATION_BACKFILL_VERSION) {
    const patched: NullLocationFill[] = []
    const failed: Array<{ id: number; error: unknown }> = []
    await pctx.metaStore.withMetaWriteLock(async () => {
      const rows = await pctx.metaStore.rows.listAll()
      const plan = planNullLocationFills(rows.map((r) => r.meta))
      for (const fill of plan) {
        try {
          // Re-verify under the lock: a concurrent `setLocation` (or removal)
          // that landed between listing and here wins — the backfill only ever
          // fills a hole that still exists.
          const current = await pctx.metaStore.rows.get(fill.id)
          if (current === null || current.meta.location !== null) continue
          await pctx.metaStore.rows.patch(fill.id, { location: fill.location })
          patched.push(fill)
        } catch (err) {
          failed.push({ id: fill.id, error: err })
        }
      }
    })
    repaired = true
    // COALESCED: one `DeviceMetaChanged` per repaired ANCESTOR, never one per
    // row. The viewer invalidates its meta-sensitive query heads on EVERY
    // event of this category (device-meta-invalidation.tsx — deliberately
    // broad, so one event already carries the full effect for every
    // derived-state consumer), and the backend meta mirror re-warms the whole
    // fleet at `SystemAddonsReady`, which follows this boot pass. A per-row
    // emission here would fire hundreds of client invalidations for one
    // repair. This deliberately trades per-CHILD event granularity away at
    // boot; the durable truth is the rows (D8 — events are telemetry).
    for (const [ancestorId, fills] of groupByAncestor(patched)) {
      pctx.host.ctx.eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'device', id: ancestorId },
        category: EventCategory.DeviceMetaChanged,
        data: { deviceId: ancestorId, field: 'location', value: fills[0]?.location ?? null },
      })
      logger.info('location backfill: aligned location-less descendants to their ancestor', {
        tags: { deviceId: ancestorId },
        meta: { location: fills[0]?.location, updatedIds: fills.map((f) => f.id) },
      })
    }
    if (failed.length > 0) {
      logger.error('location backfill partially failed — retrying on the next boot', {
        meta: {
          failedIds: failed.map((f) => f.id),
          errors: failed.map((f) => (f.error instanceof Error ? f.error.message : String(f.error))),
        },
      })
    } else {
      // Advance the marker only when everything planned LANDED (D58's shape:
      // gate on "did it persist"). Held under the addon-store lock because the
      // store is a fleet-wide read-modify-write surface (D309).
      await pctx.metaStore.withAddonStoreWriteLock(async () => {
        await pctx.settings.writeAddonStore({
          [LOCATION_BACKFILL_MARKER_KEY]: LOCATION_BACKFILL_VERSION,
        })
      })
    }
  }

  // Detection — every boot, read-only. After a repair the fresh state must be
  // re-listed; on the common (already-completed) boot the warm rows are free.
  const detectRows =
    !repaired && bootRows !== undefined ? bootRows : await pctx.metaStore.rows.listAll()
  const residual = planNullLocationFills(detectRows.map((r) => r.meta))
  for (const [ancestorId, fills] of groupByAncestor(residual)) {
    logger.warn(
      'location cascade misaligned — location-less descendants under a located ancestor never reach the same-location suggestions of the picker; re-save the ancestor location to realign',
      {
        tags: { deviceId: ancestorId },
        meta: { location: fills[0]?.location, misalignedDescendantIds: fills.map((f) => f.id) },
      },
    )
  }
}
