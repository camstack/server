/**
 * `HksvRecordingDelegate` — the `CameraRecordingDelegate` HomeKit Secure Video
 * drives, and the thing [D50](../../../../docs/decisions/adr-0050.md) deleted a
 * stub of.
 *
 * ## The contract, and the one way it is always violated
 *
 * `handleRecordingStreamRequest` must yield a MEDIA_INITIALIZATION packet, then
 * media fragments, and must mark exactly one packet `isLast`. A generator that
 * returns without ever setting it produces
 * `Delegate finished streaming for N without setting RecordingPacket.isLast`
 * and a ~12 s controller timeout — the failure that ran on every motion-capable
 * camera here, every 20-60 s, for as long as the stub was advertised.
 *
 * So this delegate REFUSES rather than yields nothing. If the fragment source
 * has no plane, or the plane hands back a subscription that delivers zero
 * packets, it throws — an HDS `CLOSE` with a reason iOS can act on, instead of
 * a stream nothing feeds. **Every close is logged with why**, because HKSV's
 * punishment for a malformed fragment is silence: a clip that never appears in
 * the Activity feed, with nothing on either side saying so.
 *
 * ## The three states, and their order
 *
 * hap-nodejs guarantees `updateRecordingConfiguration` before
 * `updateRecordingActive(true)` when a configuration exists, and persists both
 * across reboots. It does NOT guarantee a configuration is present when active
 * flips on. So the prebuffer starts only when BOTH are true, and either one
 * arriving second is what starts it.
 *
 * ## What a truncated clip looks like
 *
 * `Fmp4FragmentPlane` closes a subscriber that falls behind instead of gapping
 * it (D80), because a gapped fMP4 is corrupt rather than short. The delegate
 * therefore treats `closedReason === 'slow-consumer'` as a clip that ENDED, and
 * marks its last delivered packet — a truncated clip iOS can play, never a
 * generator that returns unmarked.
 */

import type { IScopedLogger } from '@camstack/types'
import type { Fmp4Subscription } from '@camstack/types/node'
import type { CameraRecordingConfiguration, RecordingPacket } from '@homebridge/hap-nodejs'
import { HDSProtocolError, HDSProtocolSpecificErrorReason } from '@homebridge/hap-nodejs'

import { CLIP_TEE_QUEUE_CAPACITY } from './clip-writer.js'
import type { HapControllerCensus } from './controller-census.js'
import { noAdminControllerConnected } from './controller-census.js'

/**
 * How many finished clips may wait for an acknowledgement iOS may never send.
 * Eight is more concurrent HKSV streams than one camera ever has; the number
 * exists so the map cannot grow, not to be tuned.
 */
const MAX_TEES_AWAITING_ACK = 8

/**
 * What the delegate needs from a fragment source — the production one is
 * {@link import('./fragment-source.js').HksvFragmentSource}.
 *
 * An INTERFACE rather than the class, so the delegate's contract tests drive
 * the real generator against a plane they control. Casting a fake to the class
 * would be the `as unknown as X` this repo forbids, and — worse — a fake shaped
 * by the cast rather than by the contract is how a test ends up supplying the
 * value production forgot to fetch.
 */
export interface RecordingFragmentSource {
  readonly isRunning: boolean
  start(): Promise<void>
  stop(reason: string): Promise<void>
  setAudioActive(active: boolean): Promise<void>
  /**
   * One INDEPENDENT subscription per call. `queueCapacity` exists for the clip
   * tee: it is not a live consumer with a deadline and must be allowed less
   * slack than HomeKit's own stream, so that a stalled disk truncates a clip
   * instead of growing the exporter's heap (D9/D18).
   */
  subscribe(tag: string, queueCapacity?: number): Fmp4Subscription | null
  prebufferSpanMs(): number
}

/**
 * The tee's handle, from the delegate's side.
 *
 * Both methods are SYNCHRONOUS and return immediately. The delegate is feeding
 * HomeKit Secure Video for the operator's real home; it awaits no disk, no
 * ffmpeg and no directory creation on that path, so everything the tee does
 * asynchronously it does behind this handle.
 */
export interface ClipTee {
  /** The HDS stream ended. Closes the file; never throws. */
  finish(): void
  /** iOS acknowledged the clip: HomeKit kept it too. */
  acknowledge(): void
}

export interface ClipTeeRequest {
  readonly streamId: number
  /** The tee's OWN subscription, already opened by the delegate. */
  readonly subscription: Fmp4Subscription
  /** How much of the clip's head is prebuffer — the trigger's offset. */
  readonly prebufferSpanMs: number
}

/**
 * Build a tee for one stream, or `null` for "not teeing this one". Called
 * inside a `try`: a factory that throws costs the clip and nothing else.
 */
export type ClipTeeFactory = (request: ClipTeeRequest) => ClipTee | null

/**
 * `HDSProtocolSpecificErrorReason` is a `const enum`, so there is no reverse
 * map to index — and a bare number in the log is the difference between "iOS
 * closed it normally" and "iOS rejected our data", which is the whole reason
 * this line exists.
 */
const HDS_REASON_NAMES: Readonly<Record<number, string>> = {
  [HDSProtocolSpecificErrorReason.NORMAL]: 'normal',
  [HDSProtocolSpecificErrorReason.NOT_ALLOWED]: 'not-allowed',
  [HDSProtocolSpecificErrorReason.BUSY]: 'busy',
  [HDSProtocolSpecificErrorReason.CANCELLED]: 'cancelled',
  [HDSProtocolSpecificErrorReason.UNSUPPORTED]: 'unsupported',
  [HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE]: 'unexpected-failure',
  [HDSProtocolSpecificErrorReason.TIMEOUT]: 'timeout',
  [HDSProtocolSpecificErrorReason.BAD_DATA]: 'bad-data',
  [HDSProtocolSpecificErrorReason.PROTOCOL_ERROR]: 'protocol-error',
  [HDSProtocolSpecificErrorReason.INVALID_CONFIGURATION]: 'invalid-configuration',
}

function hdsReasonName(reason: HDSProtocolSpecificErrorReason): string {
  return HDS_REASON_NAMES[reason] ?? `unknown(${String(reason)})`
}

export interface HksvRecordingDelegateInput {
  readonly logger: IScopedLogger
  readonly deviceId: number
  /** Built lazily so a camera that is never recorded never spawns a child. */
  readonly createSource: (input: {
    readonly fragmentMs: number
    readonly audioActive: boolean
  }) => RecordingFragmentSource
  /**
   * `Characteristic.RecordingAudioActive` on the controller's
   * `CameraOperatingMode` service. Read rather than pushed: hap-nodejs owns the
   * characteristic and its persistence, and a second copy of that state here is
   * the two-knobs-one-fact failure D62 names.
   */
  readonly isAudioActive: () => boolean
  /** The fragment length we advertised. Fragments longer than this violate HKSV. */
  readonly advertisedFragmentMs: number
  /**
   * Who is connected and may write, at the moment we are asked. HKSV's second
   * write — the recording configuration — comes from the resident home hub and
   * is `adminOnlyAccess`, so a non-admin hub is refused in silence; this turns
   * "the hub cannot" and "the hub did not" into different log lines.
   */
  readonly describeControllers: () => HapControllerCensus
  /**
   * The clock the fragment cadence is measured on. Injected so the cadence
   * accounting is testable at all — it is the input to the only warning that
   * asks the operator to change a CAMERA, and a detector nothing can drive
   * deterministically is a detector nobody can trust.
   */
  readonly now: () => number
  /**
   * The clip tee. Absent means HomeKit's clips are not kept — HAP has no
   * read-back, so a stream nobody teed is simply gone, and that is a decision
   * the addon makes once rather than something this delegate can recover.
   */
  readonly openClipTee?: ClipTeeFactory
}

export class HksvRecordingDelegate {
  private active = false
  private configuration: CameraRecordingConfiguration | undefined = undefined
  private source: RecordingFragmentSource | null = null
  private readonly log: IScopedLogger
  /** The stream currently being yielded, so `closeRecordingStream` can end it. */
  private open: {
    readonly streamId: number
    readonly subscription: Fmp4Subscription
  } | null = null
  /**
   * Tees whose stream has ended, still waiting for iOS's `ack`. BOUNDED: the
   * ack may never come (a dropped connection looks identical), and a map that
   * only ever grows is the unbounded buffer D9/D18 names in its smallest form.
   */
  private readonly tees = new Map<number, ClipTee>()

  constructor(private readonly input: HksvRecordingDelegateInput) {
    this.log = input.logger
  }

  /** Test/diagnostic view — the prebuffer is running for this camera. */
  get prebufferRunning(): boolean {
    return this.source?.isRunning === true
  }

  updateRecordingActive(active: boolean): void {
    if (active === this.active) return
    this.active = active
    const census = this.input.describeControllers()
    this.log.info('hksv: recording active changed', {
      tags: { deviceId: this.input.deviceId },
      meta: {
        active,
        hasConfiguration: this.configuration !== undefined,
        // Recording turned on with no configuration is the NORMAL first half of
        // the handshake — the hub writes the configuration next. It is also
        // exactly what a handshake that never completes looks like, which is why
        // the census rides along: it is the only thing that separates them.
        ...census,
      },
    })
    if (active && this.configuration === undefined && noAdminControllerConnected(census)) {
      this.log.warn(
        'hksv: recording is ON but NO connected controller holds admin — the recording configuration can never arrive',
        {
          tags: { deviceId: this.input.deviceId },
          meta: { ...census },
        },
      )
    }
    void this.reconcile('recording-active')
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.configuration = configuration
    if (configuration === undefined) {
      // A factory reset invalidated the selection. HAP is explicit: disable the
      // pipeline even if recording is still "active" — otherwise the prebuffer
      // burns a child for a camera no controller can ask for a clip from.
      this.log.info('hksv: the selected configuration was CLEARED — stopping the prebuffer', {
        tags: { deviceId: this.input.deviceId },
      })
      void this.reconcile('configuration-cleared')
      return
    }
    const selectedMs = configuration.mediaContainerConfiguration.fragmentLength
    this.log.info('hksv: iOS selected a recording configuration', {
      tags: { deviceId: this.input.deviceId },
      meta: {
        fragmentLengthMs: selectedMs,
        prebufferLengthMs: configuration.prebufferLength,
        resolution: configuration.videoCodec.resolution.join('x'),
        audioCodec: configuration.audioCodec.type,
        eventTriggers: configuration.eventTriggerTypes,
      },
    })
    if (selectedMs < this.input.advertisedFragmentMs) {
      // Cannot happen through hap-nodejs (iOS selects from what we advertised)
      // and is stated anyway: on a copy branch we cannot cut shorter, so if it
      // ever DID happen the clips would be silently rejected by iOS with no
      // line anywhere naming the cause.
      this.log.warn('hksv: iOS selected a SHORTER fragment length than the source can cut', {
        tags: { deviceId: this.input.deviceId },
        meta: { selectedMs, advertisedMs: this.input.advertisedFragmentMs },
      })
    }
    void this.reconcile('configuration-selected')
  }

  async *handleRecordingStreamRequest(
    streamId: number,
    signal?: AbortSignal,
  ): AsyncGenerator<RecordingPacket> {
    const source = this.source
    if (source === null || !source.isRunning) {
      // REFUSE, loudly. Yielding nothing here is the D50 timeout loop.
      this.log.warn('hksv: recording stream requested with NO prebuffer running — refusing', {
        tags: { deviceId: this.input.deviceId },
        meta: {
          streamId,
          active: this.active,
          hasConfiguration: this.configuration !== undefined,
        },
      })
      throw new HDSProtocolError(HDSProtocolSpecificErrorReason.NOT_ALLOWED)
    }

    const subscription = source.subscribe(`hksv/${this.input.deviceId}#${streamId}`)
    if (subscription === null) {
      this.log.warn('hksv: the fragment plane refused a subscription — refusing the stream', {
        tags: { deviceId: this.input.deviceId },
        meta: { streamId },
      })
      throw new HDSProtocolError(HDSProtocolSpecificErrorReason.NOT_ALLOWED)
    }

    this.open = { streamId, subscription }
    const startedAt = this.input.now()
    const prebufferSpanMs = source.prebufferSpanMs()
    // The TEE. Opened AFTER our own subscription and from a second call, so it
    // is a separate queue on the same plane: the plane closes a slow subscriber
    // rather than gapping it (D80), and closing one touches no other. Every
    // step is inside the try — a tee that cannot be built costs the clip and
    // not the recording.
    const tee = this.openTee(streamId, source, prebufferSpanMs)
    let packets = 0
    let bytes = 0
    let markedLast = false
    let longestFragmentGapMs = 0
    // Null until the FIRST fragment. The interval before it is the child's
    // start-up — spawn, RTSP connect, wait for a key frame — and charging that
    // to the first fragment is how a metronomic 4 s cadence reported 6073 ms on
    // camera 101's very first stream. The two are separate measurements.
    let firstFragmentAt: number | null = null
    let lastFragmentAt: number | null = null

    try {
      for await (const packet of subscription.packets()) {
        if (signal?.aborted === true) {
          this.log.info('hksv: the recording stream was aborted — ending the generator', {
            tags: { deviceId: this.input.deviceId },
            meta: { streamId, packets },
          })
          return
        }
        packets += 1
        bytes += packet.data.length
        if (packet.kind === 'fragment') {
          const now = this.input.now()
          if (lastFragmentAt === null) firstFragmentAt = now
          else longestFragmentGapMs = Math.max(longestFragmentGapMs, now - lastFragmentAt)
          lastFragmentAt = now
        }
        markedLast = markedLast || packet.isLast
        yield { data: Buffer.from(packet.data), isLast: packet.isLast }
        if (packet.isLast) return
      }

      // The generator ran out WITHOUT a last packet. Two ways: the plane closed
      // this subscriber (slow consumer) or it delivered nothing at all. Both
      // must produce a marked packet or an error — never a silent return.
      //
      // `released` is the THIRD way and is the opposite case: the controller
      // called `closeRecordingStream`, and HAP is explicit that the generator
      // must then return without yielding anything further — hap-nodejs will
      // not send it, and a marker here would be a packet written to a stream
      // that is already gone.
      if (!markedLast && subscription.closedReason !== 'released') {
        this.log.warn('hksv: the fragment stream ended without a final packet', {
          tags: { deviceId: this.input.deviceId },
          meta: {
            streamId,
            packets,
            closedReason: subscription.closedReason,
            // The one that matters: a subscriber closed for falling behind gets
            // a TRUNCATED clip, and the operator needs to know which cameras.
            truncated: subscription.closedReason === 'slow-consumer',
          },
        })
        if (packets === 0)
          throw new HDSProtocolError(HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE)
        // A zero-byte tail packet is a legal end-of-stream marker and is what
        // iOS needs to stop waiting. It costs one frame of nothing; the
        // alternative is the 12 s timeout this delegate exists to not cause.
        yield { data: Buffer.alloc(0), isLast: true }
      }
    } finally {
      subscription.release()
      this.finishTee(streamId, tee)
      if (this.open?.streamId === streamId) this.open = null
      const fragmentOverrun = longestFragmentGapMs > this.input.advertisedFragmentMs * 1.5
      this.log.info('hksv: recording stream finished', {
        tags: { deviceId: this.input.deviceId },
        meta: {
          streamId,
          packets,
          bytes,
          durationMs: this.input.now() - startedAt,
          prebufferSpanMs,
          longestFragmentGapMs,
          // Subscribe → first fragment. On a warm prebuffer this is ~0 because
          // the replay is already in hand; a large value means the child was
          // cold, and it is the number to read when a clip starts late.
          msToFirstFragmentMs: firstFragmentAt === null ? null : firstFragmentAt - startedAt,
          closedReason: subscription.closedReason,
          markedLast,
        },
      })
      if (fragmentOverrun) {
        // HKSV requires every fragment to be no longer than the SELECTED
        // length. An overrun is the copy branch riding a GOP longer than we
        // advertised, and its symptom is a clip that simply never appears.
        this.log.warn('hksv: fragments arrived LONGER than the advertised length', {
          tags: { deviceId: this.input.deviceId },
          meta: {
            longestFragmentGapMs,
            advertisedMs: this.input.advertisedFragmentMs,
          },
        })
      }
    }
  }

  acknowledgeStream(streamId: number): void {
    this.log.info('hksv: iOS acknowledged the end of stream — the clip landed', {
      tags: { deviceId: this.input.deviceId },
      meta: { streamId },
    })
    const tee = this.tees.get(streamId)
    this.tees.delete(streamId)
    if (tee === undefined) return
    try {
      tee.acknowledge()
    } catch (err) {
      this.log.warn('hksv clip tee: recording the acknowledgement failed', {
        tags: { deviceId: this.input.deviceId },
        meta: { streamId, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): void {
    // Named, always. `undefined` means the CONNECTION dropped, which reads
    // identically to a normal close in a log that only prints the reason.
    this.log.info('hksv: the recording stream was closed by the controller', {
      tags: { deviceId: this.input.deviceId },
      meta: {
        streamId,
        reason: reason === undefined ? 'connection-closed' : hdsReasonName(reason),
      },
    })
    const open = this.open
    if (open?.streamId === streamId) {
      // Ends the generator's `for await` on the next tick; the `finally` above
      // does the accounting.
      open.subscription.release()
      this.open = null
    }
  }

  /** Tear the prebuffer down — the accessory is being unexposed. */
  async dispose(): Promise<void> {
    this.open?.subscription.release()
    this.open = null
    this.tees.clear()
    const source = this.source
    this.source = null
    if (source) await source.stop('accessory disposed')
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * A second subscription on the same plane, handed to the tee.
   *
   * Every failure here returns `null`: no tee, a warn naming the camera, and a
   * HomeKit recording that proceeds exactly as it would have. The one thing
   * this must never do is let a clip problem reach the generator above.
   */
  private openTee(
    streamId: number,
    source: RecordingFragmentSource,
    prebufferSpanMs: number,
  ): ClipTee | null {
    const factory = this.input.openClipTee
    if (factory === undefined) return null
    let subscription: Fmp4Subscription | null = null
    try {
      subscription = source.subscribe(
        `clip/${this.input.deviceId}#${streamId}`,
        CLIP_TEE_QUEUE_CAPACITY,
      )
      if (subscription === null) {
        // A branch that drops work says so: no tee for this clip, and the clip
        // is gone forever because HAP has no read-back.
        this.log.warn(
          'hksv clip tee: the plane refused a second subscription — this clip is NOT kept',
          {
            tags: { deviceId: this.input.deviceId },
            meta: { streamId },
          },
        )
        return null
      }
      const tee = factory({ streamId, subscription, prebufferSpanMs })
      if (tee === null) {
        subscription.release()
        return null
      }
      this.rememberTee(streamId, tee)
      return tee
    } catch (err) {
      subscription?.release()
      this.log.warn(
        'hksv clip tee: could NOT be opened — the HomeKit recording continues untouched',
        {
          tags: { deviceId: this.input.deviceId },
          meta: { streamId, error: err instanceof Error ? err.message : String(err) },
        },
      )
      return null
    }
  }

  private finishTee(streamId: number, tee: ClipTee | null): void {
    if (tee === null) return
    try {
      tee.finish()
    } catch (err) {
      this.log.warn('hksv clip tee: closing the clip failed', {
        tags: { deviceId: this.input.deviceId },
        meta: { streamId, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Hold the tee until iOS acknowledges, dropping the oldest once the map is
   * full. An ack that never arrives is the normal case for a dropped
   * connection, so this map's size is the only thing bounding it.
   */
  private rememberTee(streamId: number, tee: ClipTee): void {
    this.tees.set(streamId, tee)
    while (this.tees.size > MAX_TEES_AWAITING_ACK) {
      const oldest = this.tees.keys().next()
      if (oldest.done === true) break
      this.tees.delete(oldest.value)
    }
  }

  /**
   * Start the prebuffer when iOS wants recording AND has chosen how, stop it
   * otherwise. Called from every state edge rather than each edge deciding for
   * itself: the two characteristics arrive in an order hap-nodejs explicitly
   * does not guarantee, and a per-edge decision has to re-derive the same
   * conjunction in two places.
   */
  private async reconcile(trigger: string): Promise<void> {
    const wanted = this.active && this.configuration !== undefined
    if (!wanted) {
      const source = this.source
      this.source = null
      if (source) await source.stop(`recording no longer wanted (${trigger})`)
      return
    }
    const configuration = this.configuration
    if (configuration === undefined) return
    const audioActive = this.input.isAudioActive()
    const existing = this.source
    if (existing !== null) {
      await existing.setAudioActive(audioActive)
      if (!existing.isRunning) await existing.start()
      return
    }
    const source = this.input.createSource({
      fragmentMs: configuration.mediaContainerConfiguration.fragmentLength,
      audioActive,
    })
    this.source = source
    try {
      await source.start()
    } catch (err) {
      this.source = null
      // A prebuffer that failed to start is the whole feature failing for this
      // camera; iOS shows a recording toggle that produces nothing, and without
      // this line there is no other trace of why.
      this.log.error('hksv: the prebuffer FAILED to start — this camera will record nothing', {
        tags: { deviceId: this.input.deviceId },
        meta: {
          trigger,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }
}
