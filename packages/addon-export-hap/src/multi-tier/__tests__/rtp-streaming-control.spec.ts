/**
 * `RTP Streaming Control` (0x8045) — the characteristic that starts and stops a
 * stream on the new service, replacing the classic `Selected RTP Stream
 * Configuration`.
 *
 * The two are not variations of each other. The classic one carries the whole
 * selected video and audio configuration — codec, profile, level, resolution,
 * bitrate — inside the start. This one carries a TIER IDENTIFIER: the
 * configuration was already agreed when we published `Supported Video Stream
 * Tiers`, and the controller now names one of those entries. That is the shape
 * of the new service, and it is why the adapter has to map an identifier back
 * to the tier we advertised rather than read parameters off the write.
 *
 * Restated from § 4.16:
 *
 *   write := { 1 session id, 2 command (1 End / 2 Start), 3 video tier,
 *              4 video ssrc, 5 audio tier, 6 audio ssrc }
 *   read  := { 1 session id, 2 status (0 Success, 1 Unknown Session,
 *              2 No Such Stream, 3 Busy, 4 Error) }
 */
import { decode, encode, uuid } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'

import {
  decodeRtpStreamingControl,
  encodeRtpStreamingControlStatus,
  RtpStreamingCommand,
  RtpStreamingStatus,
} from '../rtp-streaming-control.js'
import { field } from './tlv-assert.js'

const SESSION = 'a1b2c3d4-e5f6-4788-9900-aabbccddeeff'

function uint32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value, 0)
  return b
}

describe('decodeRtpStreamingControl', () => {
  it('reads a start with both tiers and both ssrcs', () => {
    const command = decodeRtpStreamingControl(
      encode(
        1,
        uuid.write(SESSION),
        2,
        Buffer.from([RtpStreamingCommand.START]),
        3,
        uint32(1),
        4,
        uint32(0xdeadbeef),
        5,
        uint32(1),
        6,
        uint32(0x0badcafe),
      ).toString('base64'),
    )
    expect(command.sessionId).toBe(SESSION)
    expect(command.command).toBe(RtpStreamingCommand.START)
    expect(command.videoTier).toBe(1)
    expect(command.videoSsrc).toBe(0xdeadbeef)
    expect(command.audioTier).toBe(1)
    expect(command.audioSsrc).toBe(0x0badcafe)
  })

  /**
   * § 4.16 marks the tier and ssrc fields "Only present when Command is Start".
   * An End that carried them would be malformed; an End we refuse to parse
   * because they are absent would leave a session running forever.
   */
  it('reads an end that carries nothing but the session and the command', () => {
    const command = decodeRtpStreamingControl(
      encode(1, uuid.write(SESSION), 2, Buffer.from([RtpStreamingCommand.END])).toString('base64'),
    )
    expect(command.command).toBe(RtpStreamingCommand.END)
    expect(command.videoTier).toBeUndefined()
    expect(command.videoSsrc).toBeUndefined()
  })

  it('names the missing field rather than throwing on undefined', () => {
    expect(() =>
      decodeRtpStreamingControl(encode(1, uuid.write(SESSION)).toString('base64')),
    ).toThrow(/command/i)
  })

  /** A value this revision reserves is not a command we may guess at. */
  it('refuses a reserved command value', () => {
    expect(() =>
      decodeRtpStreamingControl(
        encode(1, uuid.write(SESSION), 2, Buffer.from([7])).toString('base64'),
      ),
    ).toThrow(/reserved|unknown/i)
  })
})

describe('encodeRtpStreamingControlStatus', () => {
  it('echoes the session so a refusal can be attributed to one', () => {
    const read = decode(
      Buffer.from(encodeRtpStreamingControlStatus(SESSION, RtpStreamingStatus.SUCCESS), 'base64'),
    )
    expect(uuid.unparse(field(read, 1))).toBe(SESSION)
    expect(field(read, 2).readUInt8(0)).toBe(0)
  })

  it.each([
    [RtpStreamingStatus.UNKNOWN_SESSION_IDENTIFIER, 1],
    [RtpStreamingStatus.NO_SUCH_STREAM, 2],
    [RtpStreamingStatus.BUSY, 3],
    [RtpStreamingStatus.ERROR, 4],
  ])('carries status %i as the guide numbers it', (status, wire) => {
    const read = decode(Buffer.from(encodeRtpStreamingControlStatus(SESSION, status), 'base64'))
    expect(field(read, 2).readUInt8(0)).toBe(wire)
  })

  /**
   * Before any write there is no session to name. The read still has to answer
   * with something valid — an empty string is what put the kitchen camera on
   * "loading".
   */
  it('answers before any write without inventing a session', () => {
    const read = decode(
      Buffer.from(encodeRtpStreamingControlStatus(null, RtpStreamingStatus.ERROR), 'base64'),
    )
    expect(Object.keys(read)).toEqual(['2'])
    expect(field(read, 2).readUInt8(0)).toBe(4)
  })
})
