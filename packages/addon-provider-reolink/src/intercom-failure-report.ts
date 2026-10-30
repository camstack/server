/**
 * Per-camera talk-back counters, published through `failure-contribution`.
 *
 * ## The number that was never divided
 *
 * The rate-mismatch drop had ONE warn line and no counter, so "how much
 * talk-back is this camera losing" was answerable only by grepping Loki and
 * hand-correlating timestamps — the exact cost `failure-contribution` exists to
 * remove. And a bare drop count could not have answered it either: 40 drops out
 * of 40 pushes and 40 out of 40 000 are opposite findings that produce
 * identical log volume.
 *
 * So EVERY `pushTalkAudio` outcome on a live talk session is noted from the one
 * place that decides it — the accepted ones too. {@link FailureCounters}
 * carries `attempts` as the denominator and `succeeded` as the numerator, and
 * the reasons partition the rest. A success counted somewhere else would drift
 * from the failures and turn the ratio into fiction.
 *
 * ## `variant` is the wire codec, and it is honest
 *
 * `failure-contribution` keeps `variant` for a second dimension WITHIN a
 * family, and here the useful one is the format the caller pushed: an operator
 * asking "why is 102 silent" needs to know whether HomeKit's Opus or Alexa's
 * raw PCM is the half that is failing. The provider is handed that value on
 * every call, so it is reported rather than guessed — absent, never invented.
 *
 * ## Process-wide, because a counter is
 *
 * One addon is one process (D2) and every camera this addon owns lives in it,
 * so the instance is module-scoped: the cameras note into it and the addon
 * registers ONE `failure-contribution` provider that reads it. `sinceMs` is the
 * incarnation marker — a respawned runner restarts from zero and says so.
 * Reading NEVER drains.
 */

import type { FailureCounterSample } from '@camstack/types'
import { FailureCounters } from '@camstack/types'

/** One `pushTalkAudio` call against an open talk session. */
export const FAMILY_INTERCOM_TALK = 'intercom-talk'

/** The push arrived with a sequence number at or below the last accepted one. */
export const REASON_TALK_OUT_OF_ORDER = 'out-of-order'
/** The payload decoded to zero bytes. */
export const REASON_TALK_EMPTY = 'empty-frame'
/** More than one channel — every camera here is mono-only. */
export const REASON_TALK_NOT_MONO = 'not-mono'
/** `s16le` push with no `sampleRate`; the rate is ambiguous, not assumed. */
export const REASON_TALK_NO_SAMPLE_RATE = 'missing-sample-rate'
/** The wire codec has no path onto this camera's talk channel. */
export const REASON_TALK_CODEC_UNSUPPORTED = 'codec-unsupported'
/** The Opus decode path threw or could not open its session. */
export const REASON_TALK_OPUS_FAILED = 'opus-decode-failed'

/**
 * The addon's talk-back counters. One instance per process; the export at the
 * bottom of this file IS that instance.
 */
export class IntercomFailureReport {
  private readonly counters: FailureCounters

  constructor(
    private readonly now: () => number = Date.now,
    counters: FailureCounters = new FailureCounters(),
  ) {
    this.counters = counters
  }

  /**
   * Note one `pushTalkAudio` outcome. `reason` absent = the frame reached the
   * camera's talk channel.
   */
  noteTalkFrame(deviceId: number, wireCodec: string, reason?: string): void {
    this.counters.note(
      {
        deviceId,
        family: FAMILY_INTERCOM_TALK,
        variant: wireCodec,
        ...(reason !== undefined ? { reason } : {}),
      },
      this.now(),
    )
  }

  /** The `failure-contribution` provider's payload. Reads, never resets. */
  list(): readonly FailureCounterSample[] {
    return this.counters.snapshot(this.now())
  }

  /** Addon disposal. */
  clear(): void {
    this.counters.clear()
  }
}

/** The process-wide instance every camera in this addon notes into. */
export const intercomFailureReport = new IntercomFailureReport()
