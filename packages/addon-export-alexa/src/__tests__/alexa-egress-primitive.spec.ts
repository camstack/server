/**
 * Alexa's egress, after it stopped materialising a derived stream of its own.
 *
 * ## What changed, and why
 *
 * Alexa used to call `publishCameraStream({ kind: 'derived', … })` with an
 * encode profile hashed into the stream's own id — `derived:alexa-<id>-<hash>`.
 * That stream is a **publicly selectable camStream**: a browser viewer or the
 * recorder can attach to it, and because it is a mutable shared object one
 * Alexa consumer's downgrade dragged every co-tenant with it. It was also never
 * retracted — one per (device, profile-hash), forever.
 *
 * It now acquires through `streamBroker.acquireEgressTranscode` (D67): a
 * refcounted handle over an IMMUTABLE plan, deduplicated on EXACT match, and
 * released when the Echo disconnects. **The derived mechanism itself is
 * untouched** — `derived-feeder-controller.ts`, the `derived:<name>` concept and
 * its lifecycle wiring all stay. Only Alexa's use of it for its own egress is
 * gone.
 *
 * ## The two argv deltas, named rather than discovered
 *
 * The primitive does not reproduce the old argv byte-for-byte, and both
 * differences are deliberate — D67 declared them and this file is where they
 * are pinned:
 *
 *  1. **`-level 3.1` appears.** Alexa's SDP advertises
 *     `profile-level-id=42e01f`, which IS Baseline 3.1, and its encoder was
 *     unconstrained. A stream that does not match its own advertisement is the
 *     defect class that kept HomeKit black for a year.
 *  2. **The in-band Opus encode disappears.** Opus in MPEG-TS is
 *     `stream_type 0x06`; the broker's demuxer maps only `0x0f` (aac),
 *     `0x03`/`0x04` (mp2) and `0x81` (ac3) — so the Opus this path encoded was
 *     **discarded at the demuxer and never reached a session**. It was pure CPU
 *     behind a comment describing it working. Alexa's audio rides the WebRTC
 *     session's own plane, out-of-band, exactly as the browser's does.
 */

import {
  ALEXA_EGRESS_PROFILE,
  BASE_LIVE_EGRESS_PROFILE,
  buildFfmpegArgs,
  type EncodeProfile,
  invocationFromEncodeProfile,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import {
  type AlexaStreamBrokerApi,
  acquireAlexaEgress,
  releaseAlexaEgress,
} from '../egress/alexa-rtc-egress.js'

/** What Alexa's derived stream USED to encode — kept only as the baseline. */
const PRE_MIGRATION_PROFILE: EncodeProfile = {
  video: {
    codec: 'h264',
    profile: 'baseline',
    width: 1280,
    height: 720,
    fps: 25,
    bitrateKbps: 2500,
    gopFrames: 25,
    bf: 0,
    preset: 'veryfast',
    tune: 'zerolatency',
  },
  audio: { codec: 'opus', bitrateKbps: 64, sampleRateHz: 48000, channels: 1 },
}

function argvFor(profile: EncodeProfile, audioAsDerived: boolean): readonly string[] {
  // The derived path swapped `passthrough` for `copy` because an MPEG-TS is
  // self-contained; the primitive's sink is an elementary Annex-B bytestream,
  // which cannot carry audio at all.
  const audio =
    audioAsDerived && profile.audio === 'passthrough' ? ({ codec: 'copy' } as const) : profile.audio
  return buildFfmpegArgs(
    invocationFromEncodeProfile({
      profile: { ...profile, audio },
      sourceCodec: 'h264',
      forceReencode: true,
      sourceUrl: 'rtsp://127.0.0.1:8554/src',
      sink: { kind: 'stdout', container: audioAsDerived ? 'mpegts' : 'h264' },
      decodeHwAccel: 'vaapi',
      logLevel: 'warning',
    }),
  )
}

describe('Alexa egress argv — before and after, with the deltas named', () => {
  it('the PRE-migration argv encoded Opus the MPEG-TS demuxer discards', () => {
    // Pinned so the change below is a diff against something real rather than
    // against a memory. `stream_type 0x06` is not in the demuxer's map.
    const before = argvFor(PRE_MIGRATION_PROFILE, true)
    expect(before).toContain('libopus')
    expect(before[before.indexOf('-b:a') + 1]).toBe('64k')
    // ...and it advertised Baseline in SDP while constraining no level.
    expect(before).toContain('baseline')
    expect(before).not.toContain('-level')
  })

  it('the POST-migration argv drops the audio encode and constrains the level', () => {
    const after = argvFor(ALEXA_EGRESS_PROFILE, false)
    // Delta 2: no Opus encoder, and the plane is explicitly muted rather than
    // left for ffmpeg to guess at.
    expect(after).not.toContain('libopus')
    expect(after).not.toContain('-c:a')
    expect(after).toContain('-an')
    // Delta 1: the level Alexa's own SDP advertises.
    expect(after[after.indexOf('-level') + 1]).toBe('3.1')
    expect(after[after.indexOf('-profile:v') + 1]).toBe('baseline')
  })

  it('is otherwise the SAME encode — every video knob unchanged', () => {
    // The two deltas above are the WHOLE change. Anything else moving here is
    // a regression, not a migration.
    const before = argvFor(PRE_MIGRATION_PROFILE, true)
    const after = argvFor(ALEXA_EGRESS_PROFILE, false)
    for (const [flag, value] of [
      ['-c:v', 'libx264'],
      ['-preset', 'veryfast'],
      ['-tune', 'zerolatency'],
      ['-profile:v', 'baseline'],
      ['-r', '25'],
      ['-g', '25'],
      ['-bf', '0'],
      ['-maxrate', '2500k'],
      [
        '-vf',
        "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      ],
    ] as const) {
      expect(before[before.indexOf(flag) + 1], `before ${flag}`).toBe(value)
      expect(after[after.indexOf(flag) + 1], `after ${flag}`).toBe(value)
    }
  })

  it('still decodes in HARDWARE — `-hwaccel` before `-i`, where it works', () => {
    const after = argvFor(ALEXA_EGRESS_PROFILE, false)
    const hw = after.indexOf('-hwaccel')
    expect(hw).toBeGreaterThan(-1)
    expect(hw).toBeLessThan(after.indexOf('-i'))
    expect(after[hw + 1]).toBe('vaapi')
  })
})

interface BrokerCalls {
  readonly acquire: ReturnType<typeof vi.fn>
  readonly release: ReturnType<typeof vi.fn>
  readonly publish: ReturnType<typeof vi.fn>
  readonly retract: ReturnType<typeof vi.fn>
  readonly api: { readonly streamBroker: AlexaStreamBrokerApi }
}

function broker(over: { releaseRefcount?: number } = {}): BrokerCalls {
  const acquire = vi.fn().mockResolvedValue({
    url: 'rtsp://127.0.0.1:8554/tok-abc',
    pipelineKey: 'egress:deadbeef',
    videoCodec: 'H264',
    resolution: { width: 1280, height: 720 },
    transcoded: true,
    encoder: 'libx264',
    decodeHwAccel: 'vaapi',
    // The BROKER names and publishes the stream now; the caller only reads it.
    camStreamId: 'egress:deadbeef',
  })
  const release = vi.fn().mockResolvedValue({ released: true, refcount: over.releaseRefcount ?? 0 })
  const publish = vi.fn().mockResolvedValue({ success: true })
  const retract = vi.fn().mockResolvedValue({ success: true })
  return {
    acquire,
    release,
    publish,
    retract,
    api: {
      streamBroker: {
        acquireEgressTranscode: { mutate: acquire },
        releaseEgressTranscode: { mutate: release },
        publishCameraStream: { mutate: publish },
        retractCameraStream: { mutate: retract },
      } as unknown as AlexaStreamBrokerApi,
    },
  }
}

describe('acquireAlexaEgress — it goes through the primitive, not the derived mechanism', () => {
  it('acquires an egress transcode instead of publishing a derived stream', async () => {
    const b = broker()
    await acquireAlexaEgress({ api: b.api, deviceId: 101, sourceProfile: 'high', sessionId: 's1' })

    expect(b.acquire).toHaveBeenCalledTimes(1)
    const request = b.acquire.mock.calls[0]![0] as Record<string, unknown>
    expect(request['deviceId']).toBe(101)
    expect(request['source']).toEqual({ kind: 'profile', profile: 'high' })
    expect(request['encode']).toEqual(ALEXA_EGRESS_PROFILE)

    // The derived mechanism is NOT used for Alexa's own egress any more. It
    // still exists for everything else — this only asserts Alexa stopped
    // reaching for it.
    for (const call of b.publish.mock.calls) {
      expect((call[0] as Record<string, unknown>)['kind']).not.toBe('derived')
    }
  })

  it('carries a session tag for the broker panel and NEVER lets it fork the child', async () => {
    // `tag` is attribution only. Two Echoes on one camera with identical
    // parameters must reach ONE ffmpeg; a tag in the sharing key would give
    // them one process each.
    const b = broker()
    await acquireAlexaEgress({ api: b.api, deviceId: 101, sourceProfile: 'high', sessionId: 's1' })
    await acquireAlexaEgress({ api: b.api, deviceId: 101, sourceProfile: 'high', sessionId: 's2' })

    const [first, second] = b.acquire.mock.calls.map((c) => c[0] as Record<string, unknown>)
    expect(first!['tag']).not.toBe(second!['tag'])
    // Everything the sharing key reads is identical, so the broker dedups.
    expect({ ...first, tag: undefined }).toEqual({ ...second, tag: undefined })
  })

  it('derives the camStream id from the SHARING KEY, so two identical sessions share it', async () => {
    // The old id hashed the ENCODE PROFILE into a name that outlived every
    // session. This one is the broker's own handle, and it is retracted when
    // the last holder releases.
    const b = broker()
    const a = await acquireAlexaEgress({
      api: b.api,
      deviceId: 101,
      sourceProfile: 'high',
      sessionId: 's1',
    })
    const c = await acquireAlexaEgress({
      api: b.api,
      deviceId: 101,
      sourceProfile: 'high',
      sessionId: 's2',
    })
    expect(a.camStreamId).toBe(c.camStreamId)
    expect(a.camStreamId).toBe('egress:deadbeef')
    expect(a.camStreamId).not.toMatch(/^derived:/)
  })

  it('asks the BROKER to publish locally, and publishes nothing itself', async () => {
    // Dialling the returned url made the stream an RTP source, which routed the
    // session down the RTP-passthrough branch — broker registered, RTP
    // arriving, key frame arriving, black screen. `publishLocally` puts it on
    // the push/deframe transport the derived mechanism rendered on, and the
    // broker owns the publish so the id cannot disagree with the sharing key.
    const b = broker()
    await acquireAlexaEgress({ api: b.api, deviceId: 101, sourceProfile: 'high', sessionId: 's1' })

    const request = b.acquire.mock.calls[0]![0] as Record<string, unknown>
    expect(request['publishLocally']).toBe(true)
    expect(b.publish).not.toHaveBeenCalled()
  })

  it('REFUSES the handle when the broker declined to publish', async () => {
    // A null camStreamId means the only way in is the url, which is the
    // transport that does not render. Releasing beats handing back a handle
    // that will show black — and leaking the ffmpeg behind it.
    const b = broker()
    b.acquire.mockResolvedValueOnce({
      url: 'rtsp://127.0.0.1:8554/tok-abc',
      pipelineKey: 'egress:deadbeef',
      videoCodec: 'H264',
      resolution: { width: 1280, height: 720 },
      transcoded: true,
      encoder: 'libx264',
      decodeHwAccel: null,
      camStreamId: null,
    })
    await expect(
      acquireAlexaEgress({ api: b.api, deviceId: 101, sourceProfile: 'high', sessionId: 's1' }),
    ).rejects.toThrow(/publish/i)
    expect(b.release).toHaveBeenCalledWith({ pipelineKey: 'egress:deadbeef' })
  })

  it('releases the handle and retracts the stream when the LAST holder goes', async () => {
    const b = broker({ releaseRefcount: 0 })
    await releaseAlexaEgress({
      api: b.api,
      deviceId: 101,
      pipelineKey: 'egress:deadbeef',
    })
    expect(b.release).toHaveBeenCalledWith({ pipelineKey: 'egress:deadbeef' })
    // Retraction belongs to the broker: its push sink retracts when the last
    // holder releases. Doing it here as well races that teardown and can pull a
    // stream another holder is still watching.
    expect(b.retract).not.toHaveBeenCalled()
  })

  it('leaves the stream published while another session still holds it', async () => {
    const b = broker({ releaseRefcount: 1 })
    await releaseAlexaEgress({ api: b.api, deviceId: 101, pipelineKey: 'egress:deadbeef' })
    expect(b.retract).not.toHaveBeenCalled()
  })

  it('never throws on a stale handle — a disconnect must still be acked', async () => {
    // Alexa expects a `Alexa.Response` to `SessionDisconnected`. A release that
    // throws would turn a normal teardown into an error envelope.
    const b = broker()
    b.release.mockRejectedValueOnce(new Error('unknown handle'))
    await expect(
      releaseAlexaEgress({ api: b.api, deviceId: 101, pipelineKey: 'egress:gone' }),
    ).resolves.toBeUndefined()
  })
})

/**
 * The five-slice access unit, and why Alexa's encode leaves it behind.
 *
 * Measured on the hub 2026-09-13, on the exact argv this path spawns: EVERY
 * access unit came out as FIVE slices — `AUD + SPS + PPS + SEI + IDR×5`, then
 * `AUD + SLICE×5` for every P-frame. The same argv with `sliced-threads=0`
 * produces one. The source is `-tune zerolatency`, which turns on x264's
 * sliced threads.
 *
 * Five slices share ONE RTP timestamp and carry ONE marker bit, so a
 * libwebrtc depacketiser sees five frame-starts and one frame-end per access
 * unit. This file's own history records the sibling symptom — Chrome sitting
 * at `framesDecoded=0` on the transcode branch — and the Echo shows the same
 * shape: the first pictures render, then the video freezes permanently while
 * the audio, on its own plane, plays on.
 *
 * It is the only structural property that survived the elimination: the fault
 * reproduced identically at 2304×1296 HEVC→H.264 with 217 KB keyframes AND at
 * 640×360 H.264→H.264 with 67 KB keyframes and a fifth of the bitrate. Source,
 * resolution, bitrate, keyframe burst, VAAPI, parameter-set presence, drift and
 * bitstream conformance were all ruled out by measurement first.
 */
describe('the Alexa encode emits ONE slice per access unit', () => {
  it('asks for ONE slice per frame by NAME, not through a raw flag', () => {
    // The first attempt put `-x264-params sliced-threads=0` in the profile's
    // `outputArgs`, and `EgressEncodeSchema` omits those on purpose (D67): the
    // flag never reached ffmpeg, and reading the live argv on the hub is what
    // proved it. A named field crosses that boundary, and it is part of the
    // sharing key, so a consumer that wants one slice does not silently share a
    // child with one that does not. The argv itself is pinned in
    // `types/src/__tests__/ffmpeg-invocation.spec.ts`.
    expect(ALEXA_EGRESS_PROFILE.video.singleSlicePerFrame).toBe(true)
    expect(ALEXA_EGRESS_PROFILE.outputArgs).toBeUndefined()
  })

  it('keeps zerolatency — only the SLICING is unwanted', () => {
    // `-tune zerolatency` also drops the lookahead and the B-frames, which a
    // live path wants. Dropping the tune wholesale to lose the slices would
    // pay for one fix with two regressions.
    expect(ALEXA_EGRESS_PROFILE.video.tune).toBe('zerolatency')
  })

  it('does NOT move the profile every other consumer derives from', () => {
    // HomeKit and the browser transcode both inherit `BASE_LIVE_EGRESS_PROFILE`.
    // Whether they want the same change is a question for their own evidence —
    // the browser has not been measured yet.
    expect(BASE_LIVE_EGRESS_PROFILE.outputArgs).toBeUndefined()
    expect(BASE_LIVE_EGRESS_PROFILE.video.singleSlicePerFrame).toBeUndefined()
  })
})
