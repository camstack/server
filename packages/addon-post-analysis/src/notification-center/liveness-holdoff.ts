/**
 * Trailing hold-off for device liveness notifications.
 *
 * A plugin restart flips every camera offline then online within seconds. The
 * durable ledger correctly records each flip, and the rule cooldown is per
 * direction, so the operator got 2×N pushes. This timer waits until the
 * subject's state has been STABLE for {@link DEVICE_LIVENESS_HOLDOFF_MS}; if
 * it bounced back to the last notified (or seeded) state, nothing is sent.
 *
 * Node liveness rides a SECOND instance with its own delay
 * ({@link NODE_LIVENESS_HOLDOFF_MS}), longer than the device one: a node's
 * reconnect storm is real — on 2026-10-09 `agent-a` came back from
 * a memory-thrash freeze and flipped offline/online every 2–6 s for twenty
 * minutes (≈90 node events per 15 min) while the mesh re-authenticated it.
 * Sixty seconds is long enough to swallow that, short enough to still be the
 * "instant" notification the operator asked for.
 *
 * TIMING. The hold-off also remembers WHEN each notified state began (the
 * moment the subject first left the previous notified state, not the moment
 * the timer fired), so a recovery can say how long the outage lasted. A state
 * that was only seeded has no known start — `previousSince` is then absent.
 */

import type { NcIncomingEvent } from './event-intake.js'
import type { NcLivenessState } from './liveness-ledger.js'

/**
 * Ninety seconds (planning#714, D1100 supersedes the 15 s of 2026-11-24): the
 * D1099 gate holds a device `unknown` only on the restart paths wired into
 * it; agent-hosted runners, hub-main in-process addons and crash respawns
 * still flap a device offline then online (a gateway back after 15 s, sensors
 * and climates within seconds). This window is the catch-all. It stays under
 * the 120 s D1099 bound. A fixed constant, not an operator knob.
 */
export const DEVICE_LIVENESS_HOLDOFF_MS = 90_000

/**
 * Stream offline / online keep their own short window (D1100): a stream's
 * offline already waited out the broker's 120 s stale window before it
 * reached the centre, so stacking the 90 s device window on it would announce
 * a dead stream ~210 s late. A stream that drops and returns within it sends
 * nothing.
 */
export const STREAM_LIVENESS_HOLDOFF_MS = 15_000

/** Grace before a node offline (or its recovery) is announced — see the docblock. */
export const NODE_LIVENESS_HOLDOFF_MS = 60_000

export function isNodeLivenessKind(kind: string): boolean {
  return kind === 'node-online' || kind === 'node-offline'
}

export function isStreamLivenessKind(kind: string): boolean {
  return kind === 'stream-online' || kind === 'stream-offline'
}

/** When the state being announced began, and when the one it replaces began. */
export interface LivenessTiming {
  /** Epoch ms the subject first left the previously notified state. */
  readonly since: number
  /** Epoch ms the previously notified state began; absent when it was only seeded. */
  readonly previousSince?: number
}

/** A state the ledger accepted, and when it began. */
export interface LivenessAccepted {
  readonly state: NcLivenessState
  readonly since: number
}

/**
 * What {@link DeviceLivenessHoldoff.hydrateAccepted} did: nothing (the
 * process already knows the subject), took the accepted state, or treated a
 * young offline as never announced.
 */
export type LivenessHydration = 'known' | 'hydrated' | 'unannounced-offline'

export function isDeviceLivenessKind(kind: string): boolean {
  return (
    kind === 'device-online' ||
    kind === 'device-offline' ||
    kind === 'camera-online' ||
    kind === 'camera-offline'
  )
}

function livenessStateOfKind(kind: string): NcLivenessState {
  return kind.endsWith('-offline') ? 'offline' : 'online'
}

/** A flip that returned to the notified state before its window ended. */
export interface LivenessSuppressed {
  readonly subject: string
  /** The state that was held and then abandoned. */
  readonly flip: NcLivenessState
  /** The notified (or seeded) state the subject returned to. */
  readonly revertedTo: NcLivenessState
  /** Ms between the first departure and the return. */
  readonly elapsedMs: number
}

/** A pending flip dropped because its integration said it has not answered. */
export interface LivenessCancelled {
  readonly subject: string
  /** The state that was waiting to be announced. */
  readonly flip: NcLivenessState
}

/**
 * What the device directory says about a flip's device RIGHT NOW (planning#726):
 * `speak` - the flip may be announced (a first-level device, OR an id the warm
 * directory cannot place: unknown is never evidence of an accessory);
 * `accessory` - it hangs off another device, liveness is not its fact;
 * `unplaced` - the directory has not answered yet, so it cannot say either way.
 */
export type LivenessJudgement = 'speak' | 'accessory' | 'unplaced'

/** A flip dropped without being announced, because of the directory. */
export interface LivenessDirectoryDrop {
  readonly subject: string
  readonly flip: NcLivenessState
  /** `accessory`: the directory placed it so. `forgotten` / `disposed`: it was parked and the subject went away. */
  readonly reason: 'accessory' | 'forgotten' | 'disposed'
}

/** A flip parked for the directory, now let go. */
export interface LivenessDirectoryRelease {
  readonly subject: string
  readonly flip: NcLivenessState
  /** `directory-warm`: it answered, the full window starts. `bound`: it never did, the flip speaks. */
  readonly reason: 'directory-warm' | 'bound'
  /** Ms the flip waited for the directory. */
  readonly heldMs: number
}

export interface DeviceLivenessHoldoffOptions {
  readonly delayMs?: number
  /** Judges a flip's device against the directory, no I/O. Absent = every flip speaks. */
  readonly judge?: (event: NcIncomingEvent) => LivenessJudgement
  /** Called when a flip is dropped because of its judgement (logged by the owner). */
  readonly onDirectoryDrop?: (event: NcIncomingEvent, info: LivenessDirectoryDrop) => void
  /** Called when a parked flip is released, by the directory warming or by the bound. */
  readonly onDirectoryRelease?: (event: NcIncomingEvent, info: LivenessDirectoryRelease) => void
  /** Called when a pending flip is cancelled by its own reversal (logged by the owner). */
  readonly onSuppressed?: (event: NcIncomingEvent, info: LivenessSuppressed) => void
  readonly schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly cancel?: (id: ReturnType<typeof setTimeout>) => void
}

export class DeviceLivenessHoldoff {
  private readonly pending = new Map<string, NcIncomingEvent>()
  private readonly lastNotified = new Map<string, NcLivenessState>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** First divergence from the last notified state, per subject (cleared on a bounce back). */
  private readonly departedAt = new Map<string, number>()
  /** When the last notified state began, per subject. */
  private readonly stateSince = new Map<string, number>()
  /** Subjects whose integration has not answered: nothing may arm for them (planning#718). */
  private readonly notReady = new Set<string>()
  /** The latest flip that arrived while its subject was not ready, armed at {@link markReady}. */
  private readonly parked = new Map<string, NcIncomingEvent>()
  /** Flips for a device the directory cannot place yet; judged when it loads ({@link releaseDirectoryParked}). */
  private readonly awaitingDirectory = new Map<string, { event: NcIncomingEvent; since: number }>()
  /** The bound on that wait: a directory that never warms must not silence a real outage. */
  private readonly directoryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly onDirectoryRelease:
    | ((event: NcIncomingEvent, info: LivenessDirectoryRelease) => void)
    | undefined
  private readonly delayMs: number
  private readonly judge: ((event: NcIncomingEvent) => LivenessJudgement) | undefined
  private readonly onDirectoryDrop:
    | ((event: NcIncomingEvent, info: LivenessDirectoryDrop) => void)
    | undefined
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly cancel: (id: ReturnType<typeof setTimeout>) => void
  private readonly onSuppressed:
    | ((event: NcIncomingEvent, info: LivenessSuppressed) => void)
    | undefined

  constructor(
    private readonly flush: (event: NcIncomingEvent, timing: LivenessTiming) => void,
    options: DeviceLivenessHoldoffOptions = {},
  ) {
    this.delayMs = options.delayMs ?? DEVICE_LIVENESS_HOLDOFF_MS
    this.schedule = options.schedule ?? setTimeout
    this.cancel = options.cancel ?? clearTimeout
    this.onSuppressed = options.onSuppressed
    this.judge = options.judge
    this.onDirectoryDrop = options.onDirectoryDrop
    this.onDirectoryRelease = options.onDirectoryRelease
  }

  /** A deleted subject: no timer may fire for it, and nothing about it is kept. */
  forget(subject: string): void {
    const timer = this.timers.get(subject)
    if (timer !== undefined) this.cancel(timer)
    this.timers.delete(subject)
    this.pending.delete(subject)
    this.departedAt.delete(subject)
    this.lastNotified.delete(subject)
    this.stateSince.delete(subject)
    this.notReady.delete(subject)
    this.parked.delete(subject)
    this.discardAwaiting(subject, 'forgotten')
  }

  /** Removes a flip parked for the directory without announcing it, and says so. */
  private discardAwaiting(subject: string, reason: 'forgotten' | 'disposed'): void {
    const waiting = this.awaitingDirectory.get(subject)
    this.clearDirectoryTimer(subject)
    this.awaitingDirectory.delete(subject)
    const kind = waiting?.event.subject.systemEvent?.kind
    if (waiting === undefined || kind === undefined) return
    this.onDirectoryDrop?.(waiting.event, { subject, flip: livenessStateOfKind(kind), reason })
  }

  private clearDirectoryTimer(subject: string): void {
    const timer = this.directoryTimers.get(subject)
    if (timer !== undefined) this.cancel(timer)
    this.directoryTimers.delete(subject)
  }

  /**
   * The device is an accessory (or unknown): whatever flip waits for it - on
   * its timer, parked for its integration or for the directory - is dropped.
   * Returns the flip that was waiting, `null` when none was.
   */
  cancelFlip(subject: string): LivenessCancelled | null {
    const held =
      this.pending.get(subject) ??
      this.parked.get(subject) ??
      this.awaitingDirectory.get(subject)?.event
    const heldKind = held?.subject.systemEvent?.kind
    const timer = this.timers.get(subject)
    if (timer !== undefined) this.cancel(timer)
    this.timers.delete(subject)
    this.pending.delete(subject)
    this.parked.delete(subject)
    this.clearDirectoryTimer(subject)
    this.awaitingDirectory.delete(subject)
    this.departedAt.delete(subject)
    return heldKind !== undefined ? { subject, flip: livenessStateOfKind(heldKind) } : null
  }

  /**
   * The directory has answered: judge every flip parked for it. A device it
   * places as an accessory is dropped; every other one (first-level, or an id
   * it does not know) is armed now and the full window starts here.
   */
  releaseDirectoryParked(): void {
    const waiting = [...this.awaitingDirectory.entries()]
    for (const [subject, { event, since }] of waiting) {
      this.clearDirectoryTimer(subject)
      this.awaitingDirectory.delete(subject)
      if (this.dropByJudgement(subject, event)) continue
      this.reportRelease(subject, event, since, 'directory-warm')
      this.arm(subject, event)
    }
  }

  private reportRelease(
    subject: string,
    event: NcIncomingEvent,
    since: number,
    reason: 'directory-warm' | 'bound',
  ): void {
    const kind = event.subject.systemEvent?.kind
    if (kind === undefined) return
    this.onDirectoryRelease?.(event, {
      subject,
      flip: livenessStateOfKind(kind),
      reason,
      heldMs: Math.max(0, Date.now() - since),
    })
  }

  /** The bound passed and the directory never answered: the flip speaks as a first-level one. */
  private releaseByBound(subject: string): void {
    this.directoryTimers.delete(subject)
    const waiting = this.awaitingDirectory.get(subject)
    this.awaitingDirectory.delete(subject)
    if (waiting === undefined) return
    this.reportRelease(subject, waiting.event, waiting.since, 'bound')
    this.trackDeparture(subject, waiting.event)
    this.deliver(subject, waiting.event)
  }

  /** Drops the flip when the directory places its device as an accessory. */
  private dropByJudgement(subject: string, incoming: NcIncomingEvent): boolean {
    if (this.judge?.(incoming) !== 'accessory') return false
    const kind = incoming.subject.systemEvent?.kind
    this.onDirectoryDrop?.(incoming, {
      subject,
      flip: kind !== undefined ? livenessStateOfKind(kind) : 'offline',
      reason: 'accessory',
    })
    return true
  }

  /**
   * The subject's integration has not answered (an `unknown` status slice).
   * A flip waiting on its timer was judged against a state nobody confirmed:
   * it is cancelled and returned so the owner can say so. Until
   * {@link markReady}, `arm` parks instead of arming.
   */
  markNotReady(subject: string): LivenessCancelled | null {
    this.notReady.add(subject)
    this.parked.delete(subject)
    const held = this.pending.get(subject)
    const heldKind = held?.subject.systemEvent?.kind
    const timer = this.timers.get(subject)
    if (timer !== undefined) this.cancel(timer)
    this.timers.delete(subject)
    this.pending.delete(subject)
    this.departedAt.delete(subject)
    return heldKind !== undefined ? { subject, flip: livenessStateOfKind(heldKind) } : null
  }

  /**
   * The integration answered. A flip parked meanwhile is armed now, so the
   * comparison is the LIVE state against the last NOTIFIED one and the full
   * window starts at the answer. Returns whether one was armed.
   */
  markReady(subject: string): boolean {
    if (!this.notReady.delete(subject)) return false
    const parked = this.parked.get(subject)
    this.parked.delete(subject)
    if (parked === undefined) return false
    this.arm(subject, parked)
    return true
  }

  /** The seeded (or last delivered) state — a bounce back to this is silence. */
  remember(subject: string, state: NcLivenessState): void {
    this.lastNotified.set(subject, state)
    // A state taken as known without a notification (seed, or a recovery the
    // operator silenced) settles the subject: a flip still waiting on its
    // timer is now stale and must not be announced after the fact.
    const pending = this.timers.get(subject)
    if (pending !== undefined) this.cancel(pending)
    this.timers.delete(subject)
    this.pending.delete(subject)
    this.departedAt.delete(subject)
  }

  /**
   * A subject the ledger does not govern (streams) has no seeded state: its
   * first observed edge is an offline, so the state before it was online. Take
   * that as the baseline unless the subject is already known, so the bounce
   * back is silent.
   */
  assumeOnline(subject: string): void {
    if (!this.lastNotified.has(subject)) this.lastNotified.set(subject, 'online')
  }

  /**
   * The first flip of a subject this process never notified: take the state
   * the ledger ACCEPTED as the baseline — but accepted is not notified.
   *
   * An `offline` younger than the hold-off delay cannot have been announced:
   * the process that accepted it died before its timer matured (2026-11-12, a
   * post-analysis respawn turned 65 device restarts into 65 "back online"
   * pushes). It hydrates as `online`, so the bounce back is silent. An older
   * one was announced, and its recovery still is — knowing, from the row, when
   * the outage began.
   */
  hydrateAccepted(subject: string, accepted: LivenessAccepted, now: number): LivenessHydration {
    if (this.lastNotified.has(subject)) return 'known'
    if (accepted.state === 'offline' && now - accepted.since < this.delayMs) {
      this.lastNotified.set(subject, 'online')
      return 'unannounced-offline'
    }
    this.lastNotified.set(subject, accepted.state)
    this.stateSince.set(subject, accepted.since)
    return 'hydrated'
  }

  /**
   * A real ledger flip. Starts / resets the trailing timer. `delayMs` replaces
   * the default delay for THIS arm only (a node's planned-update grace).
   */
  arm(
    subject: string,
    incoming: NcIncomingEvent,
    delayMs?: number,
  ): 'armed' | 'parked' | 'awaiting-directory' {
    if (this.judge?.(incoming) === 'unplaced') {
      this.parkForDirectory(subject, incoming, delayMs ?? this.delayMs)
      return 'awaiting-directory'
    }
    if (this.notReady.has(subject)) {
      this.parked.set(subject, incoming)
      return 'parked'
    }
    const delay = delayMs ?? this.delayMs
    if (this.revertsPending(subject, incoming)) return 'armed'
    this.pending.set(subject, incoming)
    this.trackDeparture(subject, incoming)
    const existing = this.timers.get(subject)
    if (existing !== undefined) this.cancel(existing)
    if (delay <= 0) {
      this.timers.delete(subject)
      this.fire(subject)
      return 'armed'
    }
    const id = this.schedule(() => {
      this.timers.delete(subject)
      this.fire(subject)
    }, delay)
    this.timers.set(subject, id)
    return 'armed'
  }

  /** Parks a flip for a directory that has not answered, bounded by `boundMs` (then it speaks). */
  private parkForDirectory(subject: string, incoming: NcIncomingEvent, boundMs: number): void {
    const held = this.awaitingDirectory.get(subject)
    this.clearDirectoryTimer(subject)
    this.awaitingDirectory.set(subject, { event: incoming, since: held?.since ?? Date.now() })
    if (boundMs <= 0) {
      this.releaseByBound(subject)
      return
    }
    this.directoryTimers.set(
      subject,
      this.schedule(() => this.releaseByBound(subject), boundMs),
    )
  }

  dispose(): void {
    for (const subject of [...this.awaitingDirectory.keys()])
      this.discardAwaiting(subject, 'disposed')
    for (const id of this.timers.values()) this.cancel(id)
    this.timers.clear()
    this.pending.clear()
    this.departedAt.clear()
    this.parked.clear()
  }

  /**
   * The subject came back to the state it was last notified in while a flip
   * away from it was still waiting: both are cancelled, nothing is sent.
   */
  private revertsPending(subject: string, incoming: NcIncomingEvent): boolean {
    const kind = incoming.subject.systemEvent?.kind
    const held = this.pending.get(subject)
    const heldKind = held?.subject.systemEvent?.kind
    if (kind === undefined || held === undefined || heldKind === undefined) return false
    const state = livenessStateOfKind(kind)
    if (this.lastNotified.get(subject) !== state) return false
    const timer = this.timers.get(subject)
    if (timer !== undefined) this.cancel(timer)
    this.timers.delete(subject)
    this.pending.delete(subject)
    const departed = this.departedAt.get(subject) ?? held.subject.timestamp
    this.departedAt.delete(subject)
    this.onSuppressed?.(incoming, {
      subject,
      flip: livenessStateOfKind(heldKind),
      revertedTo: state,
      elapsedMs: Math.max(0, incoming.subject.timestamp - departed),
    })
    return true
  }

  private trackDeparture(subject: string, incoming: NcIncomingEvent): void {
    const kind = incoming.subject.systemEvent?.kind
    if (kind === undefined) return
    if (this.lastNotified.get(subject) === livenessStateOfKind(kind)) {
      this.departedAt.delete(subject)
      return
    }
    if (!this.departedAt.has(subject)) this.departedAt.set(subject, incoming.subject.timestamp)
  }

  private fire(subject: string): void {
    const incoming = this.pending.get(subject)
    this.pending.delete(subject)
    if (incoming === undefined) return
    const kind = incoming.subject.systemEvent?.kind
    if (kind === undefined) return
    // The directory is read AGAIN at the moment of speaking: it may have
    // placed the device as an accessory since the flip armed. (A cold
    // directory cannot reach here: `arm` parks that flip, and a directory that
    // has answered stays answered.)
    if (this.dropByJudgement(subject, incoming)) {
      this.departedAt.delete(subject)
      return
    }
    this.deliver(subject, incoming)
  }

  private deliver(subject: string, incoming: NcIncomingEvent): void {
    const kind = incoming.subject.systemEvent?.kind
    if (kind === undefined) return
    const state = livenessStateOfKind(kind)
    if (this.lastNotified.get(subject) === state) return
    this.lastNotified.set(subject, state)
    const since = this.departedAt.get(subject) ?? incoming.subject.timestamp
    const previousSince = this.stateSince.get(subject)
    this.departedAt.delete(subject)
    this.stateSince.set(subject, since)
    this.flush(incoming, previousSince !== undefined ? { since, previousSince } : { since })
  }
}
