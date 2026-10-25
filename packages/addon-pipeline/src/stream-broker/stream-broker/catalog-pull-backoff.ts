/**
 * CATALOG-PULL BACKOFF — how often the broker asks a camera whose
 * `stream-catalog` pull keeps failing.
 *
 * ## What this exists to stop
 *
 * 2026-08-25, device 3629 ("Camera porta retro", Reolink). Its Baichuan
 * session expired under a socket that stayed open, so every
 * `stream-catalog.getCatalog` answered `buildVideoStreamOptions failed …
 * responseCode 400`. The reconcile poll asked again 30 s later. And again. For
 * 35 minutes, ~70 identical failures, each one a login attempt, a 10 s timeout
 * budget and a `debug` line nobody was reading.
 *
 * The fleet was never at risk from that camera — `reconcileAllCatalogs` fans
 * out with `Promise.allSettled` and `reconcileDeviceCatalogNow` catches its own
 * pull, so exactly one device was omitted (that isolation is frozen by
 * `scripts/check-catalog-per-device-isolation.ts`). What was wrong is that the
 * omission was invisible and the retry was a flat 30 s hammer that could not
 * have recovered anyway.
 *
 * ## The shape
 *
 * The ladder is {@link BOOT_RECOVERY_BACKOFF_MS} — the repo's ONE retry
 * schedule for work that can fail for reasons that pass: two cheap attempts
 * (15 s, 60 s) for a blip, then the long tail (5 m → 90 m) for a camera that
 * is genuinely gone.
 *
 * ## The one place this DIVERGES from boot recovery, and why
 *
 * The boot ladder ENDS: it runs out and manual re-arm is the only path. This
 * one CLAMPS at the last rung and keeps asking every 90 minutes forever.
 *
 * Boot recovery can end because a human is present — a node that just booted
 * wrong is a node someone is looking at. A camera whose session expired at
 * 03:00 has nobody. The reconcile poll is the ONLY thing that will ever ask it
 * again: no event fires when a camera silently starts working, and a device
 * that never re-enters the catalog is a device with no broker, no recording
 * and no detection, permanently. Ending the chain would convert a transient
 * session expiry into a permanent outage — precisely the failure it is meant
 * to bound. A 90-minute floor is not a spin: it is ~16 pulls a day for one
 * broken camera, against 2 880 before this.
 */
import { BOOT_RECOVERY_BACKOFF_MS } from '@camstack/types'

/**
 * Why a device's catalog is being reconciled.
 *
 * `'poll'` is the 30 s backstop tick — it repeats forever and carries no new
 * information, so it is the only trigger the backoff throttles. `'event'` is a
 * device registration or a `StreamParamsChanged`: something actually moved, so
 * it always attempts.
 */
export type CatalogReconcileTrigger = 'poll' | 'event'

/**
 * What the broker remembers about a device whose catalog pull is failing.
 * Absent from the map = the device is healthy; there is no "zero failures"
 * entry to keep in sync.
 */
export interface CatalogPullFailureState {
  /** Failed pulls since the last success. Never zero — see the doc above. */
  readonly consecutiveFailures: number
  /** Ms-epoch before which a POLL-driven pull is skipped. */
  readonly nextAttemptAtMs: number
}

/**
 * The rung the ladder settles on. Read off the shared schedule rather than
 * written down twice; the literal only keeps the expression total for a
 * hypothetically empty ladder, and is not the clamp.
 */
const LAST_RUNG_MS: number =
  BOOT_RECOVERY_BACKOFF_MS[BOOT_RECOVERY_BACKOFF_MS.length - 1] ?? 90 * 60_000

/**
 * Delay before the next poll-driven attempt, given how many pulls in a row
 * have now failed (1 = the first failure).
 *
 * Clamped at the last rung rather than exhausted — see the module doc.
 */
export function catalogPullRetryDelayMs(consecutiveFailures: number): number {
  const rung = Math.max(consecutiveFailures, 1) - 1
  // THE clamp — the one line that makes the ladder repeat instead of end.
  // Walking off the end yields the last rung forever.
  return BOOT_RECOVERY_BACKOFF_MS[rung] ?? LAST_RUNG_MS
}

/**
 * Advance the failure memory after one more failed pull.
 *
 * @param previous state before this failure, or `undefined` for the first one
 * @param nowMs wall clock at the moment of the failure
 */
export function nextCatalogPullFailureState(
  previous: CatalogPullFailureState | undefined,
  nowMs: number,
): CatalogPullFailureState {
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1
  return {
    consecutiveFailures,
    nextAttemptAtMs: nowMs + catalogPullRetryDelayMs(consecutiveFailures),
  }
}

/**
 * May a POLL-driven pull run for this device right now?
 *
 * Only the poll is gated. An event-driven reconcile (device registered,
 * stream params changed) is EVIDENCE that something moved and always
 * attempts — a backoff that ignores new information is just a slower way of
 * being wrong.
 */
export function mayAttemptPolledCatalogPull(
  state: CatalogPullFailureState | undefined,
  nowMs: number,
): boolean {
  if (state === undefined) return true
  return nowMs >= state.nextAttemptAtMs
}
