/**
 * The bytes a SENTRY session's audio track is filled with while the camera
 * sleeps, and the media block that describes them.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * RTSP cannot renegotiate mid-session. A `/sentry` dial is defined as "the
 * stream WITHOUT the camera", so it attaches while the camera is asleep and
 * stays attached across the wake — the SDP it was handed at DESCRIBE is the
 * only one it will ever see. Either that SDP has an `m=audio` or the consumer
 * can never receive the camera's audio, awake or asleep.
 *
 * Announcing an `m=audio` nobody fills is a real hazard: a consumer's ffmpeg
 * waits on a stream that never arrives. The answer is to FILL it. Silence
 * while the picture is being served, the camera's own RTP the instant media
 * flows, and never both (D525).
 *
 * ── Why ONLY G.711 ────────────────────────────────────────────────────────
 * Silence must be EXACT, not approximate: µ-law's representation of digital
 * zero is `0xFF` and A-law's is `0xD5`, both one byte per sample, both at a
 * static RTP payload type the camera's own stream will use unchanged (PCMU=0,
 * PCMA=8, RFC 3551). So the block we describe while asleep and the packets the
 * camera sends when awake agree on payload type, clock and framing by
 * construction — no remap, no guess, no negotiation.
 *
 * Every other codec is REFUSED, by name, and the sentry gets no audio track at
 * all rather than one the camera would contradict. AAC and Opus have no fixed
 * silence byte — they must be encoded (`encodeOpusSilenceFrame`), their payload
 * types are dynamic and per-camera, and an fmtp we synthesised would not be the
 * one the camera announces on wake. A sentry handed a track it cannot fill is
 * the stall this module exists to avoid. `audio-rtp-decoder.ts` records why
 * this is a narrow refusal in practice: "IP cameras almost universally use
 * G.711 for audio (8 kHz, mono)".
 */

/** The two codecs whose silence is a known constant byte. */
export type G711Codec = 'PCMU' | 'PCMA'

/**
 * The audio shape a sentry announces and fills.
 *
 * Carried whole rather than as a codec name, because the media block and the
 * RTP header have to agree about all four values and a caller that could state
 * three of them would eventually state three.
 */
export interface G711AudioTrack {
  readonly codec: G711Codec
  /** Static RFC 3551 payload type — 0 for PCMU, 8 for PCMA. */
  readonly payloadType: number
  readonly clockRateHz: number
  readonly channels: number
}

/** 20 ms at 8 kHz — one sample per byte, so also the payload length. */
export const G711_FRAME_SAMPLES = 160
/** The packet interval the filler runs at. One frame, no batching: a batch is
 *  a window in which generated silence could still be in flight after the
 *  camera's first real packet. */
export const G711_FRAME_MS = 20

const SILENCE_BYTE: Readonly<Record<G711Codec, number>> = {
  /** µ-law digital zero. */
  PCMU: 0xff,
  /** A-law digital zero. */
  PCMA: 0xd5,
}

const STATIC_PAYLOAD_TYPE: Readonly<Record<G711Codec, number>> = {
  PCMU: 0,
  PCMA: 8,
}

/** G.711 is 8 kHz mono by definition (RFC 3551). */
const G711_CLOCK_RATE_HZ = 8000
const G711_CHANNELS = 1

/**
 * The track for a codec name as the camera's SDP spelled it, or `null`.
 *
 * `null` is a REFUSAL with a reason the caller must log, never a fallback to
 * PCMU: a sentry filled with the wrong codec's bytes is audible garbage on
 * every consumer, which is strictly worse than the silence of no track at all.
 */
export function g711TrackFor(codec: string | undefined): G711AudioTrack | null {
  if (codec === undefined) return null
  const upper = codec.toUpperCase()
  if (upper !== 'PCMU' && upper !== 'PCMA') return null
  return {
    codec: upper,
    payloadType: STATIC_PAYLOAD_TYPE[upper],
    clockRateHz: G711_CLOCK_RATE_HZ,
    channels: G711_CHANNELS,
  }
}

/**
 * The `m=audio` block grafted onto the sentry's video-only SDP.
 *
 * Built rather than extracted from the camera's SDP on purpose. A static
 * payload type makes the description fully determined by the codec, so the
 * block is correct even when no camera SDP exists — which is the state this
 * whole path is for. `extractAudioMediaBlock` cannot serve here: it remaps a
 * dynamic payload type to 97 for the ffmpeg egress graft, and a remap is
 * exactly what must not happen to a track the camera will later fill itself.
 */
export function g711AudioMediaBlock(track: G711AudioTrack, trackId: number): string {
  return [
    `m=audio 0 RTP/AVP ${track.payloadType}`,
    'c=IN IP4 0.0.0.0',
    `a=rtpmap:${track.payloadType} ${track.codec}/${track.clockRateHz}`,
    `a=control:trackID=${trackId}`,
  ].join('\r\n')
}

/** Everything one silence packet needs. No clock, no state, no I/O. */
export interface G711SilenceRtpInput {
  readonly track: G711AudioTrack
  readonly ssrc: number
  readonly sequenceNumber: number
  readonly rtpTimestamp: number
  /** RFC 3551 talkspurt convention: set on the first packet of a run. */
  readonly marker: boolean
}

/**
 * One complete RTP packet of silence: 12-byte header plus one frame of the
 * codec's zero byte. Pure — the caller owns the sequence, the clock and the
 * decision to send.
 */
export function buildG711SilenceRtp(input: G711SilenceRtpInput): Buffer {
  const packet = Buffer.alloc(12 + G711_FRAME_SAMPLES, SILENCE_BYTE[input.track.codec])
  packet[0] = 0x80
  packet[1] = (input.marker ? 0x80 : 0x00) | (input.track.payloadType & 0x7f)
  packet.writeUInt16BE(input.sequenceNumber & 0xffff, 2)
  packet.writeUInt32BE(input.rtpTimestamp >>> 0, 4)
  packet.writeUInt32BE(input.ssrc >>> 0, 8)
  return packet
}
