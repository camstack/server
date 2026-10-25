/**
 * The filler for a SENTRY session's audio track: silence while the camera
 * sleeps, nothing at all while the camera's own audio is flowing.
 *
 * The video counterpart is `SentryPump` — one encode, re-emitted at 1 fps until
 * real media lands. This is the same shape on the audio plane, and it holds the
 * same three rules:
 *
 *  1. **It never dials.** No source, no socket, no demand. It is driven by the
 *     sessions already attached and by nothing else, so a sentry can hold a
 *     battery camera's track open for ever without waking it (D173).
 *  2. **Real media always wins.** {@link noteRealAudio} clears the timer
 *     SYNCHRONOUSLY on the camera's first audio packet, so no generated frame
 *     can still be in flight behind it. Overlapping silence with real audio is
 *     worse than either — the consumer would hear the camera under a floor of
 *     our own frames.
 *  3. **It comes back.** A camera that wakes and sleeps again leaves the same
 *     session attached, and a track that stops being filled is the stall the
 *     whole feature exists to avoid. The gap is a rolling
 *     {@link SentryAudioSilenceOptions.resumeGapMs}: the run restarts only once
 *     the camera has been quiet for longer than any ordinary inter-packet gap.
 *
 * ── What it costs ─────────────────────────────────────────────────────────
 * ONE packet per frame interval per BROKER — not per consumer: the packet is
 * built once and handed to every sentry session by reference, exactly as the
 * live path does. At 20 ms and 172 bytes that is 8.6 KB/s of loopback traffic
 * on a camera someone is watching and nobody has woken, and zero on every
 * camera with no sentry attached, because the timer only exists while a sentry
 * session does. The bound is structural: it cannot scale with consumers, and it
 * cannot outlive the sessions.
 *
 * ── The clock ─────────────────────────────────────────────────────────────
 * The RTP timestamp is anchored to WALL CLOCK at the start of each run
 * (`now * clockRate/1000`), the same epoch the placeholder video plane uses for
 * its own 90 kHz stamps (`Math.floor(packet.pts * 90)` with `pts = Date.now()`
 * in `SentryPump`'s emit). Within a run it advances by exactly one frame per
 * packet, so the spacing is nominal rather than timer-jittered; across a
 * suppression it re-anchors, so a track that was quiet for an hour does not
 * resume an hour in the past.
 */
import type { IScopedLogger, LogTags } from '@camstack/types'

import {
  buildG711SilenceRtp,
  G711_FRAME_MS,
  G711_FRAME_SAMPLES,
  type G711AudioTrack,
} from './g711-silence.js'

/**
 * How long the camera must be quiet before the filler takes the track back.
 *
 * Longer than any plausible inter-packet gap on a live G.711 stream (20 ms
 * nominal, 50 pps) by two orders of magnitude, so a momentary stutter in real
 * audio can never be papered over with generated frames; short enough that a
 * consumer's decoder does not see a hole when the camera goes back to sleep.
 */
const DEFAULT_RESUME_GAP_MS = 1_000

export interface SentryAudioSilenceOptions {
  /** The shape announced in the sentry SDP. The packets must match it. */
  readonly track: G711AudioTrack
  /**
   * Hand one packet to every sentry session. Returns how many were served —
   * `0` means the run is producing nothing, which is a fact the caller logs.
   */
  readonly emit: (rtp: Buffer) => number
  readonly logger?: IScopedLogger
  /** Numeric device id. Every line this filler logs carries it. */
  readonly deviceId?: number
  /** Packet interval. One frame; see {@link G711_FRAME_MS}. */
  readonly frameMs?: number
  /** See {@link DEFAULT_RESUME_GAP_MS}. */
  readonly resumeGapMs?: number
}

export class SentryAudioSilence {
  private readonly options: SentryAudioSilenceOptions
  private readonly frameMs: number
  private readonly resumeGapMs: number
  private readonly tags: { readonly tags: LogTags } | Record<string, never>
  private readonly ssrc: number

  private timer: ReturnType<typeof setInterval> | undefined
  private resumeTimer: ReturnType<typeof setTimeout> | undefined
  private sequenceNumber: number
  private rtpTimestamp = 0
  private markNext = true
  private emitted = 0
  /** Frames that reached at least one session. See {@link stopRun}. */
  private delivered = 0
  private lastRealAudioAt = 0
  private wanted = false

  constructor(options: SentryAudioSilenceOptions) {
    this.options = options
    this.frameMs = options.frameMs ?? G711_FRAME_MS
    this.resumeGapMs = options.resumeGapMs ?? DEFAULT_RESUME_GAP_MS
    this.tags = options.deviceId === undefined ? {} : { tags: { deviceId: options.deviceId } }
    // A fresh SSRC per filler. The camera's own audio carries its own, so the
    // consumer sees a source change at the transition either way; what matters
    // is that two runs of OUR frames are one source, not two.
    this.ssrc = (Math.random() * 0xffffffff) >>> 0
    this.sequenceNumber = (Math.random() * 0xffff) & 0xffff
  }

  /** The audio shape this filler was built for. */
  get track(): G711AudioTrack {
    return this.options.track
  }

  /** True while packets are actually being produced. */
  get running(): boolean {
    return this.timer !== undefined
  }

  /**
   * Somebody wants the track filled. Idempotent — reconciliation calls this on
   * every session edge, and a second call while a run is in flight must not
   * restart the clock or re-log.
   */
  want(): void {
    this.wanted = true
    this.startRun()
  }

  /**
   * Nobody wants the track filled any more (the last sentry left, the operator
   * muted the device, the broker is going away). Idempotent.
   */
  release(reason: string): void {
    this.wanted = false
    this.clearResume()
    this.stopRun(reason)
  }

  /**
   * The camera's own audio just arrived.
   *
   * Synchronous, and the first thing `pushAudioRtpPassthrough` does: the timer
   * is gone before this packet is written to any session, so no generated frame
   * can follow it. Called on EVERY real packet, not only the first — the rolling
   * gap is what lets the filler come back when the camera sleeps again, without
   * a second signal anybody has to remember to send.
   */
  noteRealAudio(nowMs: number): void {
    this.lastRealAudioAt = nowMs
    this.stopRun('real audio')
    this.armResume()
  }

  private startRun(): void {
    if (this.timer !== undefined) return
    if (!this.wanted) return
    if (Date.now() - this.lastRealAudioAt < this.resumeGapMs) {
      this.armResume()
      return
    }
    // Re-anchor on the wall clock: a run that resumes after the camera slept
    // must not continue a timeline that stopped advancing an hour ago.
    this.rtpTimestamp = Math.floor((Date.now() * this.options.track.clockRateHz) / 1000) >>> 0
    this.markNext = true
    this.emitted = 0
    this.delivered = 0
    this.timer = setInterval(() => this.tick(), this.frameMs)
    this.options.logger?.info('sentry audio: filling the track with silence', {
      ...this.tags,
      meta: {
        codec: this.options.track.codec,
        payloadType: this.options.track.payloadType,
        frameMs: this.frameMs,
        clockRateHz: this.options.track.clockRateHz,
      },
    })
  }

  private stopRun(reason: string): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
    this.options.logger?.info('sentry audio: stopped filling the track', {
      ...this.tags,
      // Both numbers, always. A run that emitted frames and DELIVERED none
      // accepted work and produced nothing — the session was never in PLAY, or
      // it went away between the reconcile and the tick — and that has to be
      // readable per camera rather than inferred from a silent stream.
      meta: { reason, framesEmitted: this.emitted, framesDelivered: this.delivered },
    })
  }

  /**
   * Re-check once the gap has elapsed.
   *
   * A single pending timeout rather than a free-running ticker that decides per
   * frame: while the camera is awake this costs one timer per second instead of
   * fifty, and while it is asleep it costs nothing at all — the run is the
   * ticker.
   */
  private armResume(): void {
    if (!this.wanted) return
    if (this.resumeTimer !== undefined) return
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined
      this.startRun()
    }, this.resumeGapMs)
    this.resumeTimer.unref?.()
  }

  private clearResume(): void {
    if (this.resumeTimer === undefined) return
    clearTimeout(this.resumeTimer)
    this.resumeTimer = undefined
  }

  private tick(): void {
    const rtp = buildG711SilenceRtp({
      track: this.options.track,
      ssrc: this.ssrc,
      sequenceNumber: this.sequenceNumber,
      rtpTimestamp: this.rtpTimestamp,
      marker: this.markNext,
    })
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff
    this.rtpTimestamp = (this.rtpTimestamp + G711_FRAME_SAMPLES) >>> 0
    this.markNext = false
    this.emitted += 1
    if (this.options.emit(rtp) > 0) this.delivered += 1
  }
}
