/**
 * `RTP Streaming Control` (0x8045) — start and stop, on the new service.
 *
 * It replaces the classic `Selected RTP Stream Configuration`, and it is a
 * different shape, not a variation. The classic one carries the whole selected
 * configuration inside the start: codec, profile, level, resolution, bitrate.
 * This one carries a **tier identifier**. The configuration was agreed when we
 * published `Supported Video Stream Tiers`; the controller now names one of
 * those entries.
 *
 * That is why the adapter maps an identifier back to the tier we advertised
 * instead of reading parameters off the write — and why a tier identifier we
 * never published is `No Such Stream` rather than something to improvise from.
 *
 * Bytes only. The engine lives elsewhere.
 */
import { decode, encode, uuid } from '@homebridge/hap-nodejs'

enum ControlTlv {
  SESSION_IDENTIFIER = 0x01,
  COMMAND = 0x02,
  VIDEO_TIER = 0x03,
  VIDEO_SSRC = 0x04,
  AUDIO_TIER = 0x05,
  AUDIO_SSRC = 0x06,
}

enum StatusTlv {
  SESSION_IDENTIFIER = 0x01,
  STATUS = 0x02,
}

export enum RtpStreamingCommand {
  END = 1,
  START = 2,
}

export enum RtpStreamingStatus {
  SUCCESS = 0,
  UNKNOWN_SESSION_IDENTIFIER = 1,
  /** An End for a stream that is not started. */
  NO_SUCH_STREAM = 2,
  BUSY = 3,
  ERROR = 4,
}

export interface RtpStreamingControlCommand {
  readonly sessionId: string
  readonly command: RtpStreamingCommand
  /** Present only on START — § 4.16 says so, and an End that carried them
   *  would be malformed. */
  readonly videoTier?: number
  readonly videoSsrc?: number
  readonly audioTier?: number
  readonly audioSsrc?: number
}

function required(map: Record<string, Buffer | undefined>, type: number, what: string): Buffer {
  const value = map[String(type)]
  if (value === undefined) {
    throw new Error(`rtp-streaming-control: ${what} is missing from the controller's write`)
  }
  return value
}

function optionalUint32(map: Record<string, Buffer | undefined>, type: number): number | undefined {
  const value = map[String(type)]
  return value === undefined ? undefined : value.readUInt32LE(0)
}

export function decodeRtpStreamingControl(base64: string): RtpStreamingControlCommand {
  const map = decode(Buffer.from(base64, 'base64'))
  const command = required(map, ControlTlv.COMMAND, 'the command').readUInt8(0)
  if (command !== RtpStreamingCommand.START && command !== RtpStreamingCommand.END) {
    // 0 and 3-255 are "Reserved for use by Apple". A value we do not know is
    // not a value to guess at: acting on it would start or stop a stream on a
    // coin toss.
    throw new Error(`rtp-streaming-control: command ${command} is reserved or unknown`)
  }
  return {
    sessionId: uuid.unparse(required(map, ControlTlv.SESSION_IDENTIFIER, 'the session identifier')),
    command,
    videoTier: optionalUint32(map, ControlTlv.VIDEO_TIER),
    videoSsrc: optionalUint32(map, ControlTlv.VIDEO_SSRC),
    audioTier: optionalUint32(map, ControlTlv.AUDIO_TIER),
    audioSsrc: optionalUint32(map, ControlTlv.AUDIO_SSRC),
  }
}

/**
 * The value the characteristic reads back with: the status of the last write.
 *
 * `sessionId` is null before any write has happened. The read still has to
 * answer — a characteristic that answers nothing is what put the kitchen camera
 * on "loading" — so it answers with a status and no session rather than with an
 * invented one.
 */
export function encodeRtpStreamingControlStatus(
  sessionId: string | null,
  status: RtpStreamingStatus,
): string {
  if (sessionId === null) {
    return encode(StatusTlv.STATUS, Buffer.from([status])).toString('base64')
  }
  return encode(
    StatusTlv.SESSION_IDENTIFIER,
    uuid.write(sessionId),
    StatusTlv.STATUS,
    Buffer.from([status]),
  ).toString('base64')
}
