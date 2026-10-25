/**
 * THE gate between a snapshot request and a Baichuan login on a battery
 * camera.
 *
 * ## Why a gate, and why here
 *
 * On a sleeping UDP/battery Reolink the LOGIN is the wake: the lib's
 * discovery + handshake nudges the firmware up before anything asks it for a
 * picture. So a gate placed after `ensureApi()` — or inside `wakeUp()` — is
 * cosmetic; by the time it runs, the camera is already awake and the battery
 * is already spent. The gate has to sit in front of the login, and it has to
 * be the ONLY thing deciding.
 *
 * ## What decides
 *
 * `snapshot.getSnapshot`'s `force` flag, and nothing else. The capability
 * contract (`packages/types/src/capabilities/snapshot.cap.ts`) is explicit:
 * `force` is an OPERATOR signal, the one thing that may walk past the sleep
 * gate; a background caller — a poller, an event handler, a thumbnail, the
 * broker's sentry card — must never set it, and must be answered from
 * cache. "Stale but honest beats woken."
 *
 * ## What used to decide, and why it was wrong
 *
 * A 10-minute proactive-wake COOLDOWN (`canProactivelyWake`). A rate limiter
 * is not a contract: it answers "how often may we wake this camera", never
 * "may we wake it at all". Every background caller that happened to arrive
 * on the far side of the window got a login. Measured on the live hub,
 * 2026-09-15 14:47:25, device 106 ("Baby monitor", battery): the broker's
 * `preparePrestreamFrame` asked WITHOUT `force`, the cooldown let it through,
 * the camera logged in while asleep — and the very next line composed the
 * picture from `cached-snapshot`. The wake bought nothing at all.
 *
 * The cooldown is therefore absent from this decision. A forced read is
 * operator DEMAND and demand is never rate-limited (same rule as
 * `wakeForStream` / `wakeIfSleeping`); an unforced read never wakes, so there
 * is nothing left to rate-limit. `stampCooldown` still tells the caller to
 * stamp the shared timestamp on a wake it does issue, so the remaining
 * proactive paths (contact-expiry, aux align) back off behind it.
 */

/** Why a snapshot read was refused without touching the camera. */
export type SnapshotAccessRefusal = 'sleeping'

export type SnapshotAccessDecision =
  | {
      readonly kind: 'proceed'
      /**
       * The caller is about to wake a sleeping camera on operator demand and
       * must stamp the shared proactive-wake cooldown, so background paths
       * back off behind it. `false` on a camera that is already awake (or has
       * no battery): nothing is being woken, nothing to stamp.
       */
      readonly stampCooldown: boolean
    }
  | { readonly kind: 'refuse'; readonly reason: SnapshotAccessRefusal }

export interface SnapshotAccessInput {
  /** Is this a battery-operated camera? A mains camera is never gated. */
  readonly isBattery: boolean
  /** The driver's committed `battery.sleeping` view. */
  readonly sleeping: boolean
  /** `snapshot.getSnapshot`'s `force` — the operator's signal, nothing else. */
  readonly force: boolean
}

/**
 * Decide whether a snapshot read may reach the camera's socket.
 *
 * Pure, and deliberately total: three inputs, no clock, no cooldown, no
 * fallible read (D49 — a gate that can be talked out of its answer by a
 * stale timestamp is not a gate).
 */
export function decideSnapshotCameraAccess(input: SnapshotAccessInput): SnapshotAccessDecision {
  if (!input.isBattery || !input.sleeping) return { kind: 'proceed', stampCooldown: false }
  if (!input.force) return { kind: 'refuse', reason: 'sleeping' }
  return { kind: 'proceed', stampCooldown: true }
}
