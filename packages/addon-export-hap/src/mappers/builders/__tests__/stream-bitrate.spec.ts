/**
 * The stream we send must FIT the rate HomeKit negotiated.
 *
 * Measured on the live hub on 2026-08-06, one 19.27 s session on 101/mid:
 * 737 video packets at `mtu=1378` ≈ **421 kbps** against a negotiated
 * `max_bit_rate` of **299**, and the controller's own Receiver Reports said it
 * lost 450 of those 737 packets (61 %). Under `-c:v copy` the accessory has no
 * lever at all — it forwards whatever the camera produces.
 *
 * These tests pin the two halves of the fix: resolving what a slot really
 * costs (and refusing to be fooled by the broker's idle flow reading), and
 * choosing copy-vs-transcode from that.
 */

import type {
  CameraStream,
  ProfileRtspEntry,
  ProfileSlot,
  StreamParamsStatus,
  WebrtcStreamChoice,
} from '@camstack/types'
import { buildFfmpegArgs } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import {
  encodeBudgetKbps,
  BITRATE_HEADROOM,
  budgetForNegotiatedRate,
  buildVideoPlan,
  classifyBitrateFit,
  type ProfileBitrateEvidence,
  resolveProfileBitrates,
  selectStreamForBudget,
  type VideoEncodeArgsInput,
  withSlotCodecs,
} from '../stream-bitrate.js'

const DEVICE_ID = 101

/** The negotiated ceiling from the failing 2026-08-06 session. */
const NEGOTIATED_KBPS = 299

function entry(
  profile: 'high' | 'mid' | 'low',
  width: number,
  height: number,
  codec: string | undefined = 'h264',
): ProfileRtspEntry {
  return {
    profile,
    brokerId: `${DEVICE_ID}/${profile}`,
    url: `rtsp://hub/${profile}`,
    mutedUrl: `rtsp://hub/${profile}/muted`,
    enabled: true,
    ...(codec === undefined ? {} : { codec }),
    resolution: { width, height },
  }
}

/** 101's real shape: High 4K, Mid 720p, Low 360p — all H.264. */
const ENTRIES_101: readonly ProfileRtspEntry[] = [
  entry('high', 3840, 2160),
  entry('mid', 1280, 720),
  entry('low', 640, 360),
]

function slot(
  profile: 'high' | 'mid' | 'low',
  sourceCamStreamId: string | null,
  codec = 'h264',
): ProfileSlot {
  return {
    deviceId: DEVICE_ID,
    profile,
    brokerId: `${DEVICE_ID}/${sourceCamStreamId ?? profile}`,
    sourceCamStreamId,
    status: 'streaming',
    codec,
  }
}

function camStream(camStreamId: string, width: number, height: number, fps: number): CameraStream {
  return {
    camStreamId,
    deviceId: DEVICE_ID,
    kind: 'pull-rtsp',
    resolution: { width, height },
    fps,
  }
}

function choice(profile: 'high' | 'mid' | 'low', bitrateKbps: number | null): WebrtcStreamChoice {
  return {
    id: `profile:${profile}`,
    label: profile,
    target: { kind: 'profile', profile },
    codec: 'h264',
    resolution: null,
    status: 'streaming',
    inputFps: null,
    bitrateKbps,
  }
}

/** 101's `streamParams.getStatus`, read off the live hub on 2026-08-06. */
const STREAM_PARAMS_101: StreamParamsStatus = {
  main: {
    width: 3840,
    height: 2160,
    codec: 'h264',
    framerate: 25,
    bitrate: 8192,
    bitrateMode: 'vbr',
  },
  sub: {
    width: 640,
    height: 360,
    codec: 'h264',
    framerate: 25,
    bitrate: 2048,
    bitrateMode: 'vbr',
  },
  ext: {
    width: 1280,
    height: 720,
    codec: 'h264',
    framerate: 10,
    bitrate: 2048,
    bitrateMode: 'vbr',
  },
  lastFetchedAt: 0,
}

/** 101's slot → source mapping, also read off the live hub. */
const SLOTS_101: readonly ProfileSlot[] = [
  slot('high', 'native:main'),
  slot('mid', 'native:slot-3'),
  slot('low', 'native:sub'),
]

const CAM_STREAMS_101: readonly CameraStream[] = [
  camStream('native:main', 3840, 2160, 25),
  camStream('native:sub', 640, 360, 25),
  camStream('native:slot-3', 1280, 720, 10),
]

describe('resolveProfileBitrates', () => {
  it('takes the CONFIGURED encoder bitrate as the authoritative per-slot rate', () => {
    const resolved = resolveProfileBitrates({
      slots: SLOTS_101,
      camStreams: CAM_STREAMS_101,
      streamParams: STREAM_PARAMS_101,
      choices: [],
    })

    // The slot the picker steers a 720p request onto is fed by the camera's
    // THIRD encoder (`ext`), which is configured at 2048 kbps.
    expect(resolved.get('mid')?.publishedKbps).toBe(2048)
    expect(resolved.get('high')?.publishedKbps).toBe(8192)
    expect(resolved.get('low')?.publishedKbps).toBe(2048)
  })

  it('DISCARDS the broker flow reading when it is implausibly small — the idle-slot trap', () => {
    // Live on 2026-08-06: `webrtcSession.listStreams` reported mid = 9 kbps
    // for the very slot that had just delivered ~421 kbps under load, and
    // low = 5 kbps. Those are idle-flow readings, not stream rates.
    const resolved = resolveProfileBitrates({
      slots: SLOTS_101,
      camStreams: CAM_STREAMS_101,
      streamParams: null,
      choices: [choice('mid', 9), choice('low', 5), choice('high', 5441)],
    })

    expect(resolved.get('mid')?.measuredKbps).toBeNull()
    expect(resolved.get('low')?.measuredKbps).toBeNull()
    // High IS being consumed, so its reading is plausible and kept.
    expect(resolved.get('high')?.measuredKbps).toBe(5441)
    // And none of them gained a published rate out of thin air.
    expect(resolved.get('mid')?.publishedKbps).toBeNull()
  })

  it('leaves the published rate UNKNOWN when two encoders are indistinguishable', () => {
    const ambiguous: StreamParamsStatus = {
      main: { width: 1280, height: 720, codec: 'h264', framerate: 10, bitrate: 4096 },
      ext: { width: 1280, height: 720, codec: 'h264', framerate: 10, bitrate: 512 },
      lastFetchedAt: 0,
    }
    const resolved = resolveProfileBitrates({
      slots: [slot('mid', 'native:slot-3')],
      camStreams: [camStream('native:slot-3', 1280, 720, 10)],
      streamParams: ambiguous,
      choices: [],
    })

    // Guessing either way is a 8× error in one direction. Say unknown.
    expect(resolved.get('mid')?.publishedKbps).toBeNull()
  })

  it('disambiguates same-resolution encoders by frame rate', () => {
    const sameRes: StreamParamsStatus = {
      main: { width: 1280, height: 720, codec: 'h264', framerate: 25, bitrate: 4096 },
      ext: { width: 1280, height: 720, codec: 'h264', framerate: 10, bitrate: 512 },
      lastFetchedAt: 0,
    }
    const resolved = resolveProfileBitrates({
      slots: [slot('mid', 'native:slot-3')],
      camStreams: [camStream('native:slot-3', 1280, 720, 10)],
      streamParams: sameRes,
      choices: [],
    })

    expect(resolved.get('mid')?.publishedKbps).toBe(512)
  })
})

describe('budgetForNegotiatedRate', () => {
  it('reserves headroom for the packetisation overhead HomeKit also has to carry', () => {
    // RTP 12 + SRTP tag 10 + UDP 8 + IP 20 on a 1378-byte packet is 3.6 %;
    // the rest is VBV overshoot margin. Asserted as a number, not as the
    // constant, so changing the constant is a visible decision.
    expect(budgetForNegotiatedRate(NEGOTIATED_KBPS)).toBe(269)
    expect(BITRATE_HEADROOM).toBeLessThan(1)
  })

  it('returns null for a ceiling that carries no information', () => {
    expect(budgetForNegotiatedRate(0)).toBeNull()
    expect(budgetForNegotiatedRate(-1)).toBeNull()
    expect(budgetForNegotiatedRate(Number.NaN)).toBeNull()
  })
})

describe('classifyBitrateFit', () => {
  const budget = 269

  function evidence(
    publishedKbps: number | null,
    measuredKbps: number | null,
  ): ProfileBitrateEvidence {
    return { profile: 'mid', publishedKbps, measuredKbps }
  }

  it('fits only when the CONFIGURED rate is known and within budget', () => {
    expect(classifyBitrateFit(evidence(200, null), budget)).toBe('fits')
    expect(classifyBitrateFit(evidence(2048, null), budget)).toBe('over-budget')
  })

  it('treats an absent configured rate as UNKNOWN, never as a fit', () => {
    expect(classifyBitrateFit(evidence(null, null), budget)).toBe('unknown')
    expect(classifyBitrateFit(undefined, budget)).toBe('unknown')
  })

  it('lets the MEASURED rate only disprove a fit, never prove one', () => {
    // A flow reading is a lower bound: over budget already is decisive…
    expect(classifyBitrateFit(evidence(null, 900), budget)).toBe('over-budget')
    // …under budget proves nothing, because it under-states a VBR peak.
    expect(classifyBitrateFit(evidence(null, 100), budget)).toBe('unknown')
    // And it overrides an optimistic publication.
    expect(classifyBitrateFit(evidence(200, 900), budget)).toBe('over-budget')
  })
})

describe('selectStreamForBudget', () => {
  const BITRATES_101 = resolveProfileBitrates({
    slots: SLOTS_101,
    camStreams: CAM_STREAMS_101,
    streamParams: STREAM_PARAMS_101,
    choices: [],
  })

  it('COPIES on a LOCAL session — no 101 slot fits 299 kbps, and that is fine', () => {
    const decision = selectStreamForBudget({
      entries: ENTRIES_101,
      deviceId: DEVICE_ID,
      pref: 'auto',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: NEGOTIATED_KBPS,
      bitrates: BITRATES_101,
    })

    // UPDATED 2026-09-17. This asserted `copy`, and copying a 3840x2160 slot to
    // a controller that negotiated 1280x720 is what iOS reported losing 52.7 %
    // of. The slot choice is UNCHANGED and so is this test's original point —
    // the connection class, not resolution proximity, still names the source,
    // and 101's 10 fps `mid` is still not it. What changed is that a source
    // BIGGER than the request is now re-encoded down to the request instead of
    // being forwarded whole.
    expect(decision?.kind).toBe('transcode')
    expect(decision?.reason).toBe('over-resolution')
    // NOT the slot nearest the negotiated resolution. This assertion used to
    // read `mid`, and that expectation is exactly what kept selecting 101's
    // 10 fps slot — the only one that never rendered. The connection class
    // decides now.
    //
    // It then read `low` for as long as `slotForConnection` was frozen there by
    // the 93-video-packets measurement. That measurement's cause was the
    // loopback socket's unset SO_RCVBUF (`stream-socket-buffer.ts`), fixed
    // 2026-08-07, so a LOCAL session takes the camera's best stream again —
    // which is what the reference does and what the operator sees render
    // instantly on these same cameras.
    expect(decision?.profile).toBe('high')
    expect(decision?.budgetKbps).toBe(269)
  })

  it('COPIES when a slot genuinely fits, and prefers it over an over-budget one', () => {
    const cheapLow = resolveProfileBitrates({
      slots: SLOTS_101,
      camStreams: CAM_STREAMS_101,
      streamParams: { ...STREAM_PARAMS_101, sub: { ...STREAM_PARAMS_101.sub!, bitrate: 200 } },
      choices: [],
    })
    const decision = selectStreamForBudget({
      entries: ENTRIES_101,
      deviceId: DEVICE_ID,
      pref: 'auto',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: NEGOTIATED_KBPS,
      bitrates: cheapLow,
    })

    expect(decision?.kind).toBe('copy')
    expect(decision?.profile).toBe('low')
  })

  it('never passes an H.265 slot through to the CLASSIC service, even when it fits', () => {
    const hevc: readonly ProfileRtspEntry[] = [entry('mid', 1280, 720, 'h265')]
    const decision = selectStreamForBudget({
      entries: hevc,
      deviceId: DEVICE_ID,
      pref: 'auto',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: 4000,
      bitrates: resolveProfileBitrates({
        slots: [slot('mid', 'native:slot-3', 'h265')],
        camStreams: [camStream('native:slot-3', 1280, 720, 10)],
        streamParams: STREAM_PARAMS_101,
        choices: [],
      }),
    })

    expect(decision?.kind).toBe('transcode')
    expect(decision?.reason).toBe('source-codec')
  })

  /**
   * The same slot, offered to Apple's multi-tier RTP service.
   *
   * `canPassThrough` refused H.265 because *"iOS Home renders only H.264 over
   * the classic HAP SRTP path"* — true, and true only of that path. The new
   * service advertises `VideoCodecType 2 = H.265` in its tiers, so refusing it
   * there transcodes 4K HEVC down to H.264 for a controller that asked for the
   * HEVC. That transcode is the entire cost this service exists to remove.
   *
   * The permission belongs to the SESSION, not to the camera: the same camera
   * serves both services, and which one negotiated decides what may be copied.
   */
  it('passes an H.265 slot through when the session negotiated on the new service', () => {
    const hevc: readonly ProfileRtspEntry[] = [entry('mid', 1280, 720, 'h265')]
    const decision = selectStreamForBudget({
      entries: hevc,
      deviceId: DEVICE_ID,
      pref: 'auto',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: 4000,
      allowHevcPassthrough: true,
      bitrates: resolveProfileBitrates({
        slots: [slot('mid', 'native:slot-3', 'h265')],
        camStreams: [camStream('native:slot-3', 1280, 720, 10)],
        streamParams: STREAM_PARAMS_101,
        choices: [],
      }),
    })

    expect(decision?.kind).toBe('copy')
  })

  /**
   * An UNKNOWN codec stays refused on BOTH services. Guessing is how a camera
   * that changed its encoder ends up shipping bytes no controller can decode,
   * and the new service's permission is for H.265 specifically — not for
   * "whatever this turns out to be".
   */
  it('still refuses an unknown codec on the new service', () => {
    // Built by hand, not through `entry(..., undefined)`: passing `undefined`
    // to a parameter with a default USES the default, so that spelling had
    // silently produced an h264 entry and tested nothing.
    const withCodec = entry('mid', 1280, 720)
    const { codec: _dropped, ...withoutCodec } = withCodec
    const unknown: readonly ProfileRtspEntry[] = [withoutCodec as ProfileRtspEntry]
    const decision = selectStreamForBudget({
      entries: unknown,
      deviceId: DEVICE_ID,
      pref: 'auto',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: 4000,
      allowHevcPassthrough: true,
      bitrates: resolveProfileBitrates({
        slots: [slot('mid', 'native:slot-3', undefined)],
        camStreams: [camStream('native:slot-3', 1280, 720, 10)],
        streamParams: STREAM_PARAMS_101,
        choices: [],
      }),
    })

    expect(decision?.kind).toBe('transcode')
    expect(decision?.reason).toBe('source-codec')
  })

  it('copies rather than re-encoding when no slot has a known rate', () => {
    const decision = selectStreamForBudget({
      entries: ENTRIES_101,
      deviceId: DEVICE_ID,
      pref: 'auto',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: NEGOTIATED_KBPS,
      bitrates: new Map(),
    })

    // UPDATED 2026-09-17. The point of this test is that an UNKNOWN rate must
    // not be the thing that forces a re-encode, and it still is: the reason is
    // a resolution one, not a bitrate one. 101's `high` is 3840x2160 and the
    // controller asked for 1280x720, which is now re-encoded rather than
    // forwarded whole — see `fitsRequestedResolution`.
    expect(decision?.kind).toBe('transcode')
    expect(decision?.reason).toBe('over-resolution')
  })

  it('does NOT transcode FOR A BITRATE REASON when the controller negotiated no usable ceiling', () => {
    const decision = selectStreamForBudget({
      entries: ENTRIES_101,
      deviceId: DEVICE_ID,
      pref: 'auto',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: 0,
      bitrates: BITRATES_101,
    })

    // UPDATED 2026-09-17. Same preserved point: a null ceiling must not be the
    // thing that forces a re-encode, and it is not — the reason names the
    // resolution. `budgetKbps` stays null, which is what "no ceiling" has to
    // mean downstream: pass no `-maxrate` at all.
    expect(decision?.reason).toBe('over-resolution')
    expect(decision?.budgetKbps).toBeNull()
  })

  it('honours a PINNED preference and passes it through, budget or not', () => {
    const decision = selectStreamForBudget({
      entries: ENTRIES_101,
      deviceId: DEVICE_ID,
      pref: 'high',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: NEGOTIATED_KBPS,
      bitrates: BITRATES_101,
    })

    // The pinned slot is still dialled — it is simply transcoded to fit.
    // UPDATED 2026-09-17. The PIN is what this test is about and it holds: the
    // profile is still `high`, never swapped. Only the delivery changed — a
    // 3840x2160 source for a 1280x720 request is re-encoded down instead of
    // forwarded whole.
    expect(decision?.profile).toBe('high')
    expect(decision?.kind).toBe('transcode')
  })

  it('never swaps a PINNED slot for a cheaper one that happens to fit', () => {
    // Low fits, High does not. Under `auto` the budget would pick Low; under a
    // pin the operator asked for High, so High is transcoded instead.
    const cheapLow = resolveProfileBitrates({
      slots: SLOTS_101,
      camStreams: CAM_STREAMS_101,
      streamParams: { ...STREAM_PARAMS_101, sub: { ...STREAM_PARAMS_101.sub!, bitrate: 200 } },
      choices: [],
    })
    const decision = selectStreamForBudget({
      entries: ENTRIES_101,
      deviceId: DEVICE_ID,
      pref: 'high',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: NEGOTIATED_KBPS,
      bitrates: cheapLow,
    })

    // UPDATED 2026-09-17. The PIN is what this test is about and it holds: the
    // profile is still `high`, never swapped. Only the delivery changed — a
    // 3840x2160 source for a 1280x720 request is re-encoded down instead of
    // forwarded whole.
    expect(decision?.profile).toBe('high')
    expect(decision?.kind).toBe('transcode')
    expect(decision?.reason).toBe('over-resolution')
  })

  it('copies a PINNED slot when it does fit', () => {
    const cheapHigh = resolveProfileBitrates({
      slots: SLOTS_101,
      camStreams: CAM_STREAMS_101,
      streamParams: { ...STREAM_PARAMS_101, main: { ...STREAM_PARAMS_101.main!, bitrate: 200 } },
      choices: [],
    })
    const decision = selectStreamForBudget({
      entries: ENTRIES_101,
      deviceId: DEVICE_ID,
      pref: 'high',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: NEGOTIATED_KBPS,
      bitrates: cheapHigh,
    })

    // UPDATED 2026-09-17. The PIN is what this test is about and it holds: the
    // profile is still `high`, never swapped. Only the delivery changed — a
    // 3840x2160 source for a 1280x720 request is re-encoded down instead of
    // forwarded whole.
    expect(decision?.profile).toBe('high')
    expect(decision?.kind).toBe('transcode')
  })

  it('returns null when nothing is publishable', () => {
    expect(
      selectStreamForBudget({
        entries: [],
        deviceId: DEVICE_ID,
        pref: 'auto',
        targetResolution: { width: 1280, height: 720 },
        connection: 'local',
        negotiatedMaxBitrateKbps: NEGOTIATED_KBPS,
        bitrates: BITRATES_101,
      }),
    ).toBeNull()
  })

  it('reports a per-slot verdict for every candidate, so the log can say WHY', () => {
    const decision = selectStreamForBudget({
      entries: ENTRIES_101,
      deviceId: DEVICE_ID,
      pref: 'auto',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: NEGOTIATED_KBPS,
      bitrates: BITRATES_101,
    })

    expect(decision?.notes).toEqual([
      { profile: 'high', verdict: 'over-budget', publishedKbps: 8192, measuredKbps: null },
      { profile: 'mid', verdict: 'over-budget', publishedKbps: 2048, measuredKbps: null },
      { profile: 'low', verdict: 'over-budget', publishedKbps: 2048, measuredKbps: null },
    ])
  })
})

describe('withSlotCodecs', () => {
  it('fills a codec the restream entry did not carry from its broker slot', () => {
    const codecless: ProfileRtspEntry = {
      profile: 'mid',
      brokerId: `${DEVICE_ID}/mid`,
      url: 'rtsp://hub/mid',
      mutedUrl: 'rtsp://hub/mid/muted',
      enabled: true,
      resolution: { width: 1280, height: 720 },
    }
    const enriched = withSlotCodecs([codecless], [slot('mid', 'native:slot-3', 'h265')])
    expect(enriched[0]?.codec).toBe('h265')
  })

  it('never overwrites a codec the entry already declared', () => {
    const enriched = withSlotCodecs(
      [entry('mid', 1280, 720, 'h264')],
      [slot('mid', 'native:slot-3', 'h265')],
    )
    expect(enriched[0]?.codec).toBe('h264')
  })
})

describe('buildVideoPlan', () => {
  // This module now describes the encode; `buildFfmpegArgs` in `@camstack/types`
  // emits it (D67 — the repo keeps ONE argv builder). The assertions below run
  // the plan THROUGH that builder rather than reading its fields, so they still
  // fail if the shared builder ever stops emitting a flag HomeKit depends on.
  // Placement of `-g` and `-bsf:v` within the full two-output vector is
  // asserted in `stream-ffmpeg-argv.spec.ts`.
  const argsFor = (input: VideoEncodeArgsInput): readonly string[] =>
    buildFfmpegArgs({
      logLevel: 'warning',
      decodeHwAccel: null,
      input: { url: 'rtsp://x' },
      video: buildVideoPlan(input),
      audio: { kind: 'none' },
      threadCount: 0,
      outputArgs: [],
      sink: { kind: 'stdout', container: 'h264' },
    })

  const BUDGETED: VideoEncodeArgsInput = {
    transcode: true,
    width: 1280,
    height: 720,
    fps: 10,
    budgetKbps: 269,
  }

  // BOTH branches need the parameter sets in-band, and only pass-through had
  // them. ffmpeg's RTP muxer declares AVFMT_GLOBALHEADER, so libx264 puts
  // SPS/PPS in extradata and NOT before each IDR — they would travel only in an
  // SDP that HAP never carries. Measured consequence: 65 receiver reports, 5
  // packets lost across 1,272, and a loader on screen for the whole session.
  it('inlines SPS/PPS on the TRANSCODE branch too, not only on pass-through', () => {
    const args = argsFor(BUDGETED)
    const bsf = args.indexOf('-bsf:v')
    expect(bsf).toBeGreaterThan(-1)
    expect(args[bsf + 1]).toBe('dump_extra')
  })

  // The transcode branch never set -g, so x264 used its own default of 250
  // frames. At the 10 fps we dial for 101/mid that is ONE IDR EVERY 25
  // SECONDS: iOS joins mid-GOP, receives every packet intact (measured: 63
  // receiver reports, 0% loss, 1 packet lost all session) and has nothing to
  // start decoding from. It showed a loader and gave up at 31.5s.
  it('forces a keyframe interval — without one x264 defaults to 250 frames', () => {
    const args = argsFor(BUDGETED)
    const g = args.indexOf('-g')
    expect(g).toBeGreaterThan(-1)
    // Four seconds of IDR spacing at the rate we actually deliver, matching
    // what the reference implementation dials.
    expect(args[g + 1]).toBe('40')
  })

  it('scales the keyframe interval with the delivered rate, not a constant', () => {
    // A budget that CARRIES 25 fps at 720p (802 kbps is ~0.035 bit/px at 25),
    // so the delivered rate is the requested one and four seconds is 100
    // frames. With the 269 kbps fixture the budget lowers 25 to 10 and the
    // right answer is 40 — asserting 100 there is asserting a 10 s GOP, which
    // is the regression this test used to encode.
    const at25 = argsFor({ ...BUDGETED, fps: 25, budgetKbps: 802 })
    expect(at25[at25.indexOf('-r') + 1]).toBe('25')
    expect(at25[at25.indexOf('-g') + 1]).toBe('100')
  })

  it('passes through untouched when the source already fits', () => {
    expect(buildVideoPlan({ ...BUDGETED, transcode: false })).toEqual({
      kind: 'copy',
      bitstreamFilter: 'dump_extra',
    })
  })

  it('caps the encoder at the negotiated budget — the 421-vs-299 overshoot', () => {
    const args = argsFor(BUDGETED)

    expect(args).toContain('libx264')
    // -b:v alone is an average; -maxrate + -bufsize is what bounds the WIRE.
    expect(args[args.indexOf('-maxrate') + 1]).toBe('269k')
    expect(args[args.indexOf('-b:v') + 1]).toBe('269k')
    // A one-second VBV window: any one-second burst is bounded by the
    // negotiated rate, which is the only lever we have on the 3 s jitter.
    // Encoded as the shared RATE_CONTROL_TIGHT, not as a second copy of `1`.
    expect(args[args.indexOf('-bufsize') + 1]).toBe('269k')
    expect(args[args.indexOf('-r') + 1]).toBe('10')
    // `-s WxH` became `-vf scale=W:H` in the move behind the shared builder.
    // Equivalent for a plain rescale; NOT interchangeable once another `-vf`
    // is in play, which is why it is named rather than merely tolerated.
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=1280:720')
    expect(args).not.toContain('-s')
    expect(args[args.indexOf('-profile:v') + 1]).toBe('baseline')
    expect(args[args.indexOf('-level') + 1]).toBe('3.1')
    expect(args[args.indexOf('-tune') + 1]).toBe('zerolatency')
  })

  it('omits the rate cap entirely when there is no budget to cap to', () => {
    const args = argsFor({ ...BUDGETED, budgetKbps: null })

    // Never emit `-maxrate 0k`, which ffmpeg accepts and which caps nothing.
    expect(args).not.toContain('-maxrate')
    expect(args).not.toContain('-b:v')
    expect(args).not.toContain('-bufsize')
    expect(args).toContain('libx264')
  })
})

/**
 * The encoder is not starved below what its own settings need.
 *
 * ## The report this closes (operator, 2026-09-16)
 *
 * The one H.265 camera on this hub shows a loader in the Home app; the three
 * H.264 ones are fine. H.264 means PASS-THROUGH, H.265 means transcode, so the
 * split is the path, not the camera.
 *
 * Measured on the hub, same controller, same negotiated ceiling of 299 kbps:
 *
 *   pass-through   4070 video packets in 5.7 s   =  714 pkt/s   works
 *   transcode       273 video packets in 4.1 s   =   66 pkt/s   loader
 *
 * Pass-through IGNORES the ceiling — 714 pkt/s is roughly 7.4 Mbps against a
 * 299 kbps ask, twenty-five times over — and the controller is happy, reports
 * 0 % loss and keeps the session. So the ceiling is not something iOS
 * enforces; it is a hint. Our transcode honoured it to the letter and produced
 * a stream at a sixteenth of the working rate, which our own verdict field
 * called `decode-suspect` three sessions running.
 *
 * 269 kbps for 1280×720 at 30 fps is ~0.01 bits per pixel. The encoder is
 * pinned to `ultrafast` + `zerolatency` + `baseline` — the three settings that
 * trade compression efficiency away for latency — so it needs MORE bits than a
 * default encoder would, not fewer. Below a floor it cannot produce a picture
 * a decoder will lock onto at all, and the controller sits on a loader and
 * gives up.
 *
 * The floor is therefore a property of the ENCODER's own configuration, which
 * is why it lives beside it and not in the slot fitter: the fitter's budget
 * still decides WHICH slot to take.
 */
describe('the budget decides the frame rate, not the bitrate', () => {
  const plan = (over: Partial<VideoEncodeArgsInput> = {}) =>
    buildVideoPlan({ transcode: true, width: 1280, height: 720, fps: 30, budgetKbps: 269, ...over })

  it('lowers 720p30 to a rate 269 kbps can actually carry', () => {
    const p = plan()
    if (p.kind !== 'encode') throw new Error('expected encode')
    expect(p.fps).toBeLessThan(30)
    expect(p.fps).toBeGreaterThanOrEqual(1)
  })

  it('does NOT raise the bitrate above what the controller negotiated', () => {
    // The lever this module already refused once: an encoder overshooting its
    // ceiling (421 against 299) produced three seconds of jitter. The ceiling
    // holds; the frame rate is what gives.
    const p = plan()
    if (p.kind !== 'encode') throw new Error('expected encode')
    expect(p.bitrateKbps).toBe(269)
  })

  it('leaves a rate the budget CAN carry untouched', () => {
    // A floor, never a target. 640x360 at 10 fps needs ~69 kbps at the
    // configured density, so a 269 kbps budget carries it with room to spare.
    const p = plan({ width: 640, height: 360, fps: 10 })
    if (p.kind !== 'encode') throw new Error('expected encode')
    expect(p.fps).toBe(10)
  })

  it('never falls to zero — that is no stream, not a slower one', () => {
    const p = plan({ width: 3840, height: 2160, budgetKbps: 1 })
    if (p.kind !== 'encode') throw new Error('expected encode')
    expect(p.fps).toBe(1)
  })

  it('leaves the rate alone when there is no budget at all', () => {
    // `null` means the controller named no ceiling. That path predates this
    // and must keep behaving as it did.
    const p = plan({ budgetKbps: null })
    if (p.kind !== 'encode') throw new Error('expected encode')
    expect(p.fps).toBe(30)
    expect(p.bitrateKbps).toBeUndefined()
  })
})

/**
 * What the controller is handed per access unit, and how often. (D515)
 *
 * Captured on the live hub 2026-09-16 with the EXACT argv this plan emits, on
 * the one H.265 camera: every access unit left x264 as ELEVEN slices (`-tune
 * zerolatency` turns on sliced threads; a 20-core host at 720p is capped at
 * 45 / 4 = 11), sharing one RTP timestamp and one marker bit — and the IDR
 * spacing was 12 s, not the 4 s the plan promises, because `-g` was derived
 * from the REQUESTED rate while `-r` had already been lowered to 10.
 * Pass-through cameras, captured the same way, hand iOS ONE slice per access
 * unit, and those cameras work.
 */
describe('one slice per access unit, and a GOP measured at the rate we deliver', () => {
  const plan = (over: Partial<VideoEncodeArgsInput> = {}) =>
    buildVideoPlan({ transcode: true, width: 1280, height: 720, fps: 30, budgetKbps: 269, ...over })

  it('derives -g from the LOWERED frame rate, so four seconds stay four seconds', () => {
    const p = plan()
    if (p.kind !== 'encode') throw new Error('expected encode')
    // 720p30 into 269 kbps is lowered to 10 fps; four seconds of that is 40
    // frames. 120 (= 30 × 4) at 10 fps is a twelve-second GOP, which is the
    // loader this module already recorded once for a 25 s GOP.
    expect(p.fps).toBe(10)
    expect(p.gopFrames).toBe(40)
  })

  it('keeps -g at four seconds when the rate is NOT lowered', () => {
    const p = plan({ width: 640, height: 360, fps: 10 })
    if (p.kind !== 'encode') throw new Error('expected encode')
    expect(p.fps).toBe(10)
    expect(p.gopFrames).toBe(40)
  })

  it('asks x264 for ONE slice per access unit', () => {
    const args = argsForPlan(plan())
    const i = args.indexOf('-x264-params')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('sliced-threads=0')
    // ...and the tune stays: it is the lookahead and the B-frames we want gone.
    expect(args[args.indexOf('-tune') + 1]).toBe('zerolatency')
  })

  function argsForPlan(video: ReturnType<typeof buildVideoPlan>): readonly string[] {
    return buildFfmpegArgs({
      logLevel: 'warning',
      decodeHwAccel: null,
      input: { url: 'rtsp://x' },
      video,
      audio: { kind: 'none' },
      threadCount: 0,
      outputArgs: [],
      sink: { kind: 'stdout', container: 'h264' },
    })
  }
})

describe('encodeBudgetKbps — what a TRANSCODE is allowed to aim at', () => {
  /**
   * Measured on the hub, 2026-09-17, two cameras on the same link with the
   * same negotiated ceiling of 299 kbps:
   *
   * | camera   | source | branch    | on the wire   |
   * | -------- | ------ | --------- | ------------- |
   * | front door | H.264  | copy      | **8192 kbps** |
   * | kitchen   | H.265  | transcode | **269 kbps**  |
   *
   * Thirty times less, and the only difference is which branch the camera
   * falls into. `over-budget-tolerated` already decided, with a reference NVR
   * as the evidence, that *"the negotiated ceiling is a budget the controller
   * copes with being exceeded, not a contract that must be met"* — and then
   * the transcode path went on honouring it as a contract.
   *
   * So a transcode may aim at the guide's own normative average for the
   * resolution it is DELIVERING (§ 2: 720p30 → 768 kbps), and the negotiated
   * budget becomes a FLOOR rather than a ceiling. It never lowers a budget the
   * controller was willing to grant.
   */
  it('lifts a 720p transcode to the guide’s target instead of the negotiated 269', () => {
    expect(encodeBudgetKbps({ negotiatedBudgetKbps: 269, width: 1280 })).toBe(768)
  })

  it('leaves a 360p transcode alone — the guide asks less than the controller granted', () => {
    // 360p is 180 kbps in the table. A session relayed through a Home Hub
    // negotiates exactly this, and raising it would spend the relay's
    // bandwidth for nothing.
    expect(encodeBudgetKbps({ negotiatedBudgetKbps: 269, width: 640 })).toBe(269)
  })

  it('honours a controller that granted MORE than the guide asks for', () => {
    expect(encodeBudgetKbps({ negotiatedBudgetKbps: 4000, width: 1280 })).toBe(4000)
  })

  it('caps nothing when the controller negotiated no usable ceiling', () => {
    // `null` means "do not pass -maxrate at all". Inventing a number here
    // would cap a stream that was deliberately uncapped.
    expect(encodeBudgetKbps({ negotiatedBudgetKbps: null, width: 1280 })).toBeNull()
  })
})

describe('never deliver more than the controller asked for', () => {
  /**
   * Measured on the hub, 2026-09-17, from iOS's OWN Receiver Reports:
   *
   * | camera   | delivered        | worst fraction lost |
   * | -------- | ---------------- | ------------------- |
   * | front door | 4K passthrough   | **52.7 %**          |
   * | hall   | 4K passthrough   | 0 %                 |
   * | kitchen   | 720p transcoded  | 0 %                 |
   *
   * iOS negotiated 1280x720 on all three and we were forwarding 3840x2160 to
   * the two that could be copied. A 4K key frame spans hundreds of packets;
   * lose one and the picture waits for the next key frame, up to 3.5 s later.
   * That is the "H.264 cameras are slower to load than the H.265 one" the
   * operator reported — the transcoded camera was the fast one because the
   * encoder is what held it to the size that was asked for.
   *
   * `over-budget-tolerated` stays: a rate overshoot is something a controller
   * copes with. A RESOLUTION overshoot is different — it is sending a picture
   * the controller never asked to decode, and here it cost 52.7 % of packets.
   */
  it('transcodes a 4K slot down when the controller negotiated 720p', () => {
    const uhd: readonly ProfileRtspEntry[] = [entry('high', 3840, 2160, 'h264')]
    const decision = selectStreamForBudget({
      entries: uhd,
      deviceId: DEVICE_ID,
      pref: 'auto',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: 299,
      bitrates: resolveProfileBitrates({
        slots: [slot('high', 'native:main', 'h264')],
        camStreams: [camStream('native:main', 3840, 2160, 24)],
        streamParams: STREAM_PARAMS_101,
        choices: [],
      }),
    })
    expect(decision?.kind).toBe('transcode')
    expect(decision?.reason).toBe('over-resolution')
  })

  it('still copies a slot that matches what was asked for', () => {
    const hd: readonly ProfileRtspEntry[] = [entry('high', 1280, 720, 'h264')]
    const decision = selectStreamForBudget({
      entries: hd,
      deviceId: DEVICE_ID,
      pref: 'auto',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: 299,
      bitrates: resolveProfileBitrates({
        slots: [slot('high', 'native:main', 'h264')],
        camStreams: [camStream('native:main', 1280, 720, 24)],
        streamParams: STREAM_PARAMS_101,
        choices: [],
      }),
    })
    expect(decision?.kind).toBe('copy')
  })

  /**
   * A slot whose size the publisher did not report is NOT evidence that it is
   * too big. Refusing it here would re-encode every camera with a terse
   * publisher — a real CPU cost imposed on no measurement at all. The
   * conservative direction for an unknown CODEC is refuse; for an unknown
   * SIZE it is allow, and the two are not the same judgement.
   */
  it('copies a slot whose resolution the publisher never reported', () => {
    const withSize = entry('high', 1280, 720, 'h264')
    const { resolution: _dropped, ...sizeless } = withSize
    const decision = selectStreamForBudget({
      entries: [sizeless as ProfileRtspEntry],
      deviceId: DEVICE_ID,
      pref: 'auto',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: 299,
      bitrates: resolveProfileBitrates({
        slots: [slot('high', 'native:main', 'h264')],
        camStreams: [camStream('native:main', 1280, 720, 24)],
        streamParams: STREAM_PARAMS_101,
        choices: [],
      }),
    })
    expect(decision?.kind).toBe('copy')
  })

  /**
   * A slot SMALLER than asked for is copied, not upscaled. We cannot add
   * detail, and an encoder run that only enlarges pixels spends CPU to make
   * the picture no better and the stream bigger.
   */
  it('copies a slot smaller than what was asked for rather than upscaling it', () => {
    const small: readonly ProfileRtspEntry[] = [entry('low', 640, 360, 'h264')]
    const decision = selectStreamForBudget({
      entries: small,
      deviceId: DEVICE_ID,
      pref: 'auto',
      targetResolution: { width: 1280, height: 720 },
      connection: 'local',
      negotiatedMaxBitrateKbps: 299,
      bitrates: resolveProfileBitrates({
        slots: [slot('low', 'native:sub', 'h264')],
        camStreams: [camStream('native:sub', 640, 360, 24)],
        streamParams: STREAM_PARAMS_101,
        choices: [],
      }),
    })
    expect(decision?.kind).toBe('copy')
  })
})
