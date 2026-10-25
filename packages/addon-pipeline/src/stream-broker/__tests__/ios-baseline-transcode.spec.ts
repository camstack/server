/**
 * iOS Constrained-Baseline transcode decision — unit tests.
 *
 * iPhone (WebKit) WebRTC negotiates and decodes ONLY H.264 Constrained
 * Baseline (profile_idc 0x42, plid `42e01f`). Cameras that emit Main
 * (`4d0033`) or High (`640034`) connect but PLI-storm to a black screen
 * because the negotiated-Baseline decoder rejects the Main/High NALs.
 * The broker advertises Baseline and must therefore MAKE the bytes
 * Baseline (transcode) when the source profile isn't already Baseline.
 *
 * These cover the two pure decision functions:
 *   - `isBaselineProfileLevelId` — is a camera's H.264 profile-level-id
 *     Baseline-decodable on iOS?
 *   - `resolveVideoTranscode` — given source/negotiated codecs and the
 *     baseline flag, must the session transcode?
 */
import { describe, it, expect } from 'vitest'
import { isBaselineProfileLevelId, groupNalsIntoAccessUnits } from '../webrtc/h264-utils.js'
import {
  resolveVideoTranscode,
  detectNegotiatedVideoCodec,
  AdaptiveSession,
} from '../webrtc/session.js'
import { createNullLogger, type FrameSource } from '../webrtc/types.js'
import {
  resolveBrokerTranscodeToBaseline,
  resolveClientOfferTranscodeToBaseline,
  extractOfferedH264ProfileLevelIds,
  deriveH264ProfileLevelId,
} from '../webrtc/broker-webrtc-server.js'
import type { EncodedPacket } from '@camstack/types'

/** A FrameSource that yields nothing — enough to construct a session. */
function emptySource(): FrameSource {
  return (async function* () {
    /* no frames */
  })()
}

describe('isBaselineProfileLevelId', () => {
  it('accepts Constrained Baseline 42e01f', () => {
    expect(isBaselineProfileLevelId('42e01f')).toBe(true)
  })

  it('accepts any profile_idc 0x42 (Baseline) regardless of constraints/level', () => {
    expect(isBaselineProfileLevelId('42c01f')).toBe(true)
    expect(isBaselineProfileLevelId('420028')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isBaselineProfileLevelId('42E01F')).toBe(true)
  })

  it('rejects Main 5.1 (4d0033) — the shipped Reolink profile', () => {
    expect(isBaselineProfileLevelId('4d0033')).toBe(false)
  })

  it('rejects High (640034)', () => {
    expect(isBaselineProfileLevelId('640034')).toBe(false)
  })

  it('rejects empty / malformed input', () => {
    expect(isBaselineProfileLevelId('')).toBe(false)
    expect(isBaselineProfileLevelId('4')).toBe(false)
  })
})

describe('resolveVideoTranscode', () => {
  it('transcodes H.265 source when the browser negotiated H.264 (existing behaviour, preserved)', () => {
    expect(
      resolveVideoTranscode({
        sourceCodec: 'H265',
        negotiatedCodec: 'H264',
        transcodeToBaseline: false,
      }),
    ).toBe(true)
  })

  it('passes through H.265 source when the browser negotiated H.265', () => {
    expect(
      resolveVideoTranscode({
        sourceCodec: 'H265',
        negotiatedCodec: 'H265',
        transcodeToBaseline: false,
      }),
    ).toBe(false)
  })

  it('transcodes a non-Baseline H.264 source for an H.264 client (the iOS fix)', () => {
    expect(
      resolveVideoTranscode({
        sourceCodec: 'H264',
        negotiatedCodec: 'H264',
        transcodeToBaseline: true,
      }),
    ).toBe(true)
  })

  it('passes through a Baseline H.264 source untouched (zero re-encode)', () => {
    expect(
      resolveVideoTranscode({
        sourceCodec: 'H264',
        negotiatedCodec: 'H264',
        transcodeToBaseline: false,
      }),
    ).toBe(false)
  })
})

describe('AdaptiveSession.needsTranscode wiring', () => {
  function makeSession(opts: { sourceCodec: 'H264' | 'H265'; transcodeToBaseline?: boolean }) {
    return new AdaptiveSession({
      sessionId: 's',
      deviceId: 1,
      source: emptySource(),
      logger: createNullLogger(),
      sourceCodec: opts.sourceCodec,
      ...(opts.transcodeToBaseline !== undefined
        ? { transcodeToBaseline: opts.transcodeToBaseline }
        : {}),
    })
  }

  it('reports needsTranscode for a non-Baseline H.264 source (transcodeToBaseline=true)', () => {
    expect(makeSession({ sourceCodec: 'H264', transcodeToBaseline: true }).needsTranscode).toBe(
      true,
    )
  })

  it('reports passthrough for a Baseline H.264 source (transcodeToBaseline=false)', () => {
    expect(makeSession({ sourceCodec: 'H264', transcodeToBaseline: false }).needsTranscode).toBe(
      false,
    )
  })

  it('defaults to passthrough when transcodeToBaseline is not supplied', () => {
    expect(makeSession({ sourceCodec: 'H264' }).needsTranscode).toBe(false)
  })

  it('still transcodes an H.265 source toward the default H.264 negotiation (existing behaviour)', () => {
    expect(makeSession({ sourceCodec: 'H265' }).needsTranscode).toBe(true)
  })
})

describe('resolveBrokerTranscodeToBaseline', () => {
  it('flags transcode for a Main 5.1 (4d0033) H.264 broker — the shipped Reolink', () => {
    expect(resolveBrokerTranscodeToBaseline('H264', '4d0033')).toBe(true)
  })

  it('flags transcode for a High (640034) H.264 broker', () => {
    expect(resolveBrokerTranscodeToBaseline('H264', '640034')).toBe(true)
  })

  it('does NOT transcode a Baseline (42e01f) H.264 broker', () => {
    expect(resolveBrokerTranscodeToBaseline('H264', '42e01f')).toBe(false)
  })

  it('does NOT flag transcode when the source profile is unknown (conservative passthrough)', () => {
    expect(resolveBrokerTranscodeToBaseline('H264', undefined)).toBe(false)
  })

  it('never sets the Baseline flag for an H.265 source (its transcode is negotiation-driven)', () => {
    expect(resolveBrokerTranscodeToBaseline('H265', '4d0033')).toBe(false)
    expect(resolveBrokerTranscodeToBaseline('H265', undefined)).toBe(false)
  })
})

describe('groupNalsIntoAccessUnits', () => {
  // NAL fixtures: byte0 = nal_ref_idc|type; byte1 high bit = first_mb_in_slice==0.
  const SPS = Buffer.from([0x67, 0x42, 0x00, 0x1f])
  const PPS = Buffer.from([0x68, 0xee])
  const SEI = Buffer.from([0x06, 0x00])
  const AUD = Buffer.from([0x09, 0x10])
  const idr = (firstPicture = true) => Buffer.from([0x65, firstPicture ? 0x80 : 0x00])
  const slice = (firstPicture = true) => Buffer.from([0x41, firstPicture ? 0x80 : 0x00])

  it('splits two pictures into two access units (the transcode framing bug)', () => {
    expect(groupNalsIntoAccessUnits([SPS, PPS, idr(), slice()])).toEqual([
      [SPS, PPS, idr()],
      [slice()],
    ])
  })

  it('keeps multiple slices of ONE picture in a single access unit', () => {
    // second slice has first_mb_in_slice != 0 → same picture
    expect(groupNalsIntoAccessUnits([idr(true), slice(false)])).toEqual([[idr(true), slice(false)]])
  })

  it('uses AUD as an access-unit boundary and strips the AUD itself', () => {
    expect(groupNalsIntoAccessUnits([AUD, SPS, PPS, idr(), AUD, slice()])).toEqual([
      [SPS, PPS, idr()],
      [slice()],
    ])
  })

  it('treats leading SPS/PPS/SEI as part of the following picture', () => {
    expect(groupNalsIntoAccessUnits([SEI, SPS, PPS, idr()])).toEqual([[SEI, SPS, PPS, idr()]])
  })

  it('returns one access unit for a single keyframe', () => {
    expect(groupNalsIntoAccessUnits([SPS, PPS, idr()])).toEqual([[SPS, PPS, idr()]])
  })

  it('returns nothing for an empty NAL list', () => {
    expect(groupNalsIntoAccessUnits([])).toEqual([])
  })
})

describe('detectNegotiatedVideoCodec', () => {
  const sdp = (rtpmap: string) => `v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:${rtpmap}\r\n`

  it('reads H264 from the answer rtpmap', () => {
    expect(detectNegotiatedVideoCodec(sdp('96 H264/90000'))).toBe('H264')
  })

  it('reads H265 from the answer rtpmap', () => {
    expect(detectNegotiatedVideoCodec(sdp('98 H265/90000'))).toBe('H265')
  })

  it('is case-insensitive', () => {
    expect(detectNegotiatedVideoCodec(sdp('96 h264/90000'))).toBe('H264')
  })

  it('returns the first video codec when several rtpmaps are present', () => {
    const multi = sdp('98 H265/90000') + 'a=rtpmap:96 H264/90000\r\n'
    expect(detectNegotiatedVideoCodec(multi)).toBe('H265')
  })

  it('returns undefined when no H.264/H.265 rtpmap is present', () => {
    expect(
      detectNegotiatedVideoCodec('v=0\r\nm=audio 9 RTP 111\r\na=rtpmap:111 opus/48000/2\r\n'),
    ).toBeUndefined()
  })

  // Regression: when the answer SDP lists H.264 BEFORE H.265 (the werift
  // client-offer flow does this because the browser orders H.264 first in its
  // offer and werift preserves that order in the answer), the raw "first match"
  // detection wrongly returns H.264 even though we negotiated H.265 too. With
  // a preferred codec hint the detector should pick the preferred when it's
  // present anywhere in the SDP. See cam 99 freeze diagnosis: H.265 source +
  // browser supports H.265 + H264-first answer → without preference we
  // mis-decide needsTranscode=true and corrupt the stream.
  it('prefers H.265 when preferred=H265 and both H.264 and H.265 appear (H.264 first)', () => {
    const multi = sdp('96 H264/90000') + 'a=rtpmap:97 H265/90000\r\n'
    expect(detectNegotiatedVideoCodec(multi, 'H265')).toBe('H265')
  })

  it('falls back to the first match when the preferred codec is absent', () => {
    const onlyH264 = sdp('96 H264/90000')
    expect(detectNegotiatedVideoCodec(onlyH264, 'H265')).toBe('H264')
  })

  it('prefers H.264 when preferred=H264 even if H.265 comes first', () => {
    const multi = sdp('97 H265/90000') + 'a=rtpmap:96 H264/90000\r\n'
    expect(detectNegotiatedVideoCodec(multi, 'H264')).toBe('H264')
  })

  it('without preferred, behaviour is unchanged (first match wins)', () => {
    const multi = sdp('96 H264/90000') + 'a=rtpmap:97 H265/90000\r\n'
    expect(detectNegotiatedVideoCodec(multi)).toBe('H264')
  })
})

describe('extractOfferedH264ProfileLevelIds', () => {
  it('extracts a single profile-level-id from an fmtp line', () => {
    const sdp =
      'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c34\r\n'
    expect(extractOfferedH264ProfileLevelIds(sdp)).toEqual(['640c34'])
  })

  it('extracts every offered profile (browsers advertise several H.264 profiles)', () => {
    const sdp =
      'a=fmtp:96 profile-level-id=42e01f\r\n' +
      'a=fmtp:98 profile-level-id=4d001f\r\n' +
      'a=fmtp:100 profile-level-id=640c34\r\n'
    expect(extractOfferedH264ProfileLevelIds(sdp)).toEqual(['42e01f', '4d001f', '640c34'])
  })

  it('lower-cases the hex so comparisons are stable', () => {
    expect(extractOfferedH264ProfileLevelIds('profile-level-id=640C34')).toEqual(['640c34'])
  })

  it('returns an empty list when no profile-level-id is advertised', () => {
    expect(extractOfferedH264ProfileLevelIds('a=rtpmap:96 H264/90000\r\n')).toEqual([])
  })
})

describe('resolveClientOfferTranscodeToBaseline (capability-driven)', () => {
  const HIGH = '640c34' // High, profile_idc 0x64 (100)
  const BASELINE = '42e01f' // Constrained Baseline, profile_idc 0x42 (66)

  // Capability-only rule: passthrough iff the client offered a
  // profile that decodes the source profile. The earlier level ≥ 5.0
  // force-transcode rule was reverted because re-encode at the
  // available `ultrafast` preset produced more loss-prone keyframes
  // than the source ones, and the audio drift that motivated it was
  // actually a separate timestamp bug (fix #25). Porch Main 5.1
  // stays passthrough (memory: camstack-ios-h264-passthrough); cam
  // 127 main also passes through, and Wi-Fi loss recovery for it is
  // deferred to a PLI propagation upstream task.
  it('PASSTHROUGH: 4K Main 5.1 source + High-capable client (iOS 18 fix)', () => {
    expect(resolveClientOfferTranscodeToBaseline('H264', '4d0033', [BASELINE, HIGH])).toBe(false)
  })

  it('PASSTHROUGH: High 5.2 source + High-capable client', () => {
    expect(resolveClientOfferTranscodeToBaseline('H264', '640034', [HIGH])).toBe(false)
  })

  it('PASSTHROUGH: 1440p Main 5.0 source + High-capable client (cam 127 main)', () => {
    expect(resolveClientOfferTranscodeToBaseline('H264', '4d0032', [BASELINE, HIGH])).toBe(false)
  })

  it('PASSTHROUGH: 1080p Main 4.0 source + High-capable client', () => {
    expect(resolveClientOfferTranscodeToBaseline('H264', '4d0028', [BASELINE, HIGH])).toBe(false)
  })

  it('TRANSCODE: Main source + Baseline-only client (older iOS / limited decoder)', () => {
    expect(resolveClientOfferTranscodeToBaseline('H264', '4d0033', [BASELINE])).toBe(true)
  })

  it('TRANSCODE: non-Baseline source + client that advertised no H.264 profile (RFC 6184 ⇒ Baseline)', () => {
    expect(resolveClientOfferTranscodeToBaseline('H264', '4d0033', [])).toBe(true)
  })

  it('PASSTHROUGH: Baseline source is always fine for any client', () => {
    expect(resolveClientOfferTranscodeToBaseline('H264', '42e01f', [])).toBe(false)
  })

  it('PASSTHROUGH: unknown source profile (e.g. battery cam pre-keyframe) — desktop still decodes', () => {
    expect(resolveClientOfferTranscodeToBaseline('H264', undefined, [BASELINE])).toBe(false)
  })

  it('never sets the Baseline flag for an H.265 source (negotiation-driven)', () => {
    expect(resolveClientOfferTranscodeToBaseline('H265', '4d0033', [BASELINE])).toBe(false)
  })
})

describe('deriveH264ProfileLevelId', () => {
  // Bare H.264 SPS NAL (no start code): header 0x67 (type 7), then
  // profile_idc / constraints / level_idc = Main 5.1 (4d 00 33).
  const mainSpsBareNal = Buffer.from([0x67, 0x4d, 0x00, 0x33])
  const ppsBareNal = Buffer.from([0x68, 0xee, 0x3c, 0x80])
  // Same SPS as an Annex-B access unit (with a 4-byte start code).
  const mainSpsAnnexB = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x4d, 0x00, 0x33])

  function videoPacket(data: Buffer): EncodedPacket {
    return { type: 'video', data, pts: 0, dts: 0, keyframe: true, codec: 'h264' }
  }

  it('reads the profile-level-id from SDP-published parameter sets (RTSP cameras)', () => {
    expect(deriveH264ProfileLevelId([ppsBareNal, mainSpsBareNal], [])).toBe('4d0033')
  })

  it('falls back to the pre-buffer when SDP has no param sets (push/Baichuan cameras)', () => {
    expect(deriveH264ProfileLevelId(null, [videoPacket(mainSpsAnnexB)])).toBe('4d0033')
  })

  it('returns undefined when no SPS is available anywhere', () => {
    expect(deriveH264ProfileLevelId(null, [])).toBeUndefined()
    expect(deriveH264ProfileLevelId([ppsBareNal], [])).toBeUndefined()
  })
})
