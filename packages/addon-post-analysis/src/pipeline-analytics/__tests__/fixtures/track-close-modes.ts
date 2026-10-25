import type { TrackCloseMode } from '../../pipeline/track-resident-state.js'

/**
 * Every `TrackCloseMode`, so the close invariants run against each one.
 *
 * Exhaustive by construction: a mode added to the union and not listed here
 * fails the type check below instead of silently going untested.
 */
export const TRACK_CLOSE_MODES = [
  'end',
  'suppress',
  'stationary',
  'prune',
] as const satisfies readonly TrackCloseMode[]

type UnlistedCloseMode = Exclude<TrackCloseMode, (typeof TRACK_CLOSE_MODES)[number]>
const everyModeListed: [UnlistedCloseMode] extends [never] ? true : never = true
void everyModeListed
