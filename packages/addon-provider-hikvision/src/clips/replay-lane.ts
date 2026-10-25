/**
 * One camera, one replay at a time — declared here, never learned from a 500.
 *
 * ## The fact this module owns
 *
 * **This firmware serves ONE playback session per camera.** It is measured
 * (D605, and again on 1436 on 2026-09-23) and it is not negotiable: while a
 * replay is open, every other `SETUP` on that camera answers **500** while
 * `ContentMgmt/search` keeps answering normally. A 500 therefore says nothing
 * about whether the clip exists, and a surface that reads it as "this clip is
 * broken" has been told a lie by the wire.
 *
 * D611/D315's rule is that a fact like this belongs to the provider and is
 * DECLARED, not discovered. So the provider holds the slot itself: a second
 * ask does not reach the camera at all. It waits briefly, and then it is
 * refused BY NAME — `replay-busy`, with what held the slot and for how long —
 * which is a sentence a surface can show beside a clip that is still there.
 *
 * ## Why it waits at all, and why not for long
 *
 * The commonest overlap on this fleet is not two operators; it is ONE operator
 * moving from clip A to clip B. The broker tears A's stream down and dials B
 * in the same breath, and A's `TEARDOWN` is on the wire while B's `SETUP` is
 * being written. Refusing B outright would turn every second tap into an
 * error for want of a few hundred milliseconds.
 *
 * So the wait is bounded by {@link REPLAY_LANE_WAIT_MS}, which is the teardown
 * flush bound plus a margin — long enough for a slot that is BEING released,
 * far too short to queue behind a replay that is still playing. A Hikvision
 * replay arrives at 1×, so queueing behind a live one would mean waiting the
 * whole length of somebody else's clip: that is not a lane, it is a hostage.
 *
 * ## What it is not
 *
 * Not a retry, not a backoff, not a queue with a depth. A lease is held for
 * exactly as long as its holder holds the camera's socket — which is why the
 * holder releases only after {@link RtspReplaySession.close} has resolved, and
 * why that method resolves on the SOCKET closing rather than on the run
 * returning. "The run returned" is not the same fact as "the slot is free",
 * and shipping the first for the second is how this bug is re-introduced.
 */
import type { IScopedLogger } from '@camstack/types'

import { RTSP_TEARDOWN_FLUSH_MS } from './rtsp/rtsp-replay-session.js'

/**
 * How long an ask may wait for a slot that is being released.
 *
 * {@link RTSP_TEARDOWN_FLUSH_MS} plus a second of margin: a holder that is
 * shutting down frees the slot inside its own flush bound, and anything longer
 * than that is a holder that is still playing.
 */
export const REPLAY_LANE_WAIT_MS = RTSP_TEARDOWN_FLUSH_MS + 1_000

/**
 * What a lease was taken for, and whether anybody is WAITING on it.
 *
 * `stream` and `file` are an operator who has already tapped. `still` is a
 * tile being filled, and it is SPECULATIVE: nobody is looking at it yet, and
 * it may be abandoned at any moment without anyone noticing.
 *
 * This distinction was removed once, when a still cost a whole-clip fetch and
 * the right answer was simply never to touch the camera. It is back because
 * the cost changed: a first-frame mint holds the slot for **433–528 ms**
 * (measured on 1436, 2026-09-23 — handshake ~190 ms, first keyframe ~310–390
 * ms, TEARDOWN 40–82 ms), against the 20 000–150 000 ms a whole-clip fetch
 * costs. Half a second of speculative work IS worth doing and IS worth
 * cancelling; twenty seconds of it was neither.
 */
export type ReplayPurpose = 'stream' | 'file' | 'still'

/** Work nobody is waiting on, which an operator's tap may evict. */
const SPECULATIVE: ReadonlySet<ReplayPurpose> = new Set<ReplayPurpose>(['still'])

export interface ReplayLeaseHeld {
  readonly kind: 'held'
  /** Idempotent. Called only once the camera's socket is really gone. */
  release(): void
}

export interface ReplayLeaseBusy {
  readonly kind: 'busy'
  /** What is holding the camera's one slot. */
  readonly holder: ReplayPurpose
  /** How long that holder has had it. */
  readonly heldForMs: number
  /** How long this ask waited before giving up. */
  readonly waitedMs: number
  /** The sentence a surface may show. */
  readonly detail: string
}

export type ReplayLease = ReplayLeaseHeld | ReplayLeaseBusy

export interface ReplayLane {
  /**
   * `yieldNow` is how a SPECULATIVE holder gives the slot back early: it is
   * called at most once, by an ask that is not speculative, and the holder is
   * expected to abandon its work and release. The ask then waits the ordinary
   * wait for that to happen — which for a first-frame mint is milliseconds.
   */
  acquire(deviceId: number, purpose: ReplayPurpose, yieldNow?: () => void): Promise<ReplayLease>
  /** For a cheap question that must not wait (D54). */
  held(deviceId: number): boolean
}

export interface ReplayLaneDeps {
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly waitMs?: number
}

interface Holding {
  readonly purpose: ReplayPurpose
  readonly sinceMs: number
  readonly waiters: (() => void)[]
  readonly yieldNow: (() => void) | null
  yielded: boolean
}

export function createReplayLane(deps: ReplayLaneDeps): ReplayLane {
  const now = deps.now ?? ((): number => Date.now())
  const waitMs = deps.waitMs ?? REPLAY_LANE_WAIT_MS
  const holding = new Map<number, Holding>()

  const take = (
    deviceId: number,
    purpose: ReplayPurpose,
    yieldNow: (() => void) | null,
  ): ReplayLeaseHeld => {
    const entry: Holding = { purpose, sinceMs: now(), waiters: [], yieldNow, yielded: false }
    holding.set(deviceId, entry)
    let released = false
    return {
      kind: 'held',
      release: () => {
        if (released) return
        released = true
        if (holding.get(deviceId) !== entry) return
        holding.delete(deviceId)
        // One waiter, the oldest. The rest re-check on their own deadline —
        // waking every waiter would have them all race for a slot only one
        // can have, and the losers would then be refused having already
        // waited, which is the worst of both answers.
        entry.waiters.shift()?.()
      },
    }
  }

  return {
    held: (deviceId) => holding.has(deviceId),
    acquire: async (deviceId, purpose, yieldNow) => {
      const askedAt = now()
      const current = holding.get(deviceId)
      if (current === undefined) return take(deviceId, purpose, yieldNow ?? null)
      if (
        !SPECULATIVE.has(purpose) &&
        SPECULATIVE.has(current.purpose) &&
        current.yieldNow !== null &&
        !current.yielded
      ) {
        current.yielded = true
        deps.logger.debug('videoclips: asking a speculative replay to give the slot back', {
          tags: { deviceId },
          meta: { branch: 'replay-yield', asked: purpose, holder: current.purpose },
        })
        current.yieldNow()
      }
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const wake = (): void => {
          if (timer !== null) clearTimeout(timer)
          timer = null
          resolve()
        }
        timer = setTimeout(() => {
          timer = null
          const index = current.waiters.indexOf(wake)
          if (index !== -1) current.waiters.splice(index, 1)
          resolve()
        }, waitMs)
        current.waiters.push(wake)
      })
      const after = holding.get(deviceId)
      if (after === undefined) return take(deviceId, purpose, yieldNow ?? null)
      const heldForMs = now() - after.sinceMs
      const waitedMs = now() - askedAt
      const detail =
        `replay-busy: this camera serves one playback session at a time and its ` +
        `${after.purpose} has held it for ${String(heldForMs)} ms — nothing about ` +
        'this clip, and nothing a retry against the camera would change'
      // A refusal we issue OURSELVES still gets a line: without it the only
      // evidence an operator has that a clip did not play is silence, which
      // reads as "never happened" (D391).
      deps.logger.warn('videoclips: a replay was refused — the camera’s slot is held', {
        tags: { deviceId },
        meta: {
          branch: 'replay-busy',
          asked: purpose,
          holder: after.purpose,
          heldForMs,
          waitedMs,
        },
      })
      return { kind: 'busy', holder: after.purpose, heldForMs, waitedMs, detail }
    },
  }
}
