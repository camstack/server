/**
 * When a tile comes back for a still the server said was queued — and when it
 * gives up (D563).
 *
 * ## Why a retry, and not a queue or a push
 *
 * A deferred refusal is FREE. The provider's lane rejects past its capacity
 * without touching the camera, so asking again costs one cheap HTTP round trip
 * to the addon and zero Baichuan commands. That is what rules out the
 * alternatives: a push would need a channel, a subscription and server-side
 * fan-out of 60 tile identities to save requests that cost nothing, and a
 * client-side queue would be a second copy of the authority that already lives
 * where the camera's real constraint is. Scroll-into-view alone does not help
 * either — the 43 tiles measured refusing on 592 are already on screen.
 *
 * ## The shape
 *
 * Exponential, jittered, bounded. Exponential because a fixed interval either
 * hammers or dawdles; JITTERED because 43 tiles refused in the same paint
 * would otherwise come back in the same instant and refuse together again;
 * BOUNDED because a tile that asks for ever is the other way to show the
 * operator nothing.
 *
 * The server's `retry-after` is taken only when it is LONGER than the curve.
 * The curve is the floor, so a provider answering `retry-after: 1` for a whole
 * page cannot turn this into 43 requests a second.
 *
 * Sized against the measurement: one page is 60 tiles and the provider serves
 * one mint in flight per host, so the last tile is ~60 mints away. The budget
 * below outlasts that; a shorter one would be theatre.
 */

/** How many times a tile comes back before it says so and stops. */
export const STILL_RETRY_ATTEMPTS = 4

/** First wait, doubling from there. */
export const STILL_RETRY_BASE_MS = 4_000

/** No single wait is longer than this, whatever the server hints. */
export const STILL_RETRY_MAX_WAIT_MS = 30_000

/** ±25 %: enough to break a synchronised herd, not enough to stop being a
 *  schedule. */
const JITTER_FRACTION = 0.25

export interface StillRetryInput {
  /** 0 for the first retry, 1 for the second, … */
  readonly attempt: number
  /** The server's `retry-after`, in ms, or `null` when it sent none. */
  readonly serverHintMs: number | null
  /** Injected so the schedule is assertable; `Math.random` in production. */
  readonly random: () => number
}

export interface StillRetryPlan {
  readonly waitMs: number
}

/** The next wait, or `null` when the budget is spent. */
export function planStillRetry(input: StillRetryInput): StillRetryPlan | null {
  if (input.attempt >= STILL_RETRY_ATTEMPTS || input.attempt < 0) return null
  const curve = STILL_RETRY_BASE_MS * 2 ** input.attempt
  const chosen = Math.max(curve, input.serverHintMs ?? 0)
  const bounded = Math.min(chosen, STILL_RETRY_MAX_WAIT_MS)
  const jitter = 1 + (input.random() * 2 - 1) * JITTER_FRACTION
  return { waitMs: Math.round(bounded * jitter) }
}
