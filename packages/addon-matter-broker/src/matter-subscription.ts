/**
 * Per-node Matter attribute subscriptions. The matter.js call itself lives in
 * {@link import('./matter-peer-subscribe.js')}; this module owns the lifecycle:
 * open, resubscribe after the session drops or the node returns, and a bounded
 * backoff. A report whose value is missing is not a value (D393) and is dropped.
 */

import { errMsg, type IScopedLogger } from '@camstack/types'
import type { MatterAttributeReport, MatterEventReport } from './matter-controller.js'

/** First wait before our own re-establishment of an offline node's subscription. */
export const SUBSCRIPTION_BACKOFF_INITIAL_MS = 15_000
/** Longest one subscribe attempt may take before it counts as failed. */
export const SUBSCRIBE_ATTEMPT_TIMEOUT_MS = 90_000
/** Every Nth retry of an unreachable node logs a summary at info. */
export const SUBSCRIPTION_SUMMARY_EVERY = 10
/** Cap so a sleepy Thread node cannot be hammered. */
export const SUBSCRIPTION_BACKOFF_MAX_MS = 60_000

export type SubscriptionPhase =
  | 'subscribed'
  | 'offline'
  | 'online'
  | 'backing-off'
  | 'resubscribing'
  | 'subscribe-failed'

export interface MatterPeerSubscription {
  close(): Promise<void>
}

export interface MatterSubscriptionHandlers {
  onReport: (report: MatterAttributeReport) => void
  onEvent: (event: MatterEventReport) => void
}

/** The structural peer surface the supervisor drives. Production adapts matter.js. */
export interface MatterSubscribablePeer {
  readonly nodeId: string
  online(): boolean
  subscribe(handlers: MatterSubscriptionHandlers): Promise<MatterPeerSubscription>
  onOnline(handler: () => void): () => void
  onOffline(handler: () => void): () => void
}

export interface MatterSubscriptionSupervisorOptions {
  readonly brokerId: string
  readonly logger: IScopedLogger
  /** CamStack device id for the node container, when the node has been adopted. */
  readonly resolveDeviceId: (nodeId: string) => number | null
  readonly onReport: (report: MatterAttributeReport) => void
  /** Matter events (lock operations, switch presses). Optional: a test may not care. */
  readonly onEvent?: (event: MatterEventReport) => void
  /** A node's peer went offline / came back (drives the per-device online flag). */
  readonly onPresence?: (nodeId: string, online: boolean) => void
}

interface Slot {
  peer: MatterSubscribablePeer
  phase: SubscriptionPhase
  attempt: number
  timer: ReturnType<typeof setTimeout> | null
  subscription: MatterPeerSubscription | null
  unlisten: Array<() => void>
  generation: number
  /** True while a subscribe attempt is in flight: never two per node. */
  opening: boolean
  listening: boolean
  /** True while we are closing the subscription ourselves (stop / node gone). */
  dropping: boolean
}

/**
 * One supervisor per fabric. `sync` is safe to call on start, after commission,
 * and on the reconcile timer (the backstop when a lifecycle event was missed).
 */
export class MatterSubscriptionSupervisor {
  readonly #brokerId: string
  readonly #logger: IScopedLogger
  readonly #resolveDeviceId: (nodeId: string) => number | null
  readonly #onReport: (report: MatterAttributeReport) => void
  readonly #onEvent: (event: MatterEventReport) => void
  readonly #onPresence: (nodeId: string, online: boolean) => void
  readonly #slots: Map<string, Slot> = new Map()
  #stopped = false

  constructor(options: MatterSubscriptionSupervisorOptions) {
    this.#brokerId = options.brokerId
    this.#logger = options.logger
    this.#resolveDeviceId = options.resolveDeviceId
    this.#onReport = options.onReport
    this.#onEvent = options.onEvent ?? (() => undefined)
    this.#onPresence = options.onPresence ?? (() => undefined)
  }

  /** How many times `subscribe` has been entered for a node (tests). */
  subscribeAttempts(nodeId: string): number {
    return this.#slots.get(nodeId)?.generation ?? 0
  }

  phase(nodeId: string): SubscriptionPhase | null {
    return this.#slots.get(nodeId)?.phase ?? null
  }

  async sync(peers: readonly MatterSubscribablePeer[]): Promise<void> {
    if (this.#stopped) return
    const live = new Set<string>()
    for (const peer of peers) {
      live.add(peer.nodeId)
      const slot = this.#slots.get(peer.nodeId)
      if (slot === undefined) {
        await this.#open(peer)
        continue
      }
      slot.peer = peer
      const cameBack = slot.phase !== 'subscribed' && peer.online()
      if (cameBack && !slot.opening) {
        slot.attempt = 0
        await this.#open(peer)
      } else if (
        !slot.opening &&
        slot.timer === null &&
        (slot.phase === 'offline' || slot.phase === 'subscribe-failed')
      ) {
        // Backstop: an offline slot always has a retry armed.
        this.#schedule(peer.nodeId)
      }
    }
    for (const [nodeId, slot] of this.#slots) {
      if (live.has(nodeId)) continue
      await this.#drop(slot)
      this.#slots.delete(nodeId)
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true
    for (const slot of this.#slots.values()) {
      await this.#drop(slot)
    }
    this.#slots.clear()
  }

  async #open(peer: MatterSubscribablePeer): Promise<void> {
    if (this.#stopped) return
    const existing = this.#slots.get(peer.nodeId)
    if (existing?.opening === true) return
    if (existing?.phase === 'subscribed' && existing.subscription !== null) return
    if (existing?.timer !== null && existing?.timer !== undefined) {
      clearTimeout(existing.timer)
      existing.timer = null
    }
    const generation = (existing?.generation ?? 0) + 1
    const slot = existing ?? this.#fresh(peer)
    slot.peer = peer
    slot.generation = generation
    slot.phase = 'resubscribing'
    slot.opening = true
    this.#slots.set(peer.nodeId, slot)
    this.#listen(slot)
    this.#log(peer.nodeId, 'resubscribing', { attempt: slot.attempt }, this.#perAttempt(slot))
    // Closing the previous sustained subscription restarts matter.js's own
    // (15 s doubling to 1 h) schedule, so reopening is a fresh attempt.
    const stale = slot.subscription
    slot.subscription = null
    if (stale !== null) await stale.close().catch(() => undefined)
    let subscription: MatterPeerSubscription
    try {
      subscription = await this.#subscribeBounded(peer, {
        onReport: (report) => {
          if (report.value === undefined || report.value === null) return
          this.#onReport(report)
        },
        onEvent: (event) => {
          this.#onEvent(event)
        },
      })
    } catch (err: unknown) {
      slot.opening = false
      this.#log(
        peer.nodeId,
        'subscribe-failed',
        {
          error: errMsg(err),
          errStack: err instanceof Error ? err.stack : undefined,
          attempt: slot.attempt,
        },
        this.#perAttempt(slot),
      )
      const current = this.#slots.get(peer.nodeId)
      if (current === undefined || current.generation !== generation || this.#stopped) return
      current.phase = 'subscribe-failed'
      this.#schedule(peer.nodeId)
      return
    }
    slot.opening = false
    if (this.#stopped || this.#slots.get(peer.nodeId)?.generation !== generation) {
      await subscription.close().catch(() => undefined)
      return
    }
    slot.subscription = subscription
    if (!peer.online()) {
      // The sustained subscription exists but the node is unreachable: keep
      // re-establishing on our own schedule until it answers.
      slot.phase = 'offline'
      this.#log(
        peer.nodeId,
        'offline',
        { attempt: slot.attempt, outcome: 'still-offline' },
        this.#perAttempt(slot),
      )
      this.#schedule(peer.nodeId)
      return
    }
    slot.phase = 'subscribed'
    slot.attempt = 0
    this.#log(peer.nodeId, 'subscribed')
  }

  #schedule(nodeId: string): void {
    const slot = this.#slots.get(nodeId)
    if (slot === undefined || this.#stopped) return
    if (slot.timer !== null) clearTimeout(slot.timer)
    const delay = Math.min(
      SUBSCRIPTION_BACKOFF_MAX_MS,
      SUBSCRIPTION_BACKOFF_INITIAL_MS * 2 ** slot.attempt,
    )
    slot.attempt += 1
    if (slot.phase !== 'offline') slot.phase = 'backing-off'
    this.#log(nodeId, 'backing-off', { delayMs: delay, attempt: slot.attempt }, false)
    slot.timer = setTimeout(() => {
      slot.timer = null
      void this.#open(slot.peer)
    }, delay)
    if (typeof slot.timer.unref === 'function') slot.timer.unref()
  }

  #listen(slot: Slot): void {
    if (slot.listening) return
    slot.listening = true
    slot.unlisten.push(
      slot.peer.onOffline(() => {
        const current = this.#slots.get(slot.peer.nodeId)
        if (current === undefined || this.#stopped) return
        if (current.phase === 'offline') return
        current.phase = 'offline'
        this.#log(slot.peer.nodeId, 'offline')
        this.#onPresence(slot.peer.nodeId, false)
        if (!current.opening) this.#schedule(slot.peer.nodeId)
      }),
    )
    slot.unlisten.push(
      slot.peer.onOnline(() => {
        const current = this.#slots.get(slot.peer.nodeId)
        if (current === undefined || this.#stopped) return
        current.attempt = 0
        if (current.timer !== null) {
          clearTimeout(current.timer)
          current.timer = null
        }
        this.#log(slot.peer.nodeId, 'online')
        this.#onPresence(slot.peer.nodeId, true)
        void this.#open(current.peer)
      }),
    )
  }

  async #drop(slot: Slot): Promise<void> {
    slot.dropping = true
    if (slot.timer !== null) clearTimeout(slot.timer)
    slot.timer = null
    for (const unlisten of slot.unlisten) unlisten()
    slot.unlisten = []
    const subscription = slot.subscription
    slot.subscription = null
    if (subscription !== null) {
      try {
        await subscription.close()
      } catch (err: unknown) {
        this.#logger.warn('Matter subscription close failed', {
          tags: this.#tags(slot.peer.nodeId),
          meta: { nodeId: slot.peer.nodeId, error: errMsg(err) },
        })
      }
    }
  }

  #fresh(peer: MatterSubscribablePeer): Slot {
    return {
      peer,
      phase: 'resubscribing',
      attempt: 0,
      timer: null,
      subscription: null,
      unlisten: [],
      generation: 0,
      opening: false,
      listening: false,
      dropping: false,
    }
  }

  #tags(nodeId: string): { deviceId: number } | { brokerId: string } {
    const deviceId = this.#resolveDeviceId(nodeId)
    if (deviceId !== null) return { deviceId }
    return { brokerId: this.#brokerId }
  }

  /** The first attempt and every Nth retry are worth info; the rest is debug. */
  #perAttempt(slot: Slot): boolean {
    return slot.attempt === 0 || slot.attempt % SUBSCRIPTION_SUMMARY_EVERY === 0
  }

  /**
   * One subscribe attempt, bounded: a `subscribe` that never settles is a
   * failed attempt, and whatever it returns later is closed.
   */
  async #subscribeBounded(
    peer: MatterSubscribablePeer,
    handlers: MatterSubscriptionHandlers,
  ): Promise<MatterPeerSubscription> {
    const pending = peer.subscribe(handlers)
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SUBSCRIBE_ATTEMPT_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
    })
    try {
      const winner = await Promise.race([pending, timeout])
      if (winner !== 'timeout') return winner
      pending.then((late) => late.close()).catch(() => undefined)
      throw new Error(`subscribe did not settle within ${SUBSCRIBE_ATTEMPT_TIMEOUT_MS} ms`)
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  #log(
    nodeId: string,
    phase: SubscriptionPhase,
    extra?: Record<string, unknown>,
    info = true,
  ): void {
    const deviceId = this.#resolveDeviceId(nodeId)
    const line = {
      tags: deviceId !== null ? { deviceId } : { brokerId: this.#brokerId },
      meta: { nodeId, phase, ...extra },
    }
    if (info) this.#logger.info('Matter subscription state', line)
    else this.#logger.debug('Matter subscription state', line)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return isRecord(value) && typeof Reflect.get(value, Symbol.iterator) === 'function'
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isRecord(value) && typeof Reflect.get(value, Symbol.asyncIterator) === 'function'
}

/**
 * Pull attribute values out of a matter.js `ReadResult` (or a recorded fixture
 * of the same shape). Status reports and missing values are skipped — they are
 * not a measurement.
 */
export async function collectAttributeReports(
  nodeId: string,
  update: unknown,
): Promise<MatterAttributeReport[]> {
  const out: MatterAttributeReport[] = []
  const chunks = isAsyncIterable(update) ? update : isIterable(update) ? update : []
  for await (const chunk of chunks) {
    const reports = isIterable(chunk) ? chunk : []
    for (const report of reports) {
      const decoded = reportFromRecord(nodeId, report)
      if (decoded !== null) out.push(decoded)
    }
  }
  return out
}

/** Drain a (possibly async) chunked result into one replayable array of chunks. */
export async function materialiseUpdate(update: unknown): Promise<unknown[]> {
  const out: unknown[] = []
  const chunks = isAsyncIterable(update) ? update : isIterable(update) ? update : []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

/**
 * Pull Matter events out of the same `ReadResult` stream. A status record or an
 * event without a payload is not an event. The timestamp is the epoch variant
 * when the node sent one; a relative or system-time stamp cannot be placed on
 * the wall clock, so it stays null (and the caller does not guess an age).
 */
export async function collectEventReports(
  nodeId: string,
  update: unknown,
): Promise<MatterEventReport[]> {
  const out: MatterEventReport[] = []
  const chunks = isAsyncIterable(update) ? update : isIterable(update) ? update : []
  for await (const chunk of chunks) {
    const records = isIterable(chunk) ? chunk : []
    for (const record of records) {
      const decoded = eventFromRecord(nodeId, record)
      if (decoded !== null) out.push(decoded)
    }
  }
  return out
}

function eventFromRecord(nodeId: string, record: unknown): MatterEventReport | null {
  if (!isRecord(record)) return null
  if (record['kind'] !== 'event-value') return null
  const path = record['path']
  if (!isRecord(path)) return null
  const endpointId = asFiniteNumber(path['endpointId'])
  const clusterId = asFiniteNumber(path['clusterId'])
  const eventId = asFiniteNumber(path['eventId'])
  if (endpointId === null || clusterId === null || eventId === null) return null
  return {
    nodeId,
    endpointId,
    clusterId,
    eventId,
    eventNumber: asFiniteNumber(record['number']),
    timestampMs: asFiniteNumber(record['epochTimestamp']),
    value: record['value'],
  }
}

function reportFromRecord(nodeId: string, report: unknown): MatterAttributeReport | null {
  if (!isRecord(report)) return null
  if (report['kind'] !== 'attr-value') return null
  if (report['value'] === undefined || report['value'] === null) return null
  const path = report['path']
  if (!isRecord(path)) return null
  const endpointId = asFiniteNumber(path['endpointId'])
  const clusterId = asFiniteNumber(path['clusterId'])
  const attributeId = asFiniteNumber(path['attributeId'])
  if (endpointId === null || clusterId === null || attributeId === null) return null
  return { nodeId, endpointId, clusterId, attributeId, value: report['value'] }
}
