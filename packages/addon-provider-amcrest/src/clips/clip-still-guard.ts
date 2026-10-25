/**
 * What a still mint REMEMBERS about a camera that is failing its replays.
 *
 * 2026-09-25, 3836: every mint that got the lane ran the full bound and
 * failed, a remount re-dialled each clip, and the next tile dialled regardless
 * — a back-to-back chain of `/cam/playback` sessions next to the hub's own
 * live main and sub, until the camera stopped answering their keepalives. Two
 * memories stop that, and both are cheap questions asked BEFORE the lane
 * (D54):
 *
 * - **a failed still, per clip** ({@link CLIP_STILL_FAILURE_MEMORY_MS}): a
 *   remount is answered with the refusal it already got, verbatim, instead of
 *   the camera;
 * - **a pause, per camera**: after {@link CLIP_STILL_FAILURES_TO_PAUSE}
 *   consecutive failed cuts, no still is dialled on that camera for
 *   {@link CLIP_STILL_PAUSE_MS}. It is `camera-backoff`, DEFERRED — nothing is
 *   wrong with the clips — and it opens with ONE warn line, not one per tile.
 *
 * A success resets the count. Held in memory, per runner: a restart forgets,
 * which costs at most two more dials.
 */
import type { IScopedLogger } from '@camstack/types'

import type { MintRefusal } from './clip-still-refusal.js'

/** How long one clip's failed still is remembered. */
export const CLIP_STILL_FAILURE_MEMORY_MS = 10 * 60_000
/** How long a camera's still mints pause once it has failed in a row. */
export const CLIP_STILL_PAUSE_MS = 5 * 60_000
/** Consecutive failed cuts that pause a camera. */
export const CLIP_STILL_FAILURES_TO_PAUSE = 2

export interface ClipStillGuard {
  /** The refusal this clip already got, while it is remembered. */
  remembered(deviceId: number, clipKey: string): MintRefusal | null
  /** Milliseconds left on this camera's pause, or `null` when it is not paused. */
  pausedForMs(deviceId: number): number | null
  /** A cut that FAILED (never a yield: that is not the camera's fault). */
  recordFailure(deviceId: number, clipKey: string, refusal: MintRefusal): void
  recordSuccess(deviceId: number): void
}

export interface ClipStillGuardDeps {
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly memoryMs?: number
  readonly pauseMs?: number
  readonly failuresToPause?: number
}

interface RememberedFailure {
  readonly refusal: MintRefusal
  readonly untilMs: number
}

function memoryKey(deviceId: number, clipKey: string): string {
  return `${String(deviceId)}/${clipKey}`
}

export function createClipStillGuard(deps: ClipStillGuardDeps): ClipStillGuard {
  const now = deps.now ?? ((): number => Date.now())
  const memoryMs = deps.memoryMs ?? CLIP_STILL_FAILURE_MEMORY_MS
  const pauseMs = deps.pauseMs ?? CLIP_STILL_PAUSE_MS
  const failuresToPause = deps.failuresToPause ?? CLIP_STILL_FAILURES_TO_PAUSE
  const failures = new Map<string, RememberedFailure>()
  const consecutive = new Map<number, number>()
  const pausedUntil = new Map<number, number>()

  const forgetLapsed = (at: number): void => {
    for (const [key, entry] of failures) {
      if (entry.untilMs <= at) failures.delete(key)
    }
  }

  return {
    remembered: (deviceId, clipKey) => {
      const key = memoryKey(deviceId, clipKey)
      const entry = failures.get(key)
      if (entry === undefined) return null
      if (entry.untilMs <= now()) {
        failures.delete(key)
        return null
      }
      return entry.refusal
    },
    pausedForMs: (deviceId) => {
      const until = pausedUntil.get(deviceId)
      if (until === undefined) return null
      const left = until - now()
      if (left > 0) return left
      pausedUntil.delete(deviceId)
      return null
    },
    recordFailure: (deviceId, clipKey, refusal) => {
      const at = now()
      forgetLapsed(at)
      failures.set(memoryKey(deviceId, clipKey), { refusal, untilMs: at + memoryMs })
      const count = (consecutive.get(deviceId) ?? 0) + 1
      if (count < failuresToPause) {
        consecutive.set(deviceId, count)
        return
      }
      consecutive.delete(deviceId)
      pausedUntil.set(deviceId, at + pauseMs)
      deps.logger.warn(
        'videoclips: pausing clip stills for this camera — its replays keep failing',
        {
          tags: { deviceId },
          meta: {
            branch: 'still-pause',
            consecutiveFailures: count,
            pauseMs,
            lastClipKey: clipKey,
            lastReason: refusal.reason,
          },
        },
      )
    },
    recordSuccess: (deviceId) => {
      consecutive.delete(deviceId)
    },
  }
}
