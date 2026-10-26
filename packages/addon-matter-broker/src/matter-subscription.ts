/**
 * Per-node Matter attribute subscriptions. The matter.js call itself lives in
 * {@link import('./matter-peer-subscribe.js')}; this module owns the lifecycle:
 * open, resubscribe after the session drops or the node returns, and a bounded
 * backoff. A report whose value is missing is not a value (D393) and is dropped.
 */

import { errMsg, type IScopedLogger } from '@camstack/types'
import type { MatterAttributeReport } from './matter-controller.js'

/** First wait after a dropped subscription. */
export const SUBSCRIPTION_BACKOFF_INITIAL_MS = 1_000
/** Cap so a sleepy Thread node cannot be hammered. */
export const SUBSCRIPTION_BACKOFF_MAX_MS = 60_000

export type SubscriptionPhase =
  | 'subscribed'
  | 'closed'
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
  onClosed: () => void
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
}

interface Slot {
  peer: MatterSubscribablePeer
  phase: SubscriptionPhase
  attempt: number
  timer: ReturnType<typeof setTimeout> | null
  subscription: MatterPeerSubscription | null
  unlisten: Array<() => void>
  generation: number
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
  readonly #slots: Map<string, Slot> = new Map()
  #stopped = false

  constructor(options: MatterSubscriptionSupervisorOptions) {
    this.#brokerId = options.brokerId
    this.#logger = options.logger
    this.#resolveDeviceId = options.resolveDeviceId
    this.#onReport = options.onReport
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
      if (cameBack && slot.phase !== 'resubscribing') {
        slot.attempt = 0
        await this.#open(peer)
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
    this.#slots.set(peer.nodeId, slot)
    this.#listen(slot)
    this.#log(peer.nodeId, 'resubscribing')
    let subscription: MatterPeerSubscription
    try {
      subscription = await peer.subscribe({
        onReport: (report) => {
          if (report.value === undefined || report.value === null) return
          this.#onReport(report)
        },
        onClosed: () => {
          const current = this.#slots.get(peer.nodeId)
          if (current === undefined || current.generation !== generation) return
          this.#onClosed(peer.nodeId)
        },
      })
    } catch (err: unknown) {
      this.#log(peer.nodeId, 'subscribe-failed', { error: errMsg(err) })
      const current = this.#slots.get(peer.nodeId)
      if (current === undefined || current.generation !== generation) return
      current.phase = 'subscribe-failed'
      this.#schedule(peer.nodeId)
      return
    }
    if (this.#stopped || this.#slots.get(peer.nodeId)?.generation !== generation) {
      await subscription.close().catch(() => undefined)
      return
    }
    slot.subscription = subscription
    slot.phase = 'subscribed'
    slot.attempt = 0
    this.#log(peer.nodeId, 'subscribed')
  }

  #onClosed(nodeId: string): void {
    const slot = this.#slots.get(nodeId)
    if (slot === undefined || slot.dropping) return
    if (slot.phase !== 'subscribed' && slot.phase !== 'resubscribing') return
    slot.subscription = null
    slot.phase = 'closed'
    this.#log(nodeId, 'closed')
    if (!slot.peer.online()) {
      slot.phase = 'offline'
      this.#log(nodeId, 'offline')
      return
    }
    this.#schedule(nodeId)
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
    slot.phase = 'backing-off'
    this.#log(nodeId, 'backing-off', { delayMs: delay, attempt: slot.attempt })
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
        if (current === undefined) return
        if (current.phase === 'offline') return
        current.phase = 'offline'
        this.#log(slot.peer.nodeId, 'offline')
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
      listening: false,
      dropping: false,
    }
  }

  #tags(nodeId: string): { deviceId: number } | { brokerId: string } {
    const deviceId = this.#resolveDeviceId(nodeId)
    if (deviceId !== null) return { deviceId }
    return { brokerId: this.#brokerId }
  }

  #log(nodeId: string, phase: SubscriptionPhase, extra?: Record<string, unknown>): void {
    const deviceId = this.#resolveDeviceId(nodeId)
    this.#logger.info('Matter subscription state', {
      tags: deviceId !== null ? { deviceId } : { brokerId: this.#brokerId },
      meta: { nodeId, phase, ...extra },
    })
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
