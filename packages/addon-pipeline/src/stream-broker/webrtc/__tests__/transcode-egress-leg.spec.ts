/**
 * The browser WebRTC transcode leg, on THE ffmpeg primitive (D67).
 *
 * The leg used to build its own invocation and spawn its own ffmpeg. What it
 * lost by doing that is what these tests now pin down:
 *
 *  - **the manager's smart copy-vs-encode decision** — the leg never asked it,
 *    so it re-encoded unconditionally;
 *  - **the hardware→software retry** — the leg had one of its own, spelled
 *    differently, on a different trigger;
 *  - **refcounted dedup** — two browsers watching the same camera at the same
 *    tier ran two encoders;
 *  - **honest `decodeHwAccel` reporting** — the leg reported what it ASKED for.
 *
 * The two properties that are load-bearing and easy to lose again:
 *
 *  1. **The sharing key must not carry the session.** `tag` is attribution and
 *     is excluded from the key on purpose; if it ever leaks in, every browser
 *     gets its own encoder and the dedup below silently stops happening.
 *  2. **A ladder rung change is a NEW handle, never a mutation** (D67: there is
 *     no `reconfigure`). The transcode-down profile must therefore hash to a
 *     DIFFERENT key than the rung above it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CameraStream, EncodedPacket, EncodeProfile, IScopedLogger } from '@camstack/types'
import { egressTranscodeSharingKey } from '@camstack/types'

import { buildTranscodeEgressRequest, H264EgressFramer } from '../transcode-egress-leg.js'
import { WEBRTC_FALLBACK_PROFILE } from '../webrtc-fallback-profile.js'
import { reduceProfileForTranscodeDown } from '../broker-webrtc-server.js'
import {
  type EgressChild,
  EgressTranscodeManager,
  type EgressTranscodeManagerOptions,
} from '../../stream-broker/egress-transcode-manager.js'

const DEVICE_ID = 101
const CAM_STREAM_ID = 'native:main'

function annexB(...nals: readonly Buffer[]): Buffer {
  const sc = Buffer.from([0x00, 0x00, 0x00, 0x01])
  return Buffer.concat(nals.flatMap((n) => [sc, n]))
}

const SPS = Buffer.from([0x67, 0x42, 0xe0, 0x1f, 0x11])
const PPS = Buffer.from([0x68, 0xce, 0x3c, 0x80])
const IDR = Buffer.from([0x65, 0x88, 0x84, 0x00])
const SLICE = Buffer.from([0x41, 0x9a, 0x00, 0x01])
const SEI = Buffer.from([0x06, 0x05, 0x01, 0x00])
const AUD = Buffer.from([0x09, 0x10])

function videoPacket(data: Buffer, over: Partial<EncodedPacket> = {}): EncodedPacket {
  return { type: 'video', data, pts: 0, dts: 0, keyframe: false, codec: 'h264', ...over }
}

describe('buildTranscodeEgressRequest — the browser leg asks the primitive', () => {
  const request = buildTranscodeEgressRequest({
    deviceId: DEVICE_ID,
    camStreamId: CAM_STREAM_ID,
    profile: WEBRTC_FALLBACK_PROFILE,
    sessionId: 'session-a',
  })

  it('asks for the LOCAL push transport — the one with live hours behind it', () => {
    // Dialling the url makes the acquired stream an RTP source and routes the
    // session down the RTP-passthrough + repacketizer branch. That is the
    // measured black screen (Alexa, 2026-08-07); push/deframe renders.
    expect(request.publishLocally).toBe(true)
  })

  it('reads the SOURCE cam stream this session is already bound to', () => {
    expect(request.source).toEqual({ kind: 'cam-stream', camStreamId: CAM_STREAM_ID })
    expect(request.deviceId).toBe(DEVICE_ID)
  })

  it('requests NO audio plane — the browser gets audio out-of-band via werift', () => {
    // An in-band plane here would be encoded and then dropped: the session's
    // audio comes from its own source loop, not from the egress.
    expect(request.encode.audio).toBe('passthrough')
  })

  it('drops an audio encode the profile happened to carry', () => {
    const withAudio: EncodeProfile = { ...WEBRTC_FALLBACK_PROFILE, audio: { codec: 'opus' } }
    const req = buildTranscodeEgressRequest({
      deviceId: DEVICE_ID,
      camStreamId: CAM_STREAM_ID,
      profile: withAudio,
      sessionId: 'session-a',
    })
    expect(req.encode.audio).toBe('passthrough')
  })

  it('lets a keyframe spike — a browser is not budget-enforced per second', () => {
    expect(request.rateControl).toBe('relaxed')
  })

  it('carries the session only as ATTRIBUTION', () => {
    expect(request.tag).toContain('session-a')
  })

  it('has no raw-flag escape hatch to fork the shared child with', () => {
    expect('inputArgs' in request.encode).toBe(false)
    expect('outputArgs' in request.encode).toBe(false)
  })

  it('gives two SESSIONS on the same camera and tier ONE sharing key', () => {
    const b = buildTranscodeEgressRequest({
      deviceId: DEVICE_ID,
      camStreamId: CAM_STREAM_ID,
      profile: WEBRTC_FALLBACK_PROFILE,
      sessionId: 'session-b',
    })
    expect(egressTranscodeSharingKey(b)).toBe(egressTranscodeSharingKey(request))
  })

  it('gives the transcode-down rung a DIFFERENT key — a rung change is a new handle', () => {
    const down = buildTranscodeEgressRequest({
      deviceId: DEVICE_ID,
      camStreamId: CAM_STREAM_ID,
      profile: reduceProfileForTranscodeDown(WEBRTC_FALLBACK_PROFILE),
      sessionId: 'session-a',
    })
    expect(egressTranscodeSharingKey(down)).not.toBe(egressTranscodeSharingKey(request))
  })

  it('gives two TIERS of the same camera different keys — the source is in the key', () => {
    const low = buildTranscodeEgressRequest({
      deviceId: DEVICE_ID,
      camStreamId: 'native:sub',
      profile: WEBRTC_FALLBACK_PROFILE,
      sessionId: 'session-a',
    })
    expect(egressTranscodeSharingKey(low)).not.toBe(egressTranscodeSharingKey(request))
  })
})

describe('H264EgressFramer — the access-unit shape the consumers already see', () => {
  it('withholds everything until the first keyframe', () => {
    const framer = new H264EgressFramer()
    expect(framer.accept(videoPacket(annexB(SLICE)))).toBeNull()
    expect(framer.accept(videoPacket(annexB(SPS, PPS, IDR)))).not.toBeNull()
  })

  it('keeps SPS/PPS/IDR in ONE access unit — Chrome cannot decode them split', () => {
    const framer = new H264EgressFramer()
    const out = framer.accept(videoPacket(annexB(SPS, PPS, IDR), { keyframe: true }))
    expect(out?.nals.map((n) => n[0]! & 0x1f)).toEqual([7, 8, 5])
    expect(out?.keyframe).toBe(true)
  })

  it('treats a bare SPS access unit as a keyframe — some cameras emit no IDR NAL', () => {
    const framer = new H264EgressFramer()
    // `isH264IdrAccessUnit` checks SPS as well as IDR; the framer must agree.
    expect(framer.accept(videoPacket(annexB(SPS, PPS, SLICE)))).not.toBeNull()
  })

  it('prepends the cached SPS/PPS to an IDR that ships without them', () => {
    const framer = new H264EgressFramer()
    framer.accept(videoPacket(annexB(SPS, PPS, IDR), { keyframe: true }))
    const out = framer.accept(videoPacket(annexB(IDR), { keyframe: true }))
    expect(out?.nals.map((n) => n[0]! & 0x1f)).toEqual([7, 8, 5])
  })

  it('drops AUD and SEI — neither belongs in RTP', () => {
    const framer = new H264EgressFramer()
    const out = framer.accept(videoPacket(annexB(AUD, SPS, PPS, SEI, IDR), { keyframe: true }))
    expect(out?.nals.map((n) => n[0]! & 0x1f)).toEqual([7, 8, 5])
  })

  it('IGNORES a placeholder packet — its parameter sets would poison the decoder', () => {
    const framer = new H264EgressFramer()
    expect(
      framer.accept(videoPacket(annexB(SPS, PPS, IDR), { keyframe: true, isPlaceholder: true })),
    ).toBeNull()
  })

  it('ignores audio packets — the egress video plane is the only thing it frames', () => {
    const framer = new H264EgressFramer()
    expect(framer.accept({ ...videoPacket(annexB(SPS, PPS, IDR)), type: 'audio' })).toBeNull()
  })
})

// ── The dedup the leg gains, against the REAL manager ────────────────────

function fakeLogger(): IScopedLogger {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
    withTags: () => log,
  }
  return log as unknown as IScopedLogger
}

const SOURCE_STREAM: CameraStream = {
  camStreamId: CAM_STREAM_ID,
  deviceId: DEVICE_ID,
  kind: 'rtsp',
  url: 'rtsp://cam/main',
  codec: 'h265',
  resolution: { width: 3840, height: 2160 },
} as unknown as CameraStream

function managerHarness(releaseGraceMs: number): {
  manager: EgressTranscodeManager
  children: { stopped: boolean }[]
} {
  const children: { stopped: boolean }[] = []
  const options: EgressTranscodeManagerOptions = {
    logger: fakeLogger(),
    cameraStreamLookup: () => [SOURCE_STREAM],
    resolveProfileSource: () => CAM_STREAM_ID,
    rtspEntryLookup: (brokerId) => ({ url: `rtsp://127.0.0.1:8554/tok-${brokerId}` }),
    ffmpegConfig: () => ({ binaryPath: 'ffmpeg', hwAccel: 'copy', threadCount: 0 }),
    resolveDecodeHwAccel: async () => 'vaapi',
    acquireChannel: (brokerId) => ({
      restreamer: { pushPacket: () => {} },
      consumerUrl: `rtsp://127.0.0.1:8554/egress-${brokerId}`,
      release: () => {},
    }),
    releaseGraceMs,
    publishPushStream: async () => ({
      push: () => {},
      audioInfo: () => {},
      videoCodec: () => {},
      release: async () => {},
    }),
    createChild: (spec): EgressChild => {
      const child = { stopped: false }
      children.push(child)
      return {
        start: async () => spec.consumerUrl,
        stop: async () => {
          child.stopped = true
        },
        decodeHwAccel: () => spec.invocation.decodeHwAccel,
      }
    },
  }
  return { manager: new EgressTranscodeManager(options), children }
}

describe('two browser viewers, same camera, same tier', () => {
  const request = (sessionId: string): ReturnType<typeof buildTranscodeEgressRequest> =>
    buildTranscodeEgressRequest({
      deviceId: DEVICE_ID,
      camStreamId: CAM_STREAM_ID,
      profile: WEBRTC_FALLBACK_PROFILE,
      sessionId,
    })

  it('share ONE ffmpeg child, and the last release kills it after the grace', async () => {
    vi.useFakeTimers()
    try {
      const { manager, children } = managerHarness(5_000)
      const a = await manager.acquire(request('session-a'))
      const b = await manager.acquire(request('session-b'))

      expect(children).toHaveLength(1)
      expect(a.pipelineKey).toBe(b.pipelineKey)
      // Both attach to the SAME published stream — the broker names it from
      // its own sharing key, so dedup on the child dedups the publication too.
      expect(a.camStreamId).toBe(b.camStreamId)
      expect(a.camStreamId).not.toBeNull()

      // The first viewer leaving must not disturb the second.
      await manager.release({ pipelineKey: a.pipelineKey })
      vi.advanceTimersByTime(10_000)
      expect(children[0]?.stopped).toBe(false)

      await manager.release({ pipelineKey: b.pipelineKey })
      expect(children[0]?.stopped).toBe(false)
      vi.advanceTimersByTime(5_001)
      await Promise.resolve()
      expect(children[0]?.stopped).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a tier change spawns a SECOND child rather than re-shaping the first', async () => {
    const { manager, children } = managerHarness(0)
    const base = await manager.acquire(request('session-a'))
    const down = await manager.acquire(
      buildTranscodeEgressRequest({
        deviceId: DEVICE_ID,
        camStreamId: CAM_STREAM_ID,
        profile: reduceProfileForTranscodeDown(WEBRTC_FALLBACK_PROFILE),
        sessionId: 'session-a',
      }),
    )
    expect(children).toHaveLength(2)
    expect(down.pipelineKey).not.toBe(base.pipelineKey)
    // The rung the OTHER viewers are on is untouched — that is the whole point
    // of the immutable handle.
    expect(children[0]?.stopped).toBe(false)
  })
})
