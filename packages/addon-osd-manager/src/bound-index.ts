/**
 * The durable index of cameras that have at least one OSD binding.
 *
 * WHY IT EXISTS. The render loop's work list used to be DERIVED at boot: list
 * every device in the directory, read each one's binding block, keep the ones
 * that answered non-empty. Every one of those reads is a UDS round-trip to the
 * settings store, and they ran one at a time. Measured on the boot of
 * 2026-08-19: 976 devices × 559 ms under boot load = 546 s in which
 * `OsdManager.start()` had not returned — and `start()` was awaited inside
 * `onInitialize()`, so for nine minutes the `osd-manager` and
 * `addon-pages-source` capabilities did not exist ANYWHERE in the cluster
 * (docs/architecture/addon-lifecycle.md). The answer it took nine minutes to
 * compute was `boundDevices = 0`.
 *
 * Filtering to cameras and fanning the reads out makes that scan cheap, but it
 * is still a scan. The index is the actual fix: the work list is WRITTEN where
 * bindings are written, so boot reads one key and is done in milliseconds. The
 * scan stays, in the background, as the reconcile — because an index nothing
 * checks is an index that eventually lies.
 *
 * The value is the SET of bound camera ids, serialised as a sorted array.
 * `null` is not "no cameras are bound", it is "this hub has never written the
 * index" — the two must stay distinguishable, because the first is authoritative
 * and the second means seed it from a scan. An empty ARRAY is the authoritative
 * "nothing is bound".
 */
import { z } from 'zod'

/** Store key inside the addon's own (global) store. */
export const OSD_BOUND_INDEX_KEY = 'boundDeviceIds'

export const OsdBoundIndexSchema = z.array(z.number().int().positive()).nullable()

/** Sorted camera ids, or `null` when the index has never been written. */
export type OsdBoundIndex = z.infer<typeof OsdBoundIndexSchema>

/** What `get()` answers before this hub has ever written the index. */
export const ABSENT_BOUND_INDEX: OsdBoundIndex = null

/** A durable handle over the bound-camera index. */
export interface BoundIndexHandle {
  get(): Promise<OsdBoundIndex>
  set(next: OsdBoundIndex): Promise<void>
}
