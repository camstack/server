/**
 * The WebRTC signalling TLVs — round-tripped, never compared to byte fixtures.
 *
 * Every rule here is one a controller can catch us on: a candidate list that is
 * not repeated, an SFrame request we answer as if it had not been made, a
 * session id truncated by a list decode.
 */
import { decode, decodeWithLists, encode } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'

import {
  decodeAnswer,
  decodeIceCandidate,
  decodeSolicitOffer,
  encodeIceCandidate,
  encodeOffer,
  WebRtcCommandStatus,
} from '../webrtc-signalling.js'

const CANDIDATE = 'candidate:1 1 UDP 2130706431 192.168.10.9 54321 typ host'
const SDP_OFFER = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'

/** Builds the CONTROLLER's side of each exchange by hand, so the encoder under
 *  test is never the thing answering itself. */
function tlv(type: number, data: Buffer | Buffer[], ...rest: unknown[]): Buffer {
  return encode(type, data, ...rest)
}

describe('solicit-offer, as the controller writes it', () => {
  it('reads an explicit SFrame request', () => {
    const one = Buffer.alloc(1)
    one.writeUInt8(1, 0)
    expect(decodeSolicitOffer(tlv(0x01, tlv(0x01, one))).sframeEnabled).toBe(true)
  })

  it('treats a PRESENT-and-zero flag as a no', () => {
    const zero = Buffer.alloc(1)
    expect(decodeSolicitOffer(tlv(0x01, tlv(0x01, zero))).sframeEnabled).toBe(false)
  })

  it('treats an ABSENT flag as a no, never as a default-on', () => {
    // Turning end-to-end encryption on because nobody asked would be the one
    // direction that cannot be recovered from: the controller would receive
    // frames it cannot decrypt.
    expect(decodeSolicitOffer(Buffer.alloc(0)).sframeEnabled).toBe(false)
  })
})

describe('the offer the accessory answers with', () => {
  const sessionId = Buffer.from('0123456789abcdef', 'utf8')

  it('carries the session, the SDP and the status', () => {
    const t = decode(
      encodeOffer({
        sessionId,
        sdpOffer: SDP_OFFER,
        candidates: [],
        status: WebRtcCommandStatus.SUCCESS,
      }),
    )
    expect(t[0x01]?.equals(sessionId)).toBe(true)
    expect(t[0x02]?.toString('utf8')).toBe(SDP_OFFER)
    expect(t[0x04]?.readUInt8(0)).toBe(0)
  })

  it('emits the candidates REPEATED — one TLV each', () => {
    const lists = decodeWithLists(
      encodeOffer({
        sessionId,
        sdpOffer: SDP_OFFER,
        candidates: [
          { candidate: CANDIDATE, sdpMid: '0' },
          { candidate: CANDIDATE, sdpMid: '1' },
        ],
        status: WebRtcCommandStatus.SUCCESS,
      }),
    )
    expect((lists[0x03] as Buffer[]).length).toBe(2)
  })

  it('can refuse with a reason instead of an offer', () => {
    // Privacy mode is a real answer, not an error: the camera is working and
    // the operator has said no. A status nobody sets would make that
    // indistinguishable from a broken accessory.
    const t = decode(
      encodeOffer({
        sessionId,
        sdpOffer: '',
        candidates: [],
        status: WebRtcCommandStatus.PRIVACY_MODE_ACTIVE,
      }),
    )
    expect(t[0x04]?.readUInt8(0)).toBe(1)
  })

  it('omits the SFrame configuration when we are not doing SFrame', () => {
    // Not an empty one. An empty key blob is a key of length zero, which is a
    // claim; absence is the truth.
    const t = decode(
      encodeOffer({
        sessionId,
        sdpOffer: SDP_OFFER,
        candidates: [],
        status: WebRtcCommandStatus.SUCCESS,
      }),
    )
    expect(t[0x05]).toBeUndefined()
  })
})

describe('the answer the controller writes back', () => {
  it('round-trips the session, the SDP and every candidate', () => {
    const sessionId = Buffer.from('fedcba9876543210', 'utf8')
    const body = tlv(0x01, sessionId, 0x02, Buffer.from('v=0\r\n', 'utf8'), 0x03, [
      encodeIceCandidate({ candidate: CANDIDATE, sdpMid: '0' }),
      encodeIceCandidate({ candidate: CANDIDATE }),
    ])
    const answer = decodeAnswer(body)
    expect(answer.sessionId.equals(sessionId)).toBe(true)
    expect(answer.sdpAnswer).toBe('v=0\r\n')
    expect(answer.candidates).toHaveLength(2)
    expect(answer.candidates[0]?.sdpMid).toBe('0')
  })

  it('keeps a single candidate a list of one', () => {
    // HAP does not distinguish "one" from "not a list", and a decoder that
    // does would lose the only candidate a host-only camera ever sends.
    const body = tlv(
      0x01,
      Buffer.from('s'),
      0x02,
      Buffer.from('v=0'),
      0x03,
      encodeIceCandidate({ candidate: CANDIDATE }),
    )
    expect(decodeAnswer(body).candidates).toHaveLength(1)
  })

  it('survives an answer with no candidates at all', () => {
    const body = tlv(0x01, Buffer.from('s'), 0x02, Buffer.from('v=0'))
    expect(decodeAnswer(body).candidates).toEqual([])
  })
})

describe('an ICE candidate', () => {
  it('round-trips with its mid', () => {
    expect(decodeIceCandidate(encodeIceCandidate({ candidate: CANDIDATE, sdpMid: '0' }))).toEqual({
      candidate: CANDIDATE,
      sdpMid: '0',
    })
  })

  it('OMITS the mid when there is none, rather than sending an empty one', () => {
    const c = decodeIceCandidate(encodeIceCandidate({ candidate: CANDIDATE }))
    expect(c.sdpMid).toBeUndefined()
    expect('sdpMid' in c).toBe(false)
  })
})
