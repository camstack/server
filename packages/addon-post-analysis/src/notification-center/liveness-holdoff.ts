/**
 * Trailing hold-off for device liveness notifications.
 *
 * A plugin restart flips every camera offline then online within seconds. The
 * durable ledger correctly records each flip, and the rule cooldown is per
 * direction, so the operator got 2×N pushes. This timer waits until the
 * subject's state has been STABLE for {@link DEVICE_LIVENESS_HOLDOFF_MS}; if
 * it bounced back to the last notified (or seeded) state, nothing is sent.
 *
 * Node liveness rides a SECOND instance with a much shorter delay
 * ({@link NODE_LIVENESS_HOLDOFF_MS}): an agent that is down for five silent
 * minutes is the opposite of the restart flap the device delay swallows, but a
 * node's reconnect storm is real — on 2026-10-09 `agent-a` came back from
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

export const DEVICE_LIVENESS_HOLDOFF_MS = 5 * 60_000

/** Grace before a node offline (or its recovery) is announced — see the docblock. */
export const NODE_LIVENESS_HOLDOFF_MS = 60_000

export function isNodeLivenessKind(kind: string): boolean {
  return kind === 'node-online' || kind === 'node-offline'
}

/** When the state being announced began, and when the one it replaces began. */
export interface LivenessTiming {
  /** Epoch ms the subject first left the previously notified state. */
  readonly since: number
  /** Epoch ms the previously notified state began; absent when it was only seeded. */
  readonly previousSince?: number
}

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

export interface DeviceLivenessHoldoffOptions {
  readonly delayMs?: number
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
  private readonly delayMs: number
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly cancel: (id: ReturnType<typeof setTimeout>) => void

  constructor(
    private readonly flush: (event: NcIncomingEvent, timing: LivenessTiming) => void,
    options: DeviceLivenessHoldoffOptions = {},
  ) {
    this.delayMs = options.delayMs ?? DEVICE_LIVENESS_HOLDOFF_MS
    this.schedule = options.schedule ?? setTimeout
    this.cancel = options.cancel ?? clearTimeout
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

  /** Directory-seeded rows never pass through {@link remember}; first flip does. */
  rememberIfAbsent(subject: string, state: NcLivenessState): void {
    if (!this.lastNotified.has(subject)) this.lastNotified.set(subject, state)
  }

  /**
   * A real ledger flip. Starts / resets the trailing timer. `delayMs` replaces
   * the default delay for THIS arm only (a node's planned-update grace).
   */
  arm(subject: string, incoming: NcIncomingEvent, delayMs?: number): void {
    const delay = delayMs ?? this.delayMs
    this.pending.set(subject, incoming)
    this.trackDeparture(subject, incoming)
    const existing = this.timers.get(subject)
    if (existing !== undefined) this.cancel(existing)
    if (delay <= 0) {
      this.timers.delete(subject)
      this.fire(subject)
      return
    }
    const id = this.schedule(() => {
      this.timers.delete(subject)
      this.fire(subject)
    }, delay)
    this.timers.set(subject, id)
  }

  dispose(): void {
    for (const id of this.timers.values()) this.cancel(id)
    this.timers.clear()
    this.pending.clear()
    this.departedAt.clear()
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
