/**
 * The adapter between Apple's new characteristics and the streaming engine
 * this addon already has.
 *
 * It exists because the two halves are both real and neither is negotiable:
 * the new service owns its OWN `Setup Endpoints` and `RTP Streaming Control`,
 * so the classic `CameraController` never negotiates for it — while the
 * sockets, SRTP contexts, ffmpeg pipeline and teardown are the same ones, and
 * a second copy would be two engines to keep in agreement. hap-nodejs's own
 * handlers are all `private`, so the library's engine cannot be borrowed.
 *
 * What is worth testing here is the MAPPING, not the bytes (the codecs have
 * their own specs):
 *
 *  - a tier identifier resolves to the tier we actually published, and one we
 *    never published is `No Such Stream` rather than something improvised
 *  - a refused or failed prepare answers with a status, never with silence
 *  - an End for a session that was never prepared says so
 */
import { encode, uuid } from '@homebridge/hap-nodejs'
import { describe, expect, it, vi } from 'vitest'

import { buildMultiTierNegotiation } from '../negotiation.js'
import { RtpStreamingCommand, RtpStreamingStatus } from '../rtp-streaming-control.js'
import { SetupEndpointsStatus } from '../setup-endpoints.js'
import { tiersForSensor } from '../tiers-for-sensor.js'
import { TierVideoCodec } from '../video-stream-tiers.js'
import { decode } from '@homebridge/hap-nodejs'
import { field } from './tlv-assert.js'

const SESSION = 'a1b2c3d4-e5f6-4788-9900-aabbccddeeff'
const KEY = Buffer.alloc(16, 7)
const SALT = Buffer.alloc(14, 9)

function uint16(value: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(value, 0)
  return b
}

function uint32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value, 0)
  return b
}

function setupWrite(): string {
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

function controlWrite(command: RtpStreamingCommand, videoTier?: number): string {
  if (command === RtpStreamingCommand.END) {
    return encode(1, uuid.write(SESSION), 2, Buffer.from([command])).toString('base64')
  }
  return encode(
    1,
    uuid.write(SESSION),
    2,
    Buffer.from([command]),
    3,
    uint32(videoTier ?? 1),
    4,
    uint32(0xdeadbeef),
    5,
    uint32(1),
    6,
    uint32(0x0badcafe),
  ).toString('base64')
}

function fakeNegotiator(overrides: Record<string, unknown> = {}) {
  const prepared = new Set<string>()
  return {
    prepare: vi.fn(async (request: { sessionID: string }) => {
      prepared.add(request.sessionID)
      return {
        localAddress: '192.168.10.9',
        videoPort: 60000,
        audioPort: 60002,
        videoSsrc: 0x11223344,
        audioSsrc: 0x55667788,
      }
    }),
    control: vi.fn(async (_request: unknown) => undefined),
    has: (id: string) => prepared.has(id),
    ...overrides,
  }
}

function build(negotiator = fakeNegotiator()) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withTags: () => logger,
  }
  const negotiation = buildMultiTierNegotiation({
    deviceId: 112,
    logger: logger as never,
    negotiator: negotiator as never,
    tiers: tiersForSensor(3840, 2160),
    codec: TierVideoCodec.H265,
  })
  return { negotiation, negotiator, logger }
}

describe('setup endpoints', () => {
  it('drives the engine with the controller’s endpoint and srtp material', async () => {
    const { negotiation, negotiator } = build()
    await negotiation.handleSetupEndpointsWrite(setupWrite())

    const request = negotiator.prepare.mock.calls[0]?.[0] as never as {
      sessionID: string
      targetAddress: string
      video: { port: number; srtp_key: Buffer }
      audio: { port: number }
    }
    expect(request.sessionID).toBe(SESSION)
    expect(request.targetAddress).toBe('192.168.10.50')
    expect(request.video.port).toBe(51000)
    expect(request.audio.port).toBe(51002)
    expect(request.video.srtp_key).toEqual(KEY)
  })

  it('reports the address the sockets were really bound to', async () => {
    const { negotiation } = build()
    await negotiation.handleSetupEndpointsWrite(setupWrite())
    const response = decode(Buffer.from(negotiation.readSetupEndpoints(), 'base64'))
    expect(field(response, 2).readUInt8(0)).toBe(SetupEndpointsStatus.SUCCESS)
    const address = decode(field(response, 3))
    expect(field(address, 2).toString('utf8')).toBe('192.168.10.9')
    expect(field(address, 3).readUInt16LE(0)).toBe(60000)
  })

  /**
   * The engine can fail for reasons the controller cannot see — no free
   * socket, a refused SRTP suite. A read that answered nothing would take the
   * whole characteristic batch down; an error status is a camera that is not
   * streaming.
   */
  it('answers with an error status when the engine refuses', async () => {
    const { negotiation } = build(
      fakeNegotiator({
        prepare: vi.fn(async () => {
          throw new Error('no socket')
        }),
      }),
    )
    await negotiation.handleSetupEndpointsWrite(setupWrite())
    const response = decode(Buffer.from(negotiation.readSetupEndpoints(), 'base64'))
    expect(field(response, 2).readUInt8(0)).toBe(SetupEndpointsStatus.ERROR)
  })

  it('answers before any write at all', () => {
    const { negotiation } = build()
    const response = decode(Buffer.from(negotiation.readSetupEndpoints(), 'base64'))
    expect(field(response, 2).readUInt8(0)).toBe(SetupEndpointsStatus.ERROR)
  })
})

describe('rtp streaming control', () => {
  it('starts the tier the controller named, with that tier’s geometry', async () => {
    const { negotiation, negotiator } = build()
    await negotiation.handleSetupEndpointsWrite(setupWrite())
    // Tier 2 of a 4K sensor is the 1080p medium.
    await negotiation.handleStreamingControlWrite(controlWrite(RtpStreamingCommand.START, 2))

    const request = negotiator.control.mock.calls[0]?.[0] as never as {
      type: string
      video: { width: number; height: number; fps: number; max_bit_rate: number }
    }
    expect(request.type).toBe('start')
    expect(request.video.width).toBe(1920)
    expect(request.video.height).toBe(1080)
    expect(request.video.fps).toBe(30)
    expect(request.video.max_bit_rate).toBe(1700)
  })

  /**
   * A tier identifier we never published is the one case where improvising
   * would be worst: we would serve a geometry the controller did not ask for
   * and it would look like a working stream.
   */
  it('refuses a tier it never published, by name', async () => {
    const { negotiation, negotiator } = build()
    await negotiation.handleSetupEndpointsWrite(setupWrite())
    await negotiation.handleStreamingControlWrite(controlWrite(RtpStreamingCommand.START, 99))
    expect(negotiator.control).not.toHaveBeenCalled()
    const read = decode(Buffer.from(negotiation.readStreamingControl(), 'base64'))
    expect(field(read, 2).readUInt8(0)).toBe(RtpStreamingStatus.NO_SUCH_STREAM)
  })

  it('refuses a start for a session that was never prepared', async () => {
    const { negotiation, negotiator } = build()
    await negotiation.handleStreamingControlWrite(controlWrite(RtpStreamingCommand.START, 1))
    expect(negotiator.control).not.toHaveBeenCalled()
    const read = decode(Buffer.from(negotiation.readStreamingControl(), 'base64'))
    expect(field(read, 2).readUInt8(0)).toBe(RtpStreamingStatus.UNKNOWN_SESSION_IDENTIFIER)
  })

  it('stops a started stream and reports success', async () => {
    const { negotiation, negotiator } = build()
    await negotiation.handleSetupEndpointsWrite(setupWrite())
    await negotiation.handleStreamingControlWrite(controlWrite(RtpStreamingCommand.START, 1))
    await negotiation.handleStreamingControlWrite(controlWrite(RtpStreamingCommand.END))

    const stop = negotiator.control.mock.calls[1]?.[0] as never as { type: string }
    expect(stop.type).toBe('stop')
    const read = decode(Buffer.from(negotiation.readStreamingControl(), 'base64'))
    expect(field(read, 2).readUInt8(0)).toBe(RtpStreamingStatus.SUCCESS)
  })

  /**
   * § 4.16: *"No Such Stream indicates that an End command was attempted for a
   * stream that is not currently started."*
   */
  it('answers No Such Stream to an End for a stream that never started', async () => {
    const { negotiation } = build()
    await negotiation.handleSetupEndpointsWrite(setupWrite())
    await negotiation.handleStreamingControlWrite(controlWrite(RtpStreamingCommand.END))
    const read = decode(Buffer.from(negotiation.readStreamingControl(), 'base64'))
    expect(field(read, 2).readUInt8(0)).toBe(RtpStreamingStatus.NO_SUCH_STREAM)
  })

  /**
   * The specification has the controller name SSRCs in the Start, while the
   * Setup Endpoints response has the accessory name its own. We keep ours --
   * overriding them mid-stream on an ambiguous reading is riskier than saying
   * so -- and the log is what will settle the reading the first time a real
   * controller disagrees.
   */
  it('logs when the controller names an ssrc different from ours', async () => {
    const { negotiation, logger } = build()
    await negotiation.handleSetupEndpointsWrite(setupWrite())
    await negotiation.handleStreamingControlWrite(controlWrite(RtpStreamingCommand.START, 1))
    const logged = logger.info.mock.calls.map((c) => String(c[0]))
    expect(logged.some((m) => /ssrc/i.test(m))).toBe(true)
  })

  it('answers a malformed write with an error rather than throwing', async () => {
    const { negotiation } = build()
    await expect(negotiation.handleStreamingControlWrite('not base64 tlv')).resolves.toBeUndefined()
    const read = decode(Buffer.from(negotiation.readStreamingControl(), 'base64'))
    expect(field(read, 2).readUInt8(0)).toBe(RtpStreamingStatus.ERROR)
  })
})
