/**
 * Fmp4FragmentPlane — a SUBSCRIBABLE fragmented-MP4 plane, fed by one
 * {@link import('./fmp4-box-splitter.js').Fmp4BoxSplitter}.
 *
 * ## Why a plane and not a callback
 *
 * The operator's requirement for HKSV was explicit: the live fMP4 source built
 * for it must be **dual-use**, so a HomeKit-triggered recording also lands in
 * CamStack as an additional videoclip source alongside the recorder and the NC
 * clip ring — *one fragmenter, two consumers; do not build an HKSV-only pipe*
 * (roadmap item 4b, now in the private planning board). A single-callback pipe makes the second consumer
 * a second ffmpeg child of the same camera. So this is the same shape the
 * broker's other multi-consumer surfaces already have
 * (`AudioChunkPlane`, the push packet plane): N independent subscriptions over
 * one producer.
 *
 * **Nothing consumes it yet.** Phase 4 brings the HKSV delegate and phase 4b the
 * clip source; both are named here so the seam is not re-invented, and neither
 * is built.
 *
 * ## The init segment is RETAINED
 *
 * A subscriber that attaches mid-stream — the clip consumer joining an already
 * running HKSV session, which is the whole dual-use case — receives the
 * retained `ftyp`+`moov` as its first packet and then live fragments. Without
 * retention its fragments are undecodable and the failure looks like a codec
 * problem.
 *
 * ## A slow subscriber is CLOSED, never silently gapped
 *
 * `AudioChunkPlane` drops its oldest chunk on overflow, which for audio costs a
 * click. An fMP4 stream with a hole is not a shorter clip, it is a corrupt one:
 * `moof` sequence numbers jump, the consumer's demuxer desynchronises, and HKSV
 * shows a clip that fails to play with nothing anywhere saying why. So a
 * subscription whose queue overflows is ENDED with a reason, loudly, and the
 * other subscriptions are untouched.
 *
 * ## The PREBUFFER (phase 3)
 *
 * HKSV asks for context BEFORE the trigger — `CameraRecordingOptions.prebufferLength`
 * is a HAP-mandated minimum of 4000 ms — and a subscriber that attaches at the
 * motion edge has none. So the plane optionally retains the last few fragments
 * and replays them to a subscriber that asks for them.
 *
 * Three things this ring gets right, each of which is a measured fact rather
 * than a preference (see [D84](../../../../docs/decisions/adr-0084.md)):
 *
 *  - **It is bounded by TIME *and* BYTES.** On the live fleet a 720p copy
 *    fragment is ~255 KB and a 4K one is ~6.35 MB — a 25× spread over the same
 *    window. A time-only bound is a per-camera RAM figure nobody can predict.
 *  - **The window is measured on ARRIVAL, not parsed from `tfdt`.** The
 *    splitter deliberately never computes a fragment's duration (a second
 *    opinion about a fact the muxer owns), and a prebuffer cares about how long
 *    ago the bytes turned up, which is exactly what arrival time answers.
 *  - **A replay is not backlog.** A subscriber taking N retained fragments gets
 *    its queue capacity raised by N for them, because closing a subscriber as a
 *    slow consumer for the prebuffer it explicitly asked for would be the
 *    stupidest possible failure — and, with `DEFAULT_QUEUE_CAPACITY` of 4 and a
 *    ring of 4, the guaranteed one.
 *
 * ## `isLast`
 *
 * hap-nodejs requires the delegate to mark exactly one `RecordingPacket` with
 * `isLast` — a generator that finishes without it produces the twelve-second
 * timeout loop [D50](../../../../../docs/decisions/adr-0050.md) deleted. The
 * plane therefore computes it at DELIVERY time: a packet is last when the plane
 * has ended and nothing remains queued behind it. A subscription that ends
 * having delivered NOTHING says so through {@link Fmp4Subscription.delivered};
 * the future delegate must not open an HDS stream it cannot feed.
 */
import { randomUUID } from 'node:crypto'

import type { IScopedLogger } from '../interfaces/logging.js'

import type { Fmp4Unit, Fmp4UnitKind } from './fmp4-box-splitter.js'

/** One unit as a subscriber receives it. */
export interface Fmp4Packet {
  readonly kind: Fmp4UnitKind
  readonly data: Uint8Array
  /** The producer's sequence number. NOT contiguous per subscriber — a
   *  subscriber that attached late starts at the retained init's own number. */
  readonly sequence: number
  /** The final packet this subscriber will receive. Exactly one, or none. */
  readonly isLast: boolean
}

/** Why a subscription stopped. */
export type Fmp4CloseReason =
  /** The producer ended: the child exited, or the consumer released it. */
  | 'ended'
  /** The subscriber did not drain fast enough; its stream would have a hole. */
  | 'slow-consumer'
  /** The subscriber closed it. */
  | 'released'

export interface Fmp4Subscription {
  readonly id: string
  readonly tag: string
  /** Packets delivered so far — the premise the `isLast` contract rests on. */
  readonly delivered: number
  /** Non-null once no further packets will arrive. */
  readonly closedReason: Fmp4CloseReason | null
  /**
   * The packet stream, with real backpressure: the generator suspends until a
   * packet is queued, so a consumer that awaits each packet paces itself.
   * The bounded queue only exists for the case where it does NOT.
   */
  packets(): AsyncGenerator<Fmp4Packet>
  /** Stop receiving. Idempotent. */
  release(): void
}

export interface Fmp4SubscriberInfo {
  readonly tag: string
  readonly subscribedAt: number
  readonly delivered: number
  readonly closedReason: Fmp4CloseReason | null
}

export interface Fmp4SubscribeInput {
  /** Short caller identity for diagnostics — `hksv/101`, `clips/101`. */
  readonly tag: string
  /**
   * Fragments a subscriber may fall behind by before it is closed. Four is two
   * negotiated fragment lengths of slack on a 4 s cadence — enough to ride out
   * a GC pause, far short of the memory a real stall would take.
   *
   * A prebuffer replay is added ON TOP of this, never counted against it.
   */
  readonly queueCapacity?: number
  /**
   * Replay the retained prebuffer before live fragments. Off by default: a
   * clip consumer that joins an ongoing recording wants what happens NEXT, and
   * handing it seconds of the past would silently shift its clip's start.
   */
  readonly withPrebuffer?: boolean
}

/** How much past the plane keeps for a {@link Fmp4SubscribeInput.withPrebuffer}. */
export interface Fmp4PrebufferOptions {
  /**
   * How far back the ring reaches, by fragment ARRIVAL time. HKSV's minimum
   * prebuffer is 4000 ms and the fragment cadence is the source GOP on a copy
   * branch (measured: 8 s on this fleet), so a window shorter than two
   * cadences can hold nothing at all at the moment it is asked for.
   */
  readonly windowMs: number
  /**
   * The hard ceiling. Non-negotiable, because the window alone does not bound
   * RAM: same 8 s, 255 KB at 720p and 6.35 MB at 4K on the same cameras.
   */
  readonly maxBytes: number
}

/** What the ring is holding right now — diagnostics, and a delegate's gate. */
export interface Fmp4PrebufferStats {
  readonly fragments: number
  readonly bytes: number
  /** Age of the OLDEST retained fragment. `0` when the ring is empty. */
  readonly spanMs: number
}

const DEFAULT_QUEUE_CAPACITY = 4

/** One retained fragment plus the arrival stamp the window is measured on. */
interface RetainedFragment {
  readonly unit: Fmp4Unit
  readonly arrivedAt: number
}

/** One subscriber's queue plus whatever generator is parked on it. */
interface Subscription {
  readonly id: string
  readonly tag: string
  readonly subscribedAt: number
  readonly capacity: number
  readonly queue: Fmp4Packet[]
  delivered: number
  closedReason: Fmp4CloseReason | null
  /** Resolves the parked generator; null when nobody is waiting. */
  wake: (() => void) | null
  /** A second generator on one subscription would split the queue between two
   *  consumers, each receiving a stream with holes. Refused, not tolerated. */
  iterating: boolean
}

export class Fmp4FragmentPlane {
  private readonly subscriptions = new Map<string, Subscription>()
  /** The last init unit seen, handed to every later subscriber. */
  private retainedInit: Fmp4Unit | null = null
  private ended = false
  /** Oldest first. Empty unless {@link Fmp4PrebufferOptions} was supplied. */
  private readonly ring: RetainedFragment[] = []
  private ringBytes = 0

  constructor(
    private readonly logger?: IScopedLogger,
    private readonly prebuffer?: Fmp4PrebufferOptions,
    /** Injectable clock — the ring's window is the one thing here that is
     *  wall-clock dependent, and a test that sleeps 8 real seconds is a test
     *  nobody runs. */
    private readonly now: () => number = Date.now,
  ) {}

  get subscriberCount(): number {
    return this.subscriptions.size
  }

  /** True once {@link end} has been called — no further units are accepted. */
  get isEnded(): boolean {
    return this.ended
  }

  /** What the prebuffer ring holds right now. All zeroes when disabled. */
  prebufferStats(): Fmp4PrebufferStats {
    const oldest = this.ring[0]
    return {
      fragments: this.ring.length,
      bytes: this.ringBytes,
      spanMs: oldest === undefined ? 0 : this.now() - oldest.arrivedAt,
    }
  }

  subscribe(input: Fmp4SubscribeInput): Fmp4Subscription {
    // The replay is decided BEFORE the capacity, because it sets it: see the
    // "a replay is not backlog" note in the class docblock.
    const replay = input.withPrebuffer === true ? this.trimmedRing() : []
    const requested = Math.max(1, input.queueCapacity ?? DEFAULT_QUEUE_CAPACITY)
    const sub: Subscription = {
      id: `fmp4-${randomUUID()}`,
      tag: input.tag,
      subscribedAt: this.now(),
      capacity: requested + replay.length,
      queue: [],
      delivered: 0,
      closedReason: null,
      wake: null,
      iterating: false,
    }
    this.subscriptions.set(sub.id, sub)
    // The retained init FIRST, so a late subscriber's fragments are decodable.
    // A subscriber that attaches before the muxer has produced one simply
    // receives it as its first live packet instead.
    if (this.retainedInit !== null) this.enqueue(sub, this.retainedInit)
    for (const retained of replay) this.enqueue(sub, retained.unit)
    if (this.ended) this.closeSubscription(sub, 'ended')
    this.logger?.info('fmp4 plane: subscribed', {
      meta: {
        subscriptionId: sub.id,
        tag: sub.tag,
        hasRetainedInit: this.retainedInit !== null,
        prebufferFragments: replay.length,
        prebufferBytes: replay.reduce((n, r) => n + r.unit.data.length, 0),
      },
    })
    return this.facade(sub)
  }

  /**
   * Fan one splitter unit out. An `init` REPLACES the retained one — ffmpeg
   * emits exactly one per child, and a second means the child was respawned, in
   * which case the old one describes a stream that no longer exists.
   */
  publish(unit: Fmp4Unit): void {
    if (this.ended) return
    if (unit.kind === 'init') {
      this.retainedInit = unit
      // …and the ring with it: fragments cut by the PREVIOUS child are not
      // decodable against the new initialisation segment, so replaying them
      // would hand a consumer a corrupt clip in the one case that looks most
      // like a working one.
      this.ring.length = 0
      this.ringBytes = 0
    } else {
      this.retain(unit)
    }
    for (const sub of this.subscriptions.values()) {
      if (sub.closedReason !== null) continue
      this.enqueue(sub, unit)
    }
  }

  /**
   * The producer stopped. Every subscriber drains what it holds; its final
   * packet carries `isLast`, and its generator then completes.
   */
  end(reason = 'producer ended'): void {
    if (this.ended) return
    this.ended = true
    this.logger?.info('fmp4 plane: ended', {
      meta: { reason, subscribers: this.subscriptions.size },
    })
    for (const sub of this.subscriptions.values()) {
      if (sub.closedReason === null) this.closeSubscription(sub, 'ended')
    }
  }

  listSubscribers(): readonly Fmp4SubscriberInfo[] {
    return [...this.subscriptions.values()].map((s) => ({
      tag: s.tag,
      subscribedAt: s.subscribedAt,
      delivered: s.delivered,
      closedReason: s.closedReason,
    }))
  }

  /** End and forget everything. Idempotent. */
  dispose(): void {
    this.end('disposed')
    this.subscriptions.clear()
    this.retainedInit = null
    this.ring.length = 0
    this.ringBytes = 0
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Add one fragment to the ring and evict from the front until BOTH bounds
   * hold. Eviction is oldest-first, which is the one place in this file where
   * dropping is correct: the ring is context, not stream — nobody is mid-decode
   * on it, and a subscriber only ever receives a contiguous tail of it.
   */
  private retain(unit: Fmp4Unit): void {
    const prebuffer = this.prebuffer
    if (prebuffer === undefined) return
    const arrivedAt = this.now()
    this.ring.push({ unit, arrivedAt })
    this.ringBytes += unit.data.length
    const cutoff = arrivedAt - prebuffer.windowMs
    while (this.ring.length > 0) {
      const oldest = this.ring[0]
      if (oldest === undefined) break
      const tooOld = oldest.arrivedAt < cutoff
      const tooBig = this.ringBytes > prebuffer.maxBytes
      // The newest fragment is never evicted: a ring that dropped it would
      // report a prebuffer it does not have, and one fragment over the byte
      // cap is a smaller lie than zero fragments.
      if ((!tooOld && !tooBig) || this.ring.length === 1) break
      this.ring.shift()
      this.ringBytes -= oldest.unit.data.length
    }
  }

  /**
   * The ring as a subscriber should receive it — window applied AT SUBSCRIBE
   * time, not only at publish time. A camera that went quiet keeps its last
   * fragment in the ring indefinitely (see the never-evict-the-newest rule),
   * and replaying a 40-second-old fragment as "prebuffer" would put stale video
   * at the head of a clip iOS presents as the moment of the event.
   */
  private trimmedRing(): readonly RetainedFragment[] {
    const prebuffer = this.prebuffer
    if (prebuffer === undefined) return []
    const cutoff = this.now() - prebuffer.windowMs
    return this.ring.filter((r) => r.arrivedAt >= cutoff)
  }

  private enqueue(sub: Subscription, unit: Fmp4Unit): void {
    if (sub.queue.length >= sub.capacity) {
      // Never a drop. See the class docblock: a gapped fMP4 is corrupt, not
      // short, and the corruption surfaces far from here.
      this.logger?.warn('fmp4 plane: subscriber fell behind — CLOSING it rather than gapping it', {
        meta: {
          subscriptionId: sub.id,
          tag: sub.tag,
          capacity: sub.capacity,
          delivered: sub.delivered,
        },
      })
      this.closeSubscription(sub, 'slow-consumer')
      return
    }
    sub.queue.push({
      kind: unit.kind,
      data: unit.data,
      sequence: unit.sequence,
      isLast: false,
    })
    this.wake(sub)
  }

  private closeSubscription(sub: Subscription, reason: Fmp4CloseReason): void {
    if (sub.closedReason !== null) return
    sub.closedReason = reason
    // A slow consumer's queue describes a stream with a hole in it; handing the
    // held packets over would be handing over the corruption.
    if (reason === 'slow-consumer') sub.queue.length = 0
    this.wake(sub)
  }

  private wake(sub: Subscription): void {
    const resume = sub.wake
    sub.wake = null
    resume?.()
  }

  private facade(sub: Subscription): Fmp4Subscription {
    const plane = this
    return {
      id: sub.id,
      tag: sub.tag,
      get delivered() {
        return sub.delivered
      },
      get closedReason() {
        return sub.closedReason
      },
      packets: (): AsyncGenerator<Fmp4Packet> => plane.iterate(sub),
      release: () => {
        plane.closeSubscription(sub, 'released')
        plane.subscriptions.delete(sub.id)
      },
    }
  }

  private async *iterate(sub: Subscription): AsyncGenerator<Fmp4Packet> {
    if (sub.iterating) {
      throw new Error(
        `fmp4 plane: subscription ${sub.tag} is already being consumed — take a second subscription`,
      )
    }
    sub.iterating = true
    for (;;) {
      const next = sub.queue.shift()
      if (next === undefined) {
        if (sub.closedReason !== null) return
        await new Promise<void>((resolve) => {
          sub.wake = resolve
        })
        continue
      }
      // Last when the producer is finished and nothing is queued behind it.
      // Computed HERE and not at publish time: whether a packet is final is a
      // fact about this subscriber's queue, not about the producer's stream.
      const isLast = sub.closedReason === 'ended' && sub.queue.length === 0
      sub.delivered += 1
      yield { ...next, isLast }
      if (isLast) return
    }
  }
}
