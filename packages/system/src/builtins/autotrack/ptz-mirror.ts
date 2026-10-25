/**
 * The in-memory mirror of everything the loop needs to know about the camera
 * that is NOT on the event payload — refreshed off the event path, by timer,
 * and only READ on the event path (D49).
 *
 * Two facts live here:
 *   - `moveImpulseMs` (`ptz.getOptions`) — how long one pulse runs. Without it
 *     nothing proves the pulse self-terminates, and the loop refuses to move.
 *   - the NATIVE autotrack state (`deviceManager.getBindings` +
 *     `ptzAutotrack.getStatus`) — whether the firmware is already driving this
 *     head.
 *
 * ## Why a mirror and not a read on the event path
 *
 * A one-shot decision must never gate on a fallible read (D49). If the loop
 * awaited `getOptions()` per frame, one bad read would look exactly like "this
 * camera has no PTZ" — and at 10 Hz it would also put a tRPC round-trip on the
 * frame path. So the refresh runs on its own timer and the event path reads a
 * field.
 *
 * ## A failed refresh changes nothing
 *
 * {@link applyMirrorRefresh} never downgrades a KNOWN value to `null` on a
 * failed read: a refresh that threw leaves the previous answer standing and
 * records the failure. A value that has never been read stays `unknown`, and
 * `unknown` refuses to move — not-yet-read must not look like not-enabled
 * (D315), and a measurement that failed is `null`, never a convenient zero
 * (D393).
 */
import type { NativeAutotrackState } from './autotrack-decision.js'

export interface PtzMirror {
  /** `ptz.getOptions().moveImpulseMs`. `null` = never read, or the driver
   *  itself reports it cannot say. */
  readonly moveImpulseMs: number | null
  readonly nativeAutotrack: NativeAutotrackState
  /** When a refresh last SUCCEEDED. `null` = never. */
  readonly lastRefreshAtMs: number | null
  /** Message of the last failed refresh, `null` once one succeeds again. */
  readonly lastError: string | null
  /** Consecutive failed refreshes since the last success. */
  readonly consecutiveFailures: number
}

export const INITIAL_PTZ_MIRROR: PtzMirror = {
  moveImpulseMs: null,
  nativeAutotrack: 'unknown',
  lastRefreshAtMs: null,
  lastError: null,
  consecutiveFailures: 0,
}

/** What one refresh attempt found. A `failed` outcome carries a reason —
 *  there is no silent failure shape. */
export type MirrorRefreshOutcome =
  | {
      readonly kind: 'read'
      readonly moveImpulseMs: number | null
      readonly nativeAutotrack: NativeAutotrackState
    }
  | { readonly kind: 'failed'; readonly error: string }

export function applyMirrorRefresh(
  mirror: PtzMirror,
  outcome: MirrorRefreshOutcome,
  nowMs: number,
): PtzMirror {
  if (outcome.kind === 'failed') {
    return {
      ...mirror,
      lastError: outcome.error,
      consecutiveFailures: mirror.consecutiveFailures + 1,
    }
  }
  return {
    // A read that came back without an impulse duration does not erase one we
    // already had — the driver answered, it just did not answer this field.
    moveImpulseMs: outcome.moveImpulseMs ?? mirror.moveImpulseMs,
    // The native state is the opposite case: the read ANSWERED, so its answer
    // replaces the mirror, `absent` included. That is not a failure shape —
    // only the `failed` outcome above is.
    nativeAutotrack: outcome.nativeAutotrack,
    lastRefreshAtMs: nowMs,
    lastError: null,
    consecutiveFailures: 0,
  }
}
