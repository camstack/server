/**
 * An adaptive tier change ON THE SESSION THE VIEWER ALREADY HAS (D733).
 *
 * Until D733 every tier change was a close-and-recreate re-offer: a new
 * PeerConnection, a new ICE + DTLS handshake, a new server session, a new
 * TimelineSession. The track already carries more than one source — D42 moves
 * it between live, recorded and scrub with an RTP rebase — so moving it between
 * two RTP renditions of the same camera needs no new connection, provided the
 * negotiated codec decodes the new rendition as it is.
 *
 * Two pieces live here, both free of werift and of the server's maps:
 *  - `judgeInPlaceSwitch` — WHETHER this switch can stay on the session, and
 *    when not, the named reason the caller logs before falling back to the
 *    re-offer. A refusal is never silent.
 *  - `bindPendingSource` — make-before-break. The new broker is subscribed
 *    while the old one keeps feeding; the switch COMMITS on the first packet
 *    the new broker delivers once its RTP pre-buffer holds a GOP from a
 *    keyframe, so the replay that follows starts on an IDR and the viewer
 *    never sees a frozen frame or a partial picture. A broker that cannot
 *    produce one inside the budget is abandoned and the old source stays.
 */
import type { BrokerConsumerAttribution, IStreamBroker, Unsubscribe } from '@camstack/types'

/**
 * How long a switch waits for the new rendition's first switchable keyframe.
 * A warm broker commits on its next packet; a cold one needs its dial (2–3 s on
 * this hub) plus the camera's next IDR (≤ 4 s at the GOPs measured). 8 s covers
 * both; past it the old source has been shown the whole time, so nothing froze.
 */
export const IN_PLACE_SWITCH_KEYFRAME_WAIT_MS = 8_000

/** Why a tier change could not stay on the session. Logged on the fallback line. */
export type InPlaceRefusal =
  /** The pointer is on recorded/scrub — the ladder must not act there at all (D42). */
  | 'recorded'
  /** The transcode-down rung needs an ffmpeg egress; that is a different session shape. */
  | 'transcode-down'
  /** The session is fed AnnexB (push source) — only the source-RTP path rebinds in place. */
  | 'not-rtp-passthrough'
  /** The session's egress is a transcode, not the camera's bytes. */
  | 'transcode'
  /** The wanted tier resolved to no broker serving a known rung. */
  | 'tier-unavailable'
  /** The target broker carries no source RTP. */
  | 'target-not-rtp'
  /** The target rendition's codec is not the one this session negotiated. */
  | 'codec-differs'
  /** The client's offered H.264 profiles do not decode the target rendition as is. */
  | 'target-needs-transcode'
  /** The target's audio codec differs, so the negotiated audio path would not carry it. */
  | 'audio-codec-differs'
  /** The session's Opus egress cannot be moved to a broker without the encoder controls. */
  | 'opus-egress-unsupported'
  /** The target produced no keyframe inside `IN_PLACE_SWITCH_KEYFRAME_WAIT_MS`. */
  | 'target-no-keyframe'

/** What the session is today. */
export interface InPlaceSessionShape {
  readonly recorded: boolean
  readonly forceTranscodeDown: boolean
  readonly useRtpRepacketizer: boolean
  readonly needsTranscode: boolean
  readonly sessionCodec: 'H264' | 'H265'
  /** The current broker's audio codec; null = the source has no audio. */
  readonly audioCodec: string | null
  readonly usesOpusEgress: boolean
}

/** What the target rendition is, as far as it is known yet. */
export interface InPlaceTargetShape {
  /** The broker the tier resolved to serves a known rung. */
  readonly tierMatches: boolean
  readonly isRtp: boolean
  /** null = not known yet (a cold broker that has not delivered its SDP). */
  readonly codec: 'H264' | 'H265' | null
  readonly needsBaselineTranscode: boolean
  /** undefined = not known yet; null = the source has no audio. */
  readonly audioCodec: string | null | undefined
  readonly supportsOpusEgress: boolean
}

/** Map a broker's codec string to the session codec it would negotiate; null = unknown. */
export function sessionCodecOf(brokerCodec: string | undefined): 'H264' | 'H265' | null {
  if (brokerCodec === undefined || brokerCodec === '') return null
  const c = brokerCodec.toLowerCase()
  return c === 'h265' || c === 'hevc' ? 'H265' : 'H264'
}

/**
 * Whether the switch may stay on the session; the refusal names why not.
 * Facts not known yet (a cold target's codec or audio) do not refuse — the
 * judgement is repeated at commit time, when they are.
 */
export function judgeInPlaceSwitch(
  session: InPlaceSessionShape,
  target: InPlaceTargetShape,
): InPlaceRefusal | null {
  if (session.recorded) return 'recorded'
  if (session.forceTranscodeDown) return 'transcode-down'
  if (!session.useRtpRepacketizer) return 'not-rtp-passthrough'
  if (session.needsTranscode) return 'transcode'
  if (!target.tierMatches) return 'tier-unavailable'
  if (!target.isRtp) return 'target-not-rtp'
  if (target.codec !== null && target.codec !== session.sessionCodec) return 'codec-differs'
  if (target.needsBaselineTranscode) return 'target-needs-transcode'
  if (target.audioCodec !== undefined && !sameAudioCodec(session.audioCodec, target.audioCodec)) {
    return 'audio-codec-differs'
  }
  if (session.usesOpusEgress && !target.supportsOpusEgress) return 'opus-egress-unsupported'
  return null
}

function sameAudioCodec(a: string | null, b: string | null): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase()
}

/** A switch in flight. `cancel` abandons it without touching the old source. */
export interface PendingSource {
  /** Abandon a switch that has not committed, or drop the subscription of one that has. */
  readonly unsubscribe: Unsubscribe
  readonly committed: () => boolean
}

export interface BindPendingSourceOptions {
  readonly broker: IStreamBroker
  /** Attribution of the video subscription this becomes once committed. */
  readonly attribution: BrokerConsumerAttribution
  readonly timeoutMs: number
  /**
   * Perform the swap. Called ONCE, synchronously inside the delivery of the
   * first packet that may start the new rendition. Return false to refuse
   * (the subscription is then dropped and nothing on the session changed).
   */
  readonly commit: () => boolean
  /** Forward one packet of the committed source — including the committing one. */
  readonly forward: (rtp: Buffer) => void
  /** The budget ran out before a switchable keyframe. The old source is still on the track. */
  readonly onTimeout: () => void
}

/**
 * Subscribe `broker`'s RTP while the session's current source keeps feeding,
 * and commit when the new rendition can start on a keyframe.
 *
 * ONE subscription goes from pending to forwarding — never a second one added
 * during the delivery of the committing packet, which a broker iterating its
 * subscriber set would hand the same packet again (a duplicate behind the
 * replay). A warm-up consumer keeps a cold broker's dial up while pending and
 * is released only after the commit has attached the session's own consumers.
 */
export function bindPendingSource(opts: BindPendingSourceOptions): PendingSource {
  let state: 'pending' | 'committed' | 'gone' = 'pending'
  let warm: Unsubscribe | null = opts.broker.onEncodedData(
    () => {
      /* demand only: keeps a cold dial up until the commit */
    },
    { kind: 'warmup', media: 'both' },
  )
  const releaseWarm = (): void => {
    warm?.()
    warm = null
  }
  let unsubRtp: Unsubscribe | null = null
  const timer = setTimeout(() => {
    if (state !== 'pending') return
    state = 'gone'
    unsubRtp?.()
    releaseWarm()
    opts.onTimeout()
  }, opts.timeoutMs)
  unsubRtp = opts.broker.onVideoRtp((rtp) => {
    if (state === 'gone') return
    if (state === 'committed') {
      opts.forward(rtp)
      return
    }
    // The broker captures a packet into its pre-buffer BEFORE fan-out, so a
    // non-empty pre-buffer here already starts at this rendition's keyframe
    // and ends with `rtp`.
    if (opts.broker.getRtpPreBuffer().length === 0) return
    clearTimeout(timer)
    if (!opts.commit()) {
      state = 'gone'
      unsubRtp?.()
      releaseWarm()
      return
    }
    state = 'committed'
    releaseWarm()
    opts.forward(rtp)
  }, opts.attribution)
  return {
    unsubscribe: () => {
      if (state === 'pending') clearTimeout(timer)
      state = 'gone'
      unsubRtp?.()
      releaseWarm()
    },
    committed: () => state === 'committed',
  }
}
