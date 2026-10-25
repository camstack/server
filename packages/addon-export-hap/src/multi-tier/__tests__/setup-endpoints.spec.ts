/**
 * The `Setup Endpoints` exchange, on the new service.
 *
 * § 3.6 lists `Setup Endpoints` among the multi-tier service's required
 * characteristics and does not redefine it — it is R17's, byte for byte. So
 * the format here is not invented: it is transcribed from the one hap-nodejs
 * already speaks on the classic service, and these tests decode what we encode
 * with the SAME library so a transcription error cannot pass review by looking
 * plausible.
 *
 * Request (controller → accessory):
 *   1 session id (16-byte uuid) · 3 controller address · 4 video srtp · 5 audio srtp
 * Response (accessory → controller):
 *   1 session id · 2 status · 3 accessory address · 4 video srtp · 5 audio srtp
 *   · 6 video ssrc · 7 audio ssrc
 */
import { decode, encode, uuid } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'

import {
  decodeSetupEndpointsRequest,
  encodeSetupEndpointsRefusal,
  encodeSetupEndpointsResponse,
  SetupEndpointsStatus,
} from '../setup-endpoints.js'
import { field } from './tlv-assert.js'

const SESSION = 'a1b2c3d4-e5f6-4788-9900-aabbccddeeff'
const KEY = Buffer.alloc(16, 7)
const SALT = Buffer.alloc(14, 9)

function uint16(value: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(value, 0)
  return b
}

/** A request shaped exactly as hap-nodejs writes one on the classic service. */
function controllerRequest(): string {
  return encode(
    1,
    uuid.write(SESSION),
    3,
    encode(
      1,
      Buffer.from([0]),
      2,
      Buffer.from('192.168.10.50', 'utf8'),
      3,
      uint16(51000),
      4,
      uint16(51002),
    ),
    4,
    encode(1, Buffer.from([0]), 2, KEY, 3, SALT),
    5,
    encode(1, Buffer.from([0]), 2, KEY, 3, SALT),
  ).toString('base64')
}

describe('decodeSetupEndpointsRequest', () => {
  it('reads the session, the controller endpoint and both srtp parameter sets', () => {
    const request = decodeSetupEndpointsRequest(controllerRequest())
    expect(request.sessionId).toBe(SESSION)
    expect(request.addressVersion).toBe('ipv4')
    expect(request.controllerAddress).toBe('192.168.10.50')
    expect(request.videoPort).toBe(51000)
    expect(request.audioPort).toBe(51002)
    expect(request.videoSrtp.key).toEqual(KEY)
    expect(request.videoSrtp.salt).toEqual(SALT)
    expect(request.audioSrtp.key).toEqual(KEY)
  })

  it('reads an ipv6 request as ipv6', () => {
    const request = decodeSetupEndpointsRequest(
      encode(
        1,
        uuid.write(SESSION),
        3,
        encode(1, Buffer.from([1]), 2, Buffer.from('fe80::1', 'utf8'), 3, uint16(1), 4, uint16(2)),
        4,
        encode(1, Buffer.from([0]), 2, KEY, 3, SALT),
        5,
        encode(1, Buffer.from([0]), 2, KEY, 3, SALT),
      ).toString('base64'),
    )
    expect(request.addressVersion).toBe('ipv6')
  })

  /**
   * A controller's bytes really can be short. Naming the missing field beats
   * a TypeError three frames away, because the refusal we send back has to say
   * something and "undefined is not an object" is not a status.
   */
  it('names the field that is missing rather than throwing on undefined', () => {
    expect(() =>
      decodeSetupEndpointsRequest(encode(1, uuid.write(SESSION)).toString('base64')),
    ).toThrow(/controller address/i)
  })
})

describe('encodeSetupEndpointsResponse', () => {
  it('echoes the session and reports success with both ssrcs', () => {
    const response = decode(
      Buffer.from(
        encodeSetupEndpointsResponse({
          sessionId: SESSION,
          addressVersion: 'ipv4',
          accessoryAddress: '192.168.10.9',
          videoPort: 60000,
          audioPort: 60002,
          videoSrtp: { key: KEY, salt: SALT },
          audioSrtp: { key: KEY, salt: SALT },
          videoSsrc: 0x11223344,
          audioSsrc: 0x55667788,
        }),
        'base64',
      ),
    )
    expect(uuid.unparse(field(response, 1))).toBe(SESSION)
    expect(field(response, 2).readUInt8(0)).toBe(SetupEndpointsStatus.SUCCESS)
    expect(field(response, 6).readUInt32LE(0)).toBe(0x11223344)
    expect(field(response, 7).readUInt32LE(0)).toBe(0x55667788)

    const address = decode(field(response, 3))
    expect(field(address, 1).readUInt8(0)).toBe(0)
    expect(field(address, 2).toString('utf8')).toBe('192.168.10.9')
    expect(field(address, 3).readUInt16LE(0)).toBe(60000)
    expect(field(address, 4).readUInt16LE(0)).toBe(60002)

    const videoSrtp = decode(field(response, 4))
    expect(field(videoSrtp, 2)).toEqual(KEY)
    expect(field(videoSrtp, 3)).toEqual(SALT)
  })
})

describe('encodeSetupEndpointsRefusal', () => {
  /**
   * The library's own refusal carries STATUS and nothing else — not even the
   * session id. Matching it exactly matters: this is the value the
   * characteristic reads back with, and a controller that cannot parse it
   * learns nothing about why it was refused.
   */
  it('is a status and nothing else, as the classic service writes it', () => {
    const refusal = decode(
      Buffer.from(encodeSetupEndpointsRefusal(SetupEndpointsStatus.ERROR), 'base64'),
    )
    expect(Object.keys(refusal)).toEqual(['2'])
    expect(field(refusal, 2).readUInt8(0)).toBe(2)
  })

  it('can say BUSY, which is a different thing from broken', () => {
    const refusal = decode(
      Buffer.from(encodeSetupEndpointsRefusal(SetupEndpointsStatus.BUSY), 'base64'),
    )
    expect(field(refusal, 2).readUInt8(0)).toBe(1)
  })
})
