/**
 * The argv of the PERMANENT prebuffer child — copy branch and encode branch.
 *
 * ## Why this is a module and not a private method
 *
 * The difference between these two branches is 0.7 % of a core and most of one,
 * per camera, for ever. A decision at that price is asserted on the ARGUMENTS,
 * not inferred from a child that happens to start: this repo has already
 * shipped a remux that was green in every test and refused by ffmpeg on every
 * live clip, because the fake accepted what the binary would not (D578).
 */
import type { FfmpegVideoEncodePlan } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import { buildRecordingInvocation, recordingOutput } from '../recording-invocation.js'
import { MAX_RECORDING_HEIGHT, type RecordingSource } from '../recording-source.js'

const COPY: RecordingSource = {
  brokerId: '101/mid',
  profile: 'mid',
  transcode: false,
  url: 'rtsp://hub/mid',
  mutedUrl: 'rtsp://hub/mid/muted',
  width: 1280,
  height: 720,
}

const TRANSCODE: RecordingSource = { ...COPY, transcode: true, brokerId: '587/mid' }

const build = (source: RecordingSource, over: Record<string, unknown> = {}) =>
  buildRecordingInvocation({
    source,
    audioActive: true,
    fragmentMs: 4000,
    decodeHwAccel: null,
    ...over,
  })

describe('recordingOutput', () => {
  it('is the source resolution on a copy — there is no encoder to resize with', () => {
    expect(recordingOutput(COPY)).toEqual({ width: 1280, height: 720, scaled: false })
  })

  it('is the source resolution on a transcode already within the ceiling', () => {
    expect(recordingOutput(TRANSCODE)).toEqual({ width: 1280, height: 720, scaled: false })
  })

  it('fits an oversized transcode to the ceiling, keeping the aspect and even dimensions', () => {
    const out = recordingOutput({ ...TRANSCODE, width: 3840, height: 2160 })
    expect(out).toEqual({ width: 1920, height: MAX_RECORDING_HEIGHT, scaled: true })
  })

  it('does NOT resize an oversized COPY — the advertisement would then be a lie', () => {
    // A 4K copy is advertised at 4K and costs the big fragment. That is the
    // deal on the copy branch; pretending otherwise is the defect that kept
    // HomeKit black for a year — a stream that does not match its own SDP.
    expect(recordingOutput({ ...COPY, width: 3840, height: 2160 })).toEqual({
      width: 3840,
      height: 2160,
      scaled: false,
    })
  })
})

describe('buildRecordingInvocation — copy branch', () => {
  it('copies the video and asks for no decoder at all', () => {
    const inv = build(COPY)
    expect(inv.video).toEqual({ kind: 'copy' })
    // A copy that asked for -hwaccel pays a device init for a pipeline that
    // never touches a frame; on this hub that init killed the push transport.
    expect(inv.decodeHwAccel).toBeNull()
  })

  it('ignores a hwaccel backend offered to a copy', () => {
    expect(build(COPY, { decodeHwAccel: 'vaapi' }).decodeHwAccel).toBeNull()
  })
})

describe('buildRecordingInvocation — encode branch', () => {
  const plan = (source: RecordingSource, over: Record<string, unknown> = {}) => {
    const video = build(source, over).video
    if (video.kind !== 'encode') throw new Error(`expected an encode plan, got ${video.kind}`)
    return video satisfies FfmpegVideoEncodePlan
  }

  it('encodes H.264 that HomeKit will accept', () => {
    const video = plan(TRANSCODE)
    expect(video.encoder).toBe('libx264')
    // Within what `buildRecordingOptions` advertises (BASELINE/MAIN/HIGH,
    // 3.1/3.2/4.0). An encode outside its own advertisement is the defect.
    expect(video.profile).toBe('main')
    expect(video.level).toBe('4.0')
    expect(video.pixelFormat).toBe('yuv420p')
  })

  it('pins the key-frame cadence to the FRAGMENT length', () => {
    // An fMP4 fragment written with `frag_keyframe` is cut at a key frame, so
    // the IDR cadence IS the fragment cadence. Left to the source, a camera
    // with a 10 s GOP would produce 10 s fragments against a 4 s promise.
    expect(plan(TRANSCODE, { fragmentMs: 4000 }).forceKeyFramesSeconds).toBe(4)
    expect(plan(TRANSCODE, { fragmentMs: 2000 }).forceKeyFramesSeconds).toBe(2)
  })

  it('carries no B-frames — HKSV fragments are decoded in order', () => {
    expect(plan(TRANSCODE).bf).toBe(0)
  })

  it('scales only when the source is above the ceiling', () => {
    expect(plan(TRANSCODE).scale ?? null).toBeNull()
    expect(plan({ ...TRANSCODE, width: 3840, height: 2160 }).scale).toEqual({
      mode: 'fit',
      width: 1920,
      height: MAX_RECORDING_HEIGHT,
    })
  })

  it('carries the render node beside the backend — a backend without it dies at init', () => {
    const inv = build(TRANSCODE, {
      decodeHwAccel: 'vaapi',
      decodeInputArgs: ['-hwaccel_device', '/dev/dri/renderD128'],
    })
    expect(inv.input.extraArgs).toEqual(['-hwaccel_device', '/dev/dri/renderD128'])
    // …and never on a copy, which emits no `-hwaccel` to pair them with.
    expect(
      build(COPY, {
        decodeHwAccel: 'vaapi',
        decodeInputArgs: ['-hwaccel_device', '/dev/dri/renderD128'],
      }).input.extraArgs ?? null,
    ).toBeNull()
  })

  it('accepts a hardware DECODER, which is the expensive half of the transcode', () => {
    // Measured on the live path: a 4K→1080p session was 77 % of one core,
    // dominated by decode. The encoder stays libx264 deliberately — two of the
    // four causes of the year-long HomeKit failure lived on the encoder.
    expect(build(TRANSCODE, { decodeHwAccel: 'vaapi' }).decodeHwAccel).toBe('vaapi')
    expect(plan(TRANSCODE, { decodeHwAccel: 'vaapi' }).encoder).toBe('libx264')
  })
})

describe('buildRecordingInvocation — shared', () => {
  it('reads the muted url when iOS turned recording audio off', () => {
    expect(build(COPY, { audioActive: false }).input.url).toBe('rtsp://hub/mid/muted')
    expect(build(COPY, { audioActive: true }).input.url).toBe('rtsp://hub/mid')
  })

  it('drops the audio plane entirely when audio is off', () => {
    expect(build(TRANSCODE, { audioActive: false }).audio).toEqual({ kind: 'none' })
    expect(build(TRANSCODE, { audioActive: true }).audio.kind).toBe('encode')
  })
})
