/** RTP header + payload ready to send over TCP interleaved. */
export interface RtpPacket {
  /** RTP payload including 12-byte header. */
  readonly data: Buffer
  /** Whether this packet starts an access unit (for keyframe detection). */
  readonly marker: boolean
}

/** Parsed RTSP request from a client. */
export interface RtspRequest {
  readonly method: string
  readonly uri: string
  readonly cseq: number
  readonly headers: ReadonlyMap<string, string>
  readonly body?: string
}

/** Track setup state per client session. */
export interface TrackSetup {
  readonly trackId: number
  readonly rtpChannel: number
  readonly rtcpChannel: number
}

/** Client session state. */
export interface ClientSession {
  readonly sessionId: string
  readonly tracks: ReadonlyArray<TrackSetup>
  readonly playing: boolean
}

/** Codec parameters extracted from the stream. */
export interface CodecParams {
  readonly codec: 'h264' | 'h265'
  /** Parameter set NALs (SPS+PPS for H.264, VPS+SPS+PPS for H.265). */
  readonly parameterSets: ReadonlyArray<Buffer>
  readonly width?: number
  readonly height?: number
}

/** RTSP method constants. */
export const RTSP_METHODS = [
  'OPTIONS',
  'DESCRIBE',
  'SETUP',
  'PLAY',
  'TEARDOWN',
  'GET_PARAMETER',
] as const

/** RTP constants. */
export const RTP_VERSION = 2
export const RTP_HEADER_SIZE = 12
export const RTP_MAX_PAYLOAD = 1400 // Safe MTU for TCP interleaved

/** H.264 NAL type masks. */
export const H264_NAL_TYPE_MASK = 0x1f
export const H264_NAL_FUA = 28

/** H.265 NAL type extraction: (byte0 >> 1) & 0x3f. */
export const H265_NAL_TYPE_SHIFT = 1
export const H265_NAL_TYPE_MASK = 0x3f
export const H265_NAL_FU = 49

/** TCP interleaved framing: magic byte. */
export const INTERLEAVED_MAGIC = 0x24

/** Max write buffer before a session stops being written to. */
export const MAX_WRITE_BUFFER = 2 * 1024 * 1024

/**
 * Consecutive keyframe access units at which a session was still unwritable
 * before it is closed as GONE.
 *
 * Backpressure measures LIVENESS, not identity. A session over
 * {@link MAX_WRITE_BUFFER} is never closed for being momentarily behind — it
 * drops the packet and latches to the next keyframe. Only a session that
 * cannot be written at this many CONSECUTIVE keyframes is treated as a peer
 * that vanished, and closing is how we notice: there is no read-side timeout,
 * and `sessions.size` gates real upstream work, so a peer that went away
 * without a FIN would otherwise hold a stream open for hours.
 *
 * Three, because it must clear a transient without being generous to a
 * corpse. At a typical 1–4 s GOP that is 3–12 s of a socket that never drains
 * — far past any scheduling blip, far short of a TCP keepalive.
 *
 * The value this replaces was effectively ZERO for every session that was not
 * the decoder loopback: the first backlogged packet closed the client. On the
 * live hub 2026-09-01 that cost 899 recorder deaths in 24 h and the
 * duplicate-at-respawn.
 */
export const MAX_MISSED_KEYFRAMES = 3
