/**
 * The browser WebRTC session's transcode leg, expressed as a request to THE
 * ffmpeg primitive ([D67](../../../../../docs/decisions/adr-0067.md)).
 *
 * ## What the leg used to be
 *
 * `AdaptiveSession.startTranscodeFeed` built its own `FfmpegInvocation`, spawned
 * its own `ffmpeg`, re-framed the raw `-f h264 pipe:1` bytestream back into
 * access units, and carried its own hardware→software retry. Every one of those
 * was a second implementation of something the broker already owned, and the
 * differences were invisible:
 *
 *  - **no copy decision.** The leg re-encoded unconditionally. The manager asks
 *    `decideEgressCopy` first and copies when every requested constraint is
 *    provably satisfied. (For this profile the answer is always ENCODE — it
 *    names `profile`, `bitrateKbps`, `preset` and `gopFrames`, none of which a
 *    `CameraStream` can prove — but the leg no longer decides that itself.)
 *  - **no dedup.** Two browsers on one camera at one tier ran two encoders.
 *  - **its own retry, on its own trigger** — "the child exited having produced
 *    no stdout" rather than the manager's first-packet deadline.
 *  - **`decodeHwAccel` reported as REQUESTED.** The handle reports what the
 *    child actually ran with, which is the point of D67's hwaccel rule.
 *
 * ## Two things the request must keep saying
 *
 * **`publishLocally: true`.** Dialling the returned url republishes the egress
 * as an RTP source, so `isRtpSource()` becomes true and the session takes the
 * RTP-passthrough + repacketizer branch. That path was measured black on Alexa
 * with every other link in the chain healthy; the push/deframe branch — the one
 * the derived mechanism has live hours on — renders. The leg attaches by
 * `camStreamId`, never by url.
 *
 * **`audio: 'passthrough'`.** A browser's audio rides the WebRTC session's own
 * plane, encoded by werift out-of-band from `this.source`. An in-band plane here
 * would be encoded by ffmpeg and then dropped on the floor — which is exactly
 * what Alexa's old profile did with Opus for months.
 *
 * ## And one it must NOT say
 *
 * The session id goes in `tag`, which `egressTranscodeSharingKey` excludes. If
 * it ever reaches a keyed field, two browsers watching the same camera at the
 * same tier stop sharing a child and nothing anywhere reports it.
 */
import type { EgressTranscodeRequest, EncodedPacket, EncodeProfile } from '@camstack/types'

import { isH264IdrAccessUnit } from './h264-utils.js'
import { convertH264ToAnnexB } from './h264-utils.js'
import { splitAnnexBToNals } from './nal-utils.js'

export interface TranscodeEgressRequestInput {
  readonly deviceId: number
  /** The SOURCE stream this session is bound to — the transcode reads it. */
  readonly camStreamId: string
  /** The session's effective encode profile, INCLUDING a transcode-down rung. */
  readonly profile: EncodeProfile
  /** Attribution only. Never keyed — see the module docblock. */
  readonly sessionId: string
}

/**
 * The request a browser session makes. Structured only: the primitive's schema
 * has no raw-flag escape hatch, so there is no way for one consumer to fork the
 * shared child by spelling a flag differently.
 */
export function buildTranscodeEgressRequest(
  input: TranscodeEgressRequestInput,
): EgressTranscodeRequest {
  return {
    deviceId: input.deviceId,
    source: { kind: 'cam-stream', camStreamId: input.camStreamId },
    // `video` verbatim, `audio` forced: the profile's audio field is irrelevant
    // here whatever it says, because the session never reads the egress's audio
    // plane. Rebuilding the object also drops `inputArgs`/`outputArgs`, which
    // `EgressEncodeSchema` omits.
    encode: { video: input.profile.video, audio: 'passthrough' },
    rateControl: 'relaxed',
    publishLocally: true,
    tag: `webrtc/${input.sessionId}`,
  }
}

/**
 * One acquired egress, as the session sees it.
 *
 * `attachVideo` is a subscription to the LOCAL published stream, not a dial —
 * the leg and the transcode live in the same process, so the media never leaves
 * it. The handle is IMMUTABLE (D67: no `reconfigure`): a session whose encode
 * requirements change releases this one and acquires another.
 */
export interface TranscodeEgressLeg {
  /** The broker-named push stream. The consumer attaches to THIS, never to a url. */
  readonly camStreamId: string
  /** The release handle. Refcounted — the child dies when the last holder releases. */
  readonly pipelineKey: string
  readonly encoder: string
  /** What the child ACTUALLY decoded with — `null` for software. */
  readonly decodeHwAccel: string | null
  attachVideo(onPacket: (packet: EncodedPacket) => void): () => void
  release(): Promise<void>
}

export type AcquireTranscodeEgress = (input: {
  readonly profile: EncodeProfile
  readonly sessionId: string
}) => Promise<TranscodeEgressLeg>

/** One access unit, ready for `writeVideoNals`. */
export interface FramedAccessUnit {
  readonly nals: readonly Buffer[]
  readonly keyframe: boolean
}

/**
 * Turns the egress's encoded packets into the access-unit shape the WebRTC
 * consumers already see. Every rule here is one of the field-learned gotchas in
 * `docs/architecture/data-planes.md#webrtc-gotchas`:
 *
 *  - **SPS/PPS/IDR stay in ONE access unit.** The old leg had to rebuild them
 *    from a raw bytestream that carried no frame boundaries; a demuxed packet
 *    is already one access unit, so the merge is structural rather than
 *    reconstructed. Splitting them across RTP timestamps is why Chrome could
 *    not decode.
 *  - **A keyframe is an IDR *or* an SPS.** Some cameras use non-IDR I-frames,
 *    and `isH264IdrAccessUnit` encodes that; this agrees with it rather than
 *    re-deriving the test.
 *  - **An IDR without inline parameter sets gets the cached pair prepended**,
 *    so a viewer joining mid-GOP has a configured decoder.
 *  - **AUD and SEI are dropped.** Neither belongs in RTP.
 *  - **A placeholder packet is ignored entirely.** Its parameter sets describe
 *    a different resolution; caching them and prepending them to a real
 *    keyframe freezes the viewer on the last placeholder.
 */
export class H264EgressFramer {
  private sps: Buffer | null = null
  private pps: Buffer | null = null
  private gotKeyframe = false

  /** The NALs to send, or `null` when this packet contributes nothing. */
  accept(packet: EncodedPacket): FramedAccessUnit | null {
    if (packet.type !== 'video') return null
    if (packet.isPlaceholder === true) return null

    const annexB = convertH264ToAnnexB(packet.data)
    const nals = splitAnnexBToNals(annexB).filter((n) => {
      const t = n[0]! & 0x1f
      return t !== 9 && t !== 6
    })
    if (nals.length === 0) return null

    for (const n of nals) {
      const t = n[0]! & 0x1f
      if (t === 7) this.sps = Buffer.from(n)
      if (t === 8) this.pps = Buffer.from(n)
    }

    const keyframe = isH264IdrAccessUnit(annexB)
    if (!this.gotKeyframe) {
      // Sending a P-frame before the decoder has ever seen an IDR renders as
      // corruption, not as "almost there".
      if (!keyframe) return null
      this.gotKeyframe = true
    }
    if (!keyframe) return { nals, keyframe: false }

    const hasInlineSps = nals.some((n) => (n[0]! & 0x1f) === 7)
    const auNals = !hasInlineSps && this.sps && this.pps ? [this.sps, this.pps, ...nals] : nals
    return { nals: auNals, keyframe: true }
  }
}
