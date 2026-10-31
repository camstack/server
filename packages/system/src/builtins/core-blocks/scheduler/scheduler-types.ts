/** The seams the scheduler engine is built over, so a spec swaps the clock and the hub. */
import type { CapCall, SiteReading } from '@camstack/types'

export interface SchedulerClock {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

/** The real clock. A timer handle is whatever `setTimeout` returned; only this clock reads it back. */
export function createRealClock(): SchedulerClock {
  const handles = new Set<NodeJS.Timeout>()
  return {
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const handle = setTimeout(() => {
        handles.delete(handle)
        fn()
      }, ms)
      handles.add(handle)
      return handle
    },
    clearTimer: (handle) => {
      for (const known of handles) {
        if (known === handle) {
          clearTimeout(known)
          handles.delete(known)
        }
      }
    },
  }
}

/** The hub as the engine sees it: the site, device state, and device calls. */
export interface SchedulerHost {
  readSite(): Promise<SiteReading>
  fetchSlice(deviceId: number, cap: string): Promise<unknown>
  fetchStableIds(): Promise<ReadonlyMap<string, number>>
  invokeCap(call: CapCall): Promise<void>
}

/** How long a write of ours is given to show up in the device's state before it counts as drift. */
export const DEFAULT_SETTLE_MS = 60_000
/** A hub that was down longer than this replays no more than this much of the past. */
export const MAX_CATCHUP_MS: number = 7 * 86_400_000
