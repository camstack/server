import type { StorageLocationMode } from '@camstack/types'
import { mayWriteToLocation } from '@camstack/types'
/**
 * Which location `eventMedia` receives the NEXT blob on.
 *
 * Mirrors the recorder's state model (`recorder/addon/roots.ts`): a location's
 * `mode` (D385) is the one authority on whether it may be written. `readonly`
 * and `drain` are still READ (and the relocate mover in
 * `media-relocate-engine.ts` empties a `readonly` one) but never write
 * targets.
 *
 * Why this does NOT need the recorder's placement planner (`placement-
 * planner.ts` / traccia B): there the unit is a writer ffmpeg process bound
 * to a directory, and moving it costs a restart and a recording gap — hence
 * isteresi and vischiosità. Here every blob is an independent write with no
 * move cost, so the choice can be made fresh per blob. The shared PRIMITIVE
 * (traccia B) later takes the move cost as a caller parameter; this function
 * is that primitive's `moveCost: 'free'` case, written out by hand until B
 * lands.
 */
export interface MediaLocation {
  readonly id: string
  /** THE state (D385), resolved once by the policy module. */
  readonly mode: StorageLocationMode
  readonly headroomBytes: number
}

/**
 * Picks the location a new `eventMedia` blob should be written to, or `null`
 * when none is writable — the caller MUST refuse the write rather than fall
 * back to a read-only location, which would fail far downstream as an opaque
 * filesystem error instead of a named storage decision.
 *
 * `stickyId` is the pick this process last made (absent on a cold start). It
 * used to be the CLASS DEFAULT, which is gone (D383): the write set is every
 * enabled location, and among them the emptiest wins. Cross-restart stickiness
 * is deliberately not durable — every blob row stamps its own `locationId`, so
 * a restart that switches disk splits nothing that reads wrong.
 */
export function pickWritableMediaLocation(
  locations: readonly MediaLocation[],
  stickyId?: string,
): string | null {
  const writable = locations.filter((l) => mayWriteToLocation({ mode: l.mode, config: {} }))
  if (writable.length === 0) return null
  // Minimal stickiness: this process keeps writing where it already writes
  // while that stays writable. Switching on every blob would scatter one
  // event across two disks for no benefit.
  const keep = stickyId === undefined ? undefined : writable.find((l) => l.id === stickyId)
  if (keep) return keep.id
  return (
    writable.toSorted((a, b) => b.headroomBytes - a.headroomBytes || a.id.localeCompare(b.id))[0]
      ?.id ?? null
  )
}
