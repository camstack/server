/**
 * Passive discovery for the hub (D994): a listener on the mDNS and SSDP
 * multicast groups plus a low-cost sweep on a fixed schedule. Both end in the
 * same place, `device-manager`'s proposal stream, which persists them.
 *
 * The listener never asks anything on the wire. It de-duplicates what it hears
 * (a chatty device announces every few seconds), batches it, and hands the batch
 * over; the sweep runs the discovery the integrations already offer, at most one
 * at a time, once per {@link SWEEP_INTERVAL_MS}.
 */
import { errMsg, type DiscoveryObservation, type IScopedLogger } from '@camstack/types'
import { observationKey, parseMdnsPacket, parseSsdpPacket } from './passive-packets.js'

export const SWEEP_INTERVAL_MS: number = 30 * 60 * 1000
/** A sighting already reported within this window is not reported again. */
export const SEEN_WINDOW_MS: number = 10 * 60 * 1000
export const FLUSH_INTERVAL_MS = 5_000
/** More distinct sightings than this between two flushes are dropped, and said so. */
export const MAX_PENDING = 512
/** Bound on the de-duplication memory. */
const MAX_SEEN = 4_096

export interface PassivePacket {
  readonly protocol: 'mdns' | 'ssdp'
  readonly data: Buffer
  readonly from: string
}

export interface PassiveListenIo {
  open(
    onPacket: (packet: PassivePacket) => void,
    onError: (protocol: PassivePacket['protocol'], error: Error) => void,
  ): Promise<{ close(): void }>
}

/** Where sightings and sweeps go: device-manager through `ctx.api`. */
export interface DiscoverySink {
  report(observations: readonly DiscoveryObservation[]): Promise<void>
  sweep(): Promise<void>
}

export interface DiscoveryWatcherDeps {
  readonly io: PassiveListenIo
  readonly sink: DiscoverySink
  readonly logger: IScopedLogger
  readonly now?: () => number
}

export class DiscoveryWatcher {
  private readonly now: () => number
  private readonly seen = new Map<string, number>()
  private pending: DiscoveryObservation[] = []
  private dropped = 0
  private listener: { close(): void } | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private sweeping = false
  private running = false

  constructor(private readonly deps: DiscoveryWatcherDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  async start(options: { readonly passive: boolean }): Promise<void> {
    if (this.running) return
    this.running = true
    this.sweepTimer = setInterval(() => void this.runSweep(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
    if (!options.passive) return
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)
    this.flushTimer.unref?.()
    this.listener = await this.deps.io.open(
      (packet) => this.onPacket(packet),
      (protocol, error) =>
        this.deps.logger.warn('passive discovery: listener unavailable', {
          meta: { protocol, error: errMsg(error) },
        }),
    )
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer)
    if (this.flushTimer !== null) clearInterval(this.flushTimer)
    this.sweepTimer = null
    this.flushTimer = null
    this.listener?.close()
    this.listener = null
    this.pending = []
  }

  private onPacket(packet: PassivePacket): void {
    const sightings =
      packet.protocol === 'mdns'
        ? parseMdnsPacket(packet.data)
        : [parseSsdpPacket(packet.data, packet.from)].filter((o) => o !== null)
    const at = this.now()
    for (const sighting of sightings) {
      const key = observationKey(sighting)
      const last = this.seen.get(key)
      if (last !== undefined && at - last < SEEN_WINDOW_MS) continue
      if (this.pending.length >= MAX_PENDING) {
        this.dropped += 1
        continue
      }
      this.remember(key, at)
      this.pending.push(sighting)
    }
  }

  private remember(key: string, at: number): void {
    if (this.seen.size >= MAX_SEEN) {
      for (const [k, t] of this.seen) if (at - t >= SEEN_WINDOW_MS) this.seen.delete(k)
      if (this.seen.size >= MAX_SEEN) this.seen.clear()
    }
    this.seen.set(key, at)
  }

  /** Hand the batch over. A failed hand-over puts nothing back: a later sighting repeats it. */
  async flush(): Promise<void> {
    if (this.dropped > 0) {
      this.deps.logger.warn('passive discovery: sightings dropped, queue full', {
        meta: { dropped: this.dropped },
      })
      this.dropped = 0
    }
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    try {
      await this.deps.sink.report(batch)
    } catch (err) {
      this.deps.logger.warn('passive discovery: could not report sightings', {
        meta: { count: batch.length, error: errMsg(err) },
      })
    }
  }

  async runSweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      await this.deps.sink.sweep()
    } catch (err) {
      this.deps.logger.warn('discovery sweep failed', { meta: { error: errMsg(err) } })
    } finally {
      this.sweeping = false
    }
  }
}
