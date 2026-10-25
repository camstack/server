/**
 * The WebRTC signalling characteristics of HomeKit's new camera service —
 * SDP and ICE, carried over HAP TLV8 instead of a websocket.
 *
 * ## Why WebRTC and not the multi-tier RTP service
 *
 * Both are defined by Apple's *HomeKit Secure Video Open Source Compatibility
 * Guide* (Developer Preview, 2026-06-03) and both reach HEVC and 4K. We take
 * the WebRTC one (`camera-webrtc-stream-management`, 0x8033) because the media
 * half is the half we already have: this hub's live plane IS WebRTC, and it
 * carries H.265 today. On the RTP service we would be writing HEVC
 * packetisation, tier-driven encoder management and SRTP from scratch.
 *
 * So the work is a SIGNALLING BRIDGE, and that is all this file is.
 *
 * ## The flow, and who offers
 *
 * The ACCESSORY is the offerer, which is the opposite of most integrations:
 *
 *   controller → `webrtc-solicit-offer`  { options }
 *   accessory  ← response                { sessionId, SDP offer, candidates }
 *   controller → `webrtc-provide-answer` { sessionId, SDP answer, candidates }
 *   controller → `webrtc-update-session` { sessionId, SDP offer, options }  (renegotiation)
 *
 * Nothing in the specification mentions DTLS, SRTP, STUN or TURN: candidates
 * are RFC 8825 strings and the SDP is RFC 8866. It is ordinary WebRTC with a
 * HAP transport for the handshake.
 *
 * ## SFrame
 *
 * The controller may REQUEST end-to-end media encryption per session
 * (`sframeEnabled` in the options). We do not implement SFrame, so this module
 * models it honestly — the flag is parsed and carried, never silently dropped
 * — and the caller decides what to answer. A request we cannot honour has to be
 * a visible refusal, not a session that comes up unencrypted while the
 * controller believes otherwise.
 *
 * Pure codec. No accessory, no session, no I/O.
 */
import { decode, decodeWithLists, encode } from '@homebridge/hap-nodejs'

/** Status of a signalling command. */
export enum WebRtcCommandStatus {
  SUCCESS = 0,
  PRIVACY_MODE_ACTIVE = 1,
  ERROR = 2,
}

/** One ICE candidate, as the controller and the accessory exchange it. */
export interface WebRtcIceCandidate {
  /** An RFC 8825-compliant ICE candidate. */
  readonly candidate: string
  /** The media stream id the candidate belongs to; absent when it has none. */
  readonly sdpMid?: string
}

/** An SFrame key, for the session key material TLV. */
export interface SFrameKeyData {
  readonly key: Buffer
  /** SFrame Key ID — `uint64`, so it is carried as a bigint. */
  readonly kid: bigint
}

/** What the controller asks for when it solicits an offer. */
export interface WebRtcOfferOptions {
  /** The controller is requesting end-to-end media encryption. */
  readonly sframeEnabled: boolean
}

/** The accessory's reply to a solicitation. */
export interface WebRtcOffer {
  readonly sessionId: Buffer
  /** RFC 8866 SDP offer. */
  readonly sdpOffer: string
  readonly candidates: readonly WebRtcIceCandidate[]
  readonly status: WebRtcCommandStatus
  readonly sframe?: SFrameKeyData
}

/** What the controller writes back. */
export interface WebRtcAnswer {
  readonly sessionId: Buffer
  /** RFC 8866 SDP answer. */
  readonly sdpAnswer: string
  readonly candidates: readonly WebRtcIceCandidate[]
}

enum OfferOptionsTlv {
  SFRAME_ENABLED = 0x01,
}

enum SolicitTlv {
  OPTIONS = 0x01,
}

enum OfferTlv {
  SESSION_ID = 0x01,
  SDP_OFFER = 0x02,
  ADDITIONAL_CANDIDATES = 0x03,
  STATUS = 0x04,
  SFRAME_CONFIGURATION = 0x05,
}

enum AnswerTlv {
  SESSION_ID = 0x01,
  SDP_ANSWER = 0x02,
  ADDITIONAL_CANDIDATES = 0x03,
}

enum CandidateTlv {
  CANDIDATE = 0x01,
  SDP_MID = 0x02,
}

enum SFrameKeyTlv {
  KEY = 0x01,
  KID = 0x02,
}

function uint8(value: number): Buffer {
  const b = Buffer.alloc(1)
  b.writeUInt8(value, 0)
  return b
}

function uint64(value: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(value, 0)
  return b
}

/** A TLV that may be a single buffer or a repeated list — always as a list. */
function asList(value: Buffer | Buffer[] | undefined): readonly Buffer[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

export function encodeIceCandidate(c: WebRtcIceCandidate): Buffer {
  // `sdpMid` is OMITTED when there is none rather than sent empty: the
  // specification says the association may not exist, and an empty string is a
  // mid of length zero, which is a different claim.
  return c.sdpMid === undefined
    ? encode(CandidateTlv.CANDIDATE, Buffer.from(c.candidate, 'utf8'))
    : encode(
        CandidateTlv.CANDIDATE,
        Buffer.from(c.candidate, 'utf8'),
        CandidateTlv.SDP_MID,
        Buffer.from(c.sdpMid, 'utf8'),
      )
}

export function decodeIceCandidate(buf: Buffer): WebRtcIceCandidate {
  const t = decode(buf)
  const candidate = t[CandidateTlv.CANDIDATE]?.toString('utf8') ?? ''
  const mid = t[CandidateTlv.SDP_MID]
  return mid === undefined ? { candidate } : { candidate, sdpMid: mid.toString('utf8') }
}

/** Parse what the controller wrote to `webrtc-solicit-offer`. */
export function decodeSolicitOffer(buf: Buffer): WebRtcOfferOptions {
  const outer = decode(buf)
  const options = outer[SolicitTlv.OPTIONS]
  if (options === undefined) return { sframeEnabled: false }
  const inner = decode(options)
  // A byte that is present and zero is a controller saying NO. Absent is a
  // controller that did not ask. Both are `false` here, and neither is a
  // reason to turn encryption on.
  return { sframeEnabled: (inner[OfferOptionsTlv.SFRAME_ENABLED]?.readUInt8(0) ?? 0) === 1 }
}

/** The accessory's response to a solicitation. */
export function encodeOffer(offer: WebRtcOffer): Buffer {
  const parts: [number, Buffer | Buffer[]][] = [
    [OfferTlv.SESSION_ID, offer.sessionId],
    [OfferTlv.SDP_OFFER, Buffer.from(offer.sdpOffer, 'utf8')],
    [OfferTlv.ADDITIONAL_CANDIDATES, offer.candidates.map(encodeIceCandidate)],
    [OfferTlv.STATUS, uint8(offer.status)],
  ]
  if (offer.sframe !== undefined) {
    parts.push([
      OfferTlv.SFRAME_CONFIGURATION,
      encode(SFrameKeyTlv.KEY, offer.sframe.key, SFrameKeyTlv.KID, uint64(offer.sframe.kid)),
    ])
  }
  return encode(...(parts.flat() as [number, Buffer | Buffer[], ...unknown[]]))
}

/** Parse what the controller wrote to `webrtc-provide-answer`. */
export function decodeAnswer(buf: Buffer): WebRtcAnswer {
  const t = decodeWithLists(buf)
  const sessionId = t[AnswerTlv.SESSION_ID]
  const sdp = t[AnswerTlv.SDP_ANSWER]
  return {
    sessionId: Array.isArray(sessionId)
      ? (sessionId[0] ?? Buffer.alloc(0))
      : (sessionId ?? Buffer.alloc(0)),
    sdpAnswer: (Array.isArray(sdp) ? sdp[0] : sdp)?.toString('utf8') ?? '',
    candidates: asList(t[AnswerTlv.ADDITIONAL_CANDIDATES]).map(decodeIceCandidate),
  }
}
