import type { ProfileSlot, PipelinePhaseMode } from '@camstack/types'

export interface RunnerCameras {
  readonly nodeId: string
  readonly attached: readonly number[]
}

export interface PlacementConvergence {
  readonly detach: readonly { readonly nodeId: string; readonly deviceId: number }[]
  readonly dropStaleAssignment: readonly number[]
}

export interface ReconcilePlacementInput {
  readonly runners: readonly RunnerCameras[]
  readonly assignedNodeById: ReadonlyMap<number, string>
  readonly dispatching: ReadonlySet<number>
  /** Idle on-motion cameras whose unassigned runner attach is an orphan. */
  readonly idleSessionDeviceIds: ReadonlySet<number>
  /** Intentional analyzer watch attaches, keyed by `${nodeId}:${deviceId}`. */
  readonly motionWatchAttachments: ReadonlySet<string>
}

export function runnerAttachmentKey(nodeId: string, deviceId: number): string {
  return `${nodeId}:${deviceId}`
}

/**
 * Derives the set of deviceIds that currently have at least one broker
 * profile slot that is assigned (status !== 'unassigned') AND has a
 * non-null sourceCamStreamId.
 *
 * This is the "desired" fleet — cameras the orchestrator should have
 * dispatched. Used by `reconcileDispatch` to compute the gap against
 * `cameraConfigs`.
 */
export function desiredDeviceIdsFromSlots(slots: readonly ProfileSlot[]): Set<number> {
  const result = new Set<number>()
  for (const slot of slots) {
    if (slot.status !== 'unassigned' && slot.sourceCamStreamId !== null) {
      result.add(slot.deviceId)
    }
  }
  return result
}

/**
 * Returns the deviceIds that are present in `desired` but absent from
 * `known`. These are the cameras the orchestrator has not yet dispatched
 * and needs to process via `handleDeviceRegistered`.
 *
 * Additive only — cameras present in `known` are never included, even
 * if they fall out of `desired`, to avoid fighting the live event path.
 */
export function computeDispatchGap(
  desired: ReadonlySet<number>,
  known: ReadonlySet<number>,
): number[] {
  return [...desired].filter((id) => !known.has(id))
}

/** The desired fleet split by whether the device registry still knows the device. */
export interface DesiredExistenceSplit {
  /** Desired devices the live registry confirmed — the only gap-fill candidates. */
  readonly existing: ReadonlySet<number>
  /**
   * Desired devices the live registry does NOT have — a deleted camera whose
   * broker profile slots outlive it (observed on 3217/3218).
   */
  readonly vanished: ReadonlySet<number>
}

/**
 * Split the desired fleet (derived from broker profile slots) against the LIVE
 * device registry.
 *
 * The broker keeps a deleted device's profile-slot assignments forever, so
 * `desiredDeviceIdsFromSlots` alone re-proposes a camera the operator already
 * deleted — and the reconcile's gap-fill then resurrects it. Callers dispatch
 * `existing` only.
 *
 * The caller MUST NOT call this with a failed/partial registry read: a read
 * that fails changes nothing (D49), it never prunes the fleet.
 */
export function splitDesiredByExistence(
  desired: ReadonlySet<number>,
  liveDeviceIds: ReadonlySet<number>,
): DesiredExistenceSplit {
  const existing = new Set<number>()
  const vanished = new Set<number>()
  for (const deviceId of desired) {
    if (liveDeviceIds.has(deviceId)) existing.add(deviceId)
    else vanished.add(deviceId)
  }
  return { existing, vanished }
}

/**
 * Per-device tracking state for a desired-but-nonexistent device.
 *  - `first-pass`: seen missing ONCE. Nothing done — one read never destroys work.
 *  - `torn-down`: teardown already ran for this vanish streak; further passes
 *    are no-ops until the device reappears.
 */
export type VanishedDeviceState = 'first-pass' | 'torn-down'

export interface VanishedReconcile {
  /** Devices confirmed gone by TWO consecutive passes — tear these down now. */
  readonly tearDown: readonly number[]
  /** State to carry into the next pass (devices that reappeared are dropped). */
  readonly nextState: ReadonlyMap<number, VanishedDeviceState>
}

/**
 * Decide which vanished devices are CONFIRMED gone (D49's two-disagreements
 * rule). Teardown destroys work — stopping detection, releasing the camera and
 * purging its persisted config — so a single registry read is never enough: a
 * device must be missing in TWO consecutive reconcile passes before it is torn
 * down. Anything that puts the device back (a successful listing that contains
 * it, or a failed read the caller declines to act on) resets the streak, so the
 * count only ever advances on agreeing evidence.
 *
 * Teardown fires ONCE per vanish streak (`torn-down`) — the broker's slots
 * outlive the device, so it stays vanished on every later pass and would
 * otherwise be re-purged forever.
 *
 * Pure — the caller owns the (in-memory, boot-empty) state map.
 */
export function reconcileVanishedDevices(
  vanished: ReadonlySet<number>,
  prior: ReadonlyMap<number, VanishedDeviceState>,
): VanishedReconcile {
  const tearDown: number[] = []
  const nextState = new Map<number, VanishedDeviceState>()
  for (const deviceId of vanished) {
    const state = prior.get(deviceId)
    if (state === undefined) {
      nextState.set(deviceId, 'first-pass')
      continue
    }
    if (state === 'first-pass') {
      tearDown.push(deviceId)
      nextState.set(deviceId, 'torn-down')
      continue
    }
    nextState.set(deviceId, 'torn-down')
  }
  return { tearDown, nextState }
}

/**
 * Converge the orchestrator's `assignments` map to runner truth. Runner
 * attachments (`getLocalCameras`) are AUTHORITATIVE; this returns the actions
 * that make the map agree with them:
 *
 *  - `detach`: a camera attached on a node it is NOT assigned to (a duplicate,
 *    a migration leak, or an orphan from a swallowed detach). Unassigned
 *    standing attachments are left alone for boot-race safety. An idle
 *    session-mode camera is different: it should have no detection attach, so
 *    its unassigned runner copy is detached unless it is the explicit analyzer
 *    motion-watch attachment.
 *  - `dropStaleAssignment`: a camera assigned to a node that REPORTED (was
 *    successfully queried and is present in `runners`) and did not list it
 *    attached (assigned-but-not-attached). The caller drops the map entry so
 *    the additive dispatch path re-establishes it. A node that FAILED to
 *    report this pass (e.g. a transient `getLocalCameras` query error) is
 *    left untouched — its truth is unknown, and a transient failure must
 *    never drop live assignments.
 *
 * Devices mid-dispatch (`dispatching`) are excluded from BOTH — a detach or a
 * drop must never race an `attachOn → recordAssignment` window.
 */
export function reconcilePlacement(input: ReconcilePlacementInput): PlacementConvergence {
  const { runners, assignedNodeById, dispatching, idleSessionDeviceIds, motionWatchAttachments } =
    input

  const attachedNodesByDevice = new Map<number, Set<string>>()
  for (const { nodeId, attached } of runners) {
    for (const deviceId of attached) {
      const set = attachedNodesByDevice.get(deviceId) ?? new Set<string>()
      set.add(nodeId)
      attachedNodesByDevice.set(deviceId, set)
    }
  }

  const detach: { nodeId: string; deviceId: number }[] = []
  for (const { nodeId, attached } of runners) {
    for (const deviceId of attached) {
      if (dispatching.has(deviceId)) continue
      const assignedTo = assignedNodeById.get(deviceId)
      if (assignedTo !== undefined && assignedTo !== nodeId) {
        detach.push({ nodeId, deviceId })
        continue
      }
      if (
        assignedTo === undefined &&
        idleSessionDeviceIds.has(deviceId) &&
        !motionWatchAttachments.has(runnerAttachmentKey(nodeId, deviceId))
      ) {
        detach.push({ nodeId, deviceId })
      }
    }
  }

  const reportedNodes = new Set<string>(runners.map((r) => r.nodeId))

  const dropStaleAssignment: number[] = []
  for (const [deviceId, assignedTo] of assignedNodeById) {
    if (dispatching.has(deviceId)) continue
    if (!reportedNodes.has(assignedTo)) continue // assigned node didn't report this pass — truth unknown, never drop
    if (!attachedNodesByDevice.get(deviceId)?.has(assignedTo)) {
      dropStaleAssignment.push(deviceId)
    }
  }

  return { detach, dropStaleAssignment }
}

/**
 * Decide whether an analyzer-class camera should be placed on the singleton
 * `motionNode` cluster role. Mirrors `dispatchAudio`'s role preference: the
 * role node wins for analyzer cameras UNLESS the operator set an explicit
 * per-device pin, and only while the role node is a currently-eligible
 * detection node. When it is not (offline, or can't reach this camera's frame
 * source), returns `null` so the caller falls back to the load balancer —
 * this is the role's automatic failover. Onboard / always-on cameras
 * (`isAnalyzer: false`) never prefer the role node.
 */
export function pickMotionRolePlacement(input: {
  readonly isAnalyzer: boolean
  readonly hasPin: boolean
  readonly motionNode: string
  readonly loadedNodeIds: readonly string[]
  readonly eligibleNodeIds: readonly string[]
}): string | null {
  const { isAnalyzer, hasPin, motionNode, loadedNodeIds, eligibleNodeIds } = input
  if (!isAnalyzer) return null
  if (hasPin) return null
  if (!loadedNodeIds.includes(motionNode)) return null
  if (!eligibleNodeIds.includes(motionNode)) return null
  return motionNode
}

export type SessionAction = 'dispatch' | 'teardown' | 'ignore'

/**
 * Map a motion event to a session-time action for ONE camera. `on-motion`
 * cameras are session-managed; `always-on`/`disabled` are not (they keep the
 * standing model). While a camera still has a standing attach (pre-cutover, or
 * an always-on camera), session dispatch is suppressed so the two models never
 * both place the same device. `dispatch` is idempotent — a re-fire during an
 * active session rearms the fallback cooldown timer. `teardown` (an explicit
 * `detected: false` from the hub) closes the session immediately.
 */
/**
 * Should a detection session close NOW, or has it not yet been open long enough?
 *
 * Measured 2026-08-21 over 25.6 min of live orchestrator logs (817 sessions):
 * median session duration **4.0 s**, **57.6% under 5 s**, and **820 of 822
 * closes were `motion_cleared`** — the hub's explicit falling edge, which closed
 * the session that instant. Camera 104 opened and closed 249 sessions in 25
 * minutes. Each close drops the assignment and each reopen re-elects a node, so
 * the operator saw the placement column flicker every 2-3 seconds, and the
 * cluster paid a full detach+attach for a scene that had not changed.
 *
 * Note what that number also says: `motionCooldownMs`, the non-stationary-track
 * session-hold and `maxSessionHoldMs` all hang off the fallback timer, and the
 * falling edge bypassed all three — 2 closes out of 822 ever reached them. Three
 * operator-visible knobs that decided nothing.
 *
 * This is a FLOOR, deliberately not a fourth authority (D62): `motionCooldownMs`
 * still owns "how long after the last motion tick do we stay open". The floor
 * only says a session cannot be SHORTER than `minOpenMs`, whichever path closes
 * it — so a close that arrives early is DEFERRED to the deadline, never
 * discarded. `minOpenMs <= 0` disables it and restores the old behaviour
 * exactly.
 *
 * Pure. A `openForMs` that came out negative (clock stepped backwards) defers
 * the full window rather than trusting the arithmetic.
 */
export type SessionCloseDecision =
  | { readonly kind: 'close' }
  | { readonly kind: 'defer'; readonly delayMs: number }

export function decideSessionClose(input: {
  readonly openForMs: number
  readonly minOpenMs: number
}): SessionCloseDecision {
  const { openForMs, minOpenMs } = input
  if (minOpenMs <= 0) return { kind: 'close' }
  if (openForMs >= minOpenMs) return { kind: 'close' }
  const remaining = openForMs < 0 ? minOpenMs : minOpenMs - openForMs
  return { kind: 'defer', delayMs: remaining }
}

/** Which lifecycle clock asked for the close. */
export type SessionCloseReason = 'motion_cleared' | 'cooldown_expired'

/**
 * What to do with a session a close path just asked about.
 *
 *  - `close` — detach now.
 *  - `defer-floor` — the session has not met {@link decideSessionClose}'s
 *    minimum open time; re-ask in `delayMs`.
 *  - `hold` — a subject is still PRESENT and the cap has room; re-ask in
 *    `recheckInMs`.
 */
export type SessionLifecycleVerdict =
  | { readonly kind: 'close' }
  | { readonly kind: 'defer-floor'; readonly delayMs: number }
  | { readonly kind: 'hold'; readonly recheckInMs: number }

export interface SessionLifecycleInput {
  /** Wall time since the session was dispatched. */
  readonly openForMs: number
  /** {@link decideSessionClose}'s floor. `<= 0` disables it. */
  readonly minOpenMs: number
  /** The unconditional cap on the hold. `<= 0` disables holding entirely. */
  readonly maxHoldMs: number
  /** Age of the last "a subject is tracked here" frame, or `null` if never. */
  readonly sinceSubjectSeenMs: number | null
  /** How old that signal may be and still mean "present". */
  readonly subjectStaleMs: number
  /** Cadence at which a hold re-asks this question. */
  readonly recheckMs: number
}

/**
 * The ONE rule every session close path obeys — the hub's explicit
 * `motion_cleared` falling edge, the `cooldown_expired` fallback timer, and
 * the re-ask of a close that was deferred to the floor.
 *
 * ## Why it is one rule
 *
 * It used to be two, and the second one was unreachable. The falling edge went
 * straight to the floor check; the hold, the cap and the track-freshness read
 * all lived inside the COOLDOWN TIMER's body. On a camera that emits an
 * explicit low edge — which is every camera — the timer body never ran.
 * Measured on device 102 over 24 h, 503 paired sessions: **502 closed on
 * `motion_cleared`**, 1 on the cooldown, 0 on `maxSessionHoldMs`, and the
 * "held open" branch fired **0 times**. Median session life 10 221 ms against a
 * 10 000 ms floor — not a duration, a floor. 71.5% of the tracks that died in
 * that window died in the exact instant of the teardown, having already been
 * motionless for a median 6.27 s: the stationary registry's 30 s promotion
 * window was unreachable for every on-motion camera in the fleet.
 *
 * ## The tension, and what resolves it
 *
 * "Hold while a subject is present" alone is a WORSE fault than the defect: a
 * parked car in frame would hold the session open forever and run detection at
 * 100% uptime on every camera that sees one. Two things stop that, and both
 * must stay true:
 *
 *  1. **Promotion ends the wait.** The presence signal is derived from the
 *     post-suppression tracked set, so the instant the stationary registry
 *     promotes the parked object it stops being present, the hold lapses and
 *     the session closes. Later detections of the same object are suppressed
 *     by the registry, so they never re-open anything either.
 *  2. **`maxHoldMs` is unconditional.** Once `openForMs >= maxHoldMs` no
 *     verdict can be `hold`, whatever the subject is doing — which bounds the
 *     failure even with the registry disabled or a class it never promotes.
 *
 * ## Ordering
 *
 * The hold outranks the floor because it is strictly longer; the floor then
 * decides the close it did not hold. `sinceSubjectSeenMs` that came out
 * NEGATIVE (a clock step) counts as present: the non-destructive direction is
 * the safe one for a read this fallible (D49), and `maxHoldMs` bounds it
 * anyway. Pure — the caller owns every clock.
 */
export function decideSessionLifecycle(input: SessionLifecycleInput): SessionLifecycleVerdict {
  const { openForMs, minOpenMs, maxHoldMs, sinceSubjectSeenMs, subjectStaleMs, recheckMs } = input
  const capRemainingMs = maxHoldMs - openForMs
  const subjectPresent = sinceSubjectSeenMs !== null && sinceSubjectSeenMs < subjectStaleMs
  if (maxHoldMs > 0 && capRemainingMs > 0 && subjectPresent) {
    // Never overshoot the cap: the last recheck of a hold lands exactly on it.
    return {
      kind: 'hold',
      recheckInMs: Math.max(1, Math.min(recheckMs, capRemainingMs)),
    }
  }
  const floor = decideSessionClose({ openForMs, minOpenMs })
  return floor.kind === 'close'
    ? { kind: 'close' }
    : { kind: 'defer-floor', delayMs: floor.delayMs }
}

export function decideSessionAction(input: {
  readonly detectionMode: PipelinePhaseMode
  readonly detected: boolean
  readonly hasActiveSession: boolean
  readonly hasStandingAttach: boolean
}): SessionAction {
  const { detectionMode, detected, hasActiveSession, hasStandingAttach } = input
  if (detectionMode !== 'on-motion') return 'ignore'
  if (hasStandingAttach) return 'ignore'
  if (detected) return 'dispatch'
  return hasActiveSession ? 'teardown' : 'ignore'
}
