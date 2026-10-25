/**
 * Copy-vs-encode for `streamBroker.acquireEgressTranscode`.
 *
 * The primitive used to pass `forceReencode: true` unconditionally, so it
 * re-encoded a source that already satisfied the request — "the consumer asked
 * for a SHAPE, not for whatever the source already is" was true of the
 * derived-stream editor and wrong here, where the request is a set of
 * CONSTRAINTS a consumer needs met.
 *
 * ## Conservative by construction
 *
 * Copy iff EVERY requested constraint is provably satisfied by a KNOWN source
 * fact. Any unknown fact ⇒ encode. That asymmetry is the whole design: an
 * encode that was not needed costs CPU, while a copy that was not warranted
 * ships a stream the consumer cannot decode — an Echo showing black, a HomeKit
 * session dropping — and it does so on the paths that are hardest to observe.
 *
 * `CameraStream` (the only source-fact carrier the broker has) declares
 * `codec`, `resolution` and `fps`, and nothing else. It carries no bitrate, no
 * H.264 profile and no level, so **any request naming one of those encodes,
 * always**. That is not a gap to paper over with an assumption: Alexa's request
 * names profile, level and bitrate, so Alexa still encodes, which is correct —
 * its 720p25/2500k baseline requirement is not something a 4K main stream
 * happens to meet.
 *
 * ## What is deliberately NOT here
 *
 * **Audio.** `CameraStream` carries no audio codec at all, so a requested audio
 * codec can never be proven to match the source and the answer would be
 * "transcode" in every case — a decision procedure with one outcome is a
 * comment, not code. When a source-fact carrier grows an audio codec, this is
 * where the audio matrix goes.
 *
 * ## Why the sharing key does not move
 *
 * The key stays REQUEST-derived. The resolution here is deterministic per
 * source, and an entry is immutable — a camera that reconfigures its main
 * stream mid-life is handled by the consumer releasing and re-acquiring
 * (there is no `reconfigure` by design, D67), not by re-keying live children.
 */
import type { EgressTranscodeRequest } from '@camstack/types'

/** The requested video shape — the `encode.video` block of a request. */
export type EgressVideoRequest = EgressTranscodeRequest['encode']['video']

/**
 * What is KNOWN about the source stream. Every field is optional and an absent
 * one means "not knowable", never "not constrained" — {@link decideEgressCopy}
 * treats the two differently on purpose.
 */
export interface EgressSourceFacts {
  /** Normalised (`normaliseSourceCodec`) — absent when the publisher said nothing. */
  readonly codec?: 'h264' | 'h265'
  readonly width?: number
  readonly height?: number
  readonly fps?: number
}

/** One constraint the source could not be PROVEN to satisfy. */
export interface UnsatisfiedConstraint {
  /** The request field, so the log line names the knob the operator set. */
  readonly constraint: string
  /** Why, in the terms of the actual numbers — "source 3840 > requested 1280". */
  readonly reason: string
}

export interface EgressCopyDecision {
  readonly copy: boolean
  readonly unsatisfied: readonly UnsatisfiedConstraint[]
}

/**
 * `-g`, `-bf`, `-preset` and `-tune` are instructions to an ENCODER. A copy
 * emits none of them, so a request that names one cannot be honoured by a copy
 * however the source is shaped.
 */
const ENCODER_ONLY_FIELDS = ['gopFrames', 'bf', 'preset', 'tune'] as const

/**
 * Facts `CameraStream` never carries. Requesting one is a permanent encode, and
 * naming them here keeps the log line honest about WHY rather than reporting a
 * mismatch that was never measured.
 */
const UNMEASURED_FIELDS = ['bitrateKbps', 'profile', 'level'] as const

/**
 * Decide whether the source can be handed through untouched.
 *
 * `codec: 'copy'` is not routed here — it is an explicit instruction the
 * invocation builder already honours without asking anything about the source.
 */
export function decideEgressCopy(
  video: EgressVideoRequest,
  source: EgressSourceFacts,
): EgressCopyDecision {
  const unsatisfied: UnsatisfiedConstraint[] = []

  if (source.codec === undefined) {
    unsatisfied.push({
      constraint: 'codec',
      reason: `requested ${video.codec} and the source stream declares no codec`,
    })
  } else if (source.codec !== video.codec) {
    unsatisfied.push({
      constraint: 'codec',
      reason: `requested ${video.codec}, source is ${source.codec}`,
    })
  }

  pushDimension(unsatisfied, 'width', video.width, source.width)
  pushDimension(unsatisfied, 'height', video.height, source.height)
  pushDimension(unsatisfied, 'fps', video.fps, source.fps)

  for (const field of UNMEASURED_FIELDS) {
    if (video[field] !== undefined) {
      unsatisfied.push({
        constraint: field,
        reason: `requested ${String(video[field])} and the source carries no ${field} — never provable, so never copied`,
      })
    }
  }

  for (const field of ENCODER_ONLY_FIELDS) {
    if (video[field] !== undefined) {
      unsatisfied.push({
        constraint: field,
        reason: `${field} is an encoder instruction a copy cannot emit`,
      })
    }
  }

  return { copy: unsatisfied.length === 0, unsatisfied }
}

/** A numeric CEILING constraint: satisfied only when a known source value is ≤ it. */
function pushDimension(
  into: UnsatisfiedConstraint[],
  constraint: 'width' | 'height' | 'fps',
  requested: number | undefined,
  known: number | undefined,
): void {
  if (requested === undefined) return
  if (known === undefined) {
    into.push({
      constraint,
      reason: `requested ${requested} and the source declares no ${constraint}`,
    })
    return
  }
  if (known > requested) {
    into.push({
      constraint,
      reason: `source ${known} > requested ${requested}`,
    })
  }
}
