/**
 * HomeKit's ffmpeg argument vector, pinned across the move behind the shared
 * primitive.
 *
 * ## Why a whole file for this
 *
 * HomeKit works now, after a year of black tiles, and **two of the four fixes
 * live in this argv**:
 *
 *  - a forced `-g`. x264's own default is 250 frames; at the 10 fps we dial for
 *    a 720p slot that is ONE IDR EVERY 25 SECONDS, and a controller joining
 *    mid-GOP receives every packet intact with nothing to start decoding from.
 *  - `-bsf:v dump_extra`. ffmpeg's RTP muxer declares `AVFMT_GLOBALHEADER`, so
 *    libx264 puts SPS/PPS in extradata instead of ahead of each IDR. They would
 *    then travel only in an SDP, which HAP does not carry — it negotiates its
 *    own.
 *
 * Either one missing and the stream goes black again, silently: no error, no
 * exit, no missing packet, just a loader on screen and a teardown at ~30 s.
 * Both are therefore asserted BY TOKEN **and BY POSITION**, on both the encode
 * and the copy branch.
 *
 * ## What this file is allowed to assert, and what it is not
 *
 * The migration moves argument EMISSION from a hand-rolled vector in
 * `stream-ffmpeg-args.ts` to `buildFfmpegArgs` in `@camstack/types` (D67, Rule
 * 1 of `scripts/check-ffmpeg-primitive.ts`). The shared builder emits the video
 * encode block in ITS order, so a literal whole-argv golden could not survive
 * the move and would have to be rewritten — which is exactly the kind of
 * "update the expectation" edit that lets a real regression through.
 *
 * So the file splits the vector at the two seams that are STABLE by contract:
 *
 *  - everything up to and including `-i <url>` — the INPUT half, where
 *    `-hwaccel` has to live (ffmpeg accepts it after `-i` without error and
 *    then decodes in software anyway);
 *  - the audio leg, from `-vn` to the end — byte-identical before and after,
 *    because the shared `buildAudioArgs` emits exactly HomeKit's order;
 *
 * and asserts the video block by CONTENT (every flag, every value) plus the two
 * load-bearing positions. The one deliberate substitution — `-s WxH` becoming
 * `-vf scale=W:H` — is named explicitly here so it cannot happen a second time
 * unnoticed.
 */

import { buildFfmpegArgs } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import { buildVideoPlan } from '../stream-bitrate.js'
import { buildSessionInvocation, type SessionInvocationInput } from '../stream-ffmpeg-args.js'
import { selectHwDecode } from '../stream-hwaccel.js'

/**
 * The one seam this spec goes through. Before the migration this called
 * `buildSessionFfmpegArgs` directly; after it, HomeKit builds a PLAN and the
 * shared builder emits the arguments. The assertions below did not change.
 */
function argv(input: SessionInvocationInput): readonly string[] {
  return buildFfmpegArgs(buildSessionInvocation(input))
}

const VIDEO_TARGET = 'rtp://127.0.0.1:40001?pkt_size=1378'
const AUDIO_TARGET = 'rtp://127.0.0.1:40003?pkt_size=1378'
const RTSP_URL = 'rtsp://127.0.0.1:8554/tok'

const VAAPI = selectHwDecode({
  transcode: true,
  reading: { hwaccel: 'auto', probedBestHwaccel: 'vaapi' },
  platform: 'linux',
})

const SOFTWARE = selectHwDecode({ transcode: true, reading: null, platform: 'linux' })

function session(over: Partial<SessionInvocationInput> = {}): SessionInvocationInput {
  return {
    decode: SOFTWARE,
    rtspUrl: RTSP_URL,
    video: buildVideoPlan({ transcode: true, width: 1280, height: 720, fps: 10, budgetKbps: 802 }),
    videoTarget: VIDEO_TARGET,
    audioTarget: AUDIO_TARGET,
    videoPayloadType: 99,
    videoSsrcSigned: -12345,
    audioPayloadType: 110,
    audioSsrcSigned: 67890,
    audioPacketTimeMs: 30,
    audioSampleRateKhz: 16,
    ...over,
  }
}

/** The vector up to and including `-i <url>` — the INPUT half. */
function inputHalf(args: readonly string[]): readonly string[] {
  return args.slice(0, args.indexOf('-i') + 2)
}

/** The audio leg: `-vn` to the end. */
function audioLeg(args: readonly string[]): readonly string[] {
  return args.slice(args.indexOf('-vn'))
}

/** The video leg: `-an` up to (not including) `-vn`. */
function videoLeg(args: readonly string[]): readonly string[] {
  return args.slice(args.indexOf('-an'), args.indexOf('-vn'))
}

describe('HomeKit argv — the two flags that were load-bearing', () => {
  it('forces -g on the encode branch, after -i, with the four-second value', () => {
    // 10 fps × 4 s. Not a frame count: derived from the rate we ACTUALLY
    // deliver so the wall-clock interval is constant across slots.
    const args = argv(session())
    const g = args.indexOf('-g')
    expect(g).toBeGreaterThan(-1)
    // POSITION: `-g` is an OUTPUT option. Before `-i` it configures nothing.
    expect(g).toBeGreaterThan(args.indexOf('-i'))
    // ...and inside the VIDEO leg, not the audio one.
    expect(g).toBeLessThan(args.indexOf('-vn'))
    // VALUE.
    expect(args[g + 1]).toBe('40')
  })

  it('scales -g with the delivered rate, never with a fixed frame count', () => {
    const at15 = argv(
      session({
        video: buildVideoPlan({
          transcode: true,
          width: 1280,
          height: 720,
          fps: 15,
          budgetKbps: 802,
        }),
      }),
    )
    expect(at15[at15.indexOf('-g') + 1]).toBe('60')
  })

  it('pins ONE encoder thread in the VIDEO leg — the frame-threading delay (D515)', () => {
    // `sliced-threads=0` alone hands x264 its auto thread count (30 on the
    // 20-core hub) as FRAME threads, and frame threading delays output by
    // threads − 1 frames: measured on the live hub as the first packet
    // leaving ~3 s later at 10 fps. One thread is plenty for a 720p
    // `ultrafast` encode and was measured with no start-up delay.
    const args = argv(session())
    const t = args.indexOf('-threads')
    expect(t).toBeGreaterThan(args.indexOf('-i'))
    expect(t).toBeLessThan(args.indexOf('-vn'))
    expect(args[t + 1]).toBe('1')
    const x = args.indexOf('-x264-params')
    expect(x).toBeGreaterThan(args.indexOf('-i'))
    expect(x).toBeLessThan(args.indexOf('-vn'))
    expect(args[x + 1]).toBe('sliced-threads=0')
  })

  it('pins NO encoder thread on the COPY branch — there is no encoder to pin', () => {
    const args = argv(
      session({
        video: buildVideoPlan({
          transcode: false,
          width: 1280,
          height: 720,
          fps: 10,
          budgetKbps: 802,
        }),
      }),
    )
    expect(args).not.toContain('-threads')
    expect(args).not.toContain('-x264-params')
  })

  it('emits -bsf:v dump_extra on the ENCODE branch, in the video leg', () => {
    const args = argv(session())
    const bsf = args.indexOf('-bsf:v')
    expect(bsf).toBeGreaterThan(-1)
    expect(args[bsf + 1]).toBe('dump_extra')
    // POSITION: after `-i`, before the RTP sink that terminates the video leg,
    // and never in the audio leg (which has no video bitstream to filter).
    expect(bsf).toBeGreaterThan(args.indexOf('-i'))
    expect(bsf).toBeLessThan(args.indexOf('-f'))
    expect(bsf).toBeLessThan(args.indexOf('-vn'))
  })

  it('emits -bsf:v dump_extra on the COPY branch too', () => {
    // The copy branch needs it for a different mechanism — a source that
    // publishes its parameter sets only in the RTSP SDP hands iOS a keyframe it
    // cannot decode. Same flag, same position, different reason.
    const args = argv(
      session({
        video: buildVideoPlan({
          transcode: false,
          width: 1920,
          height: 1080,
          fps: 15,
          budgetKbps: 1200,
        }),
      }),
    )
    const bsf = args.indexOf('-bsf:v')
    expect(args[bsf + 1]).toBe('dump_extra')
    expect(videoLeg(args)).toEqual([
      '-an',
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-bsf:v',
      'dump_extra',
      '-payload_type',
      '99',
      '-ssrc',
      '-12345',
      '-f',
      'rtp',
      VIDEO_TARGET,
    ])
  })
})

describe('HomeKit argv — the input probe bound, asserted BY INDEX', () => {
  /**
   * `-analyzeduration 200000 -probesize 65536` took first-key-frame from 12.2 s
   * to 1.3 s on 101/mid (a 9 fps slot), and until now the only thing holding
   * them was the whole-array equality below. That equality is what a migration
   * REWRITES — "the builder emits a different order now, update the
   * expectation" — and the pair would go with it, silently, with the symptom
   * being a loader on screen: identical to the year-long failure.
   *
   * So they get their own assertions, and the assertion is INDEX-RELATIVE for
   * the same reason `-hwaccel`'s is (D67): both are ffmpeg INPUT options, both
   * are accepted after `-i` without any error, and both then configure nothing.
   * A probe bound that lands after `-i` restores ffmpeg's 5 s / 5 MB default
   * while every token this file used to check is still present.
   */
  function assertProbeBeforeInput(args: readonly string[]): void {
    const i = args.indexOf('-i')
    const analyze = args.indexOf('-analyzeduration')
    const probe = args.indexOf('-probesize')
    expect(analyze).toBeGreaterThan(-1)
    expect(probe).toBeGreaterThan(-1)
    // POSITION — the whole point.
    expect(analyze).toBeLessThan(i)
    expect(probe).toBeLessThan(i)
    // VALUE. 200 ms and 64 KiB, in the units ffmpeg takes them (µs and bytes).
    expect(args[analyze + 1]).toBe('200000')
    expect(args[probe + 1]).toBe('65536')
  }

  it('pins the probe bound before -i on the ENCODE branch', () => {
    assertProbeBeforeInput(argv(session()))
  })

  it('pins the probe bound before -i on the COPY branch', () => {
    // The copy branch is where the 12.2 s was measured: a pass-through session
    // cannot ask its camera for a key frame, so every millisecond ffmpeg spends
    // probing is added to a wait it can do nothing about.
    assertProbeBeforeInput(
      argv(
        session({
          video: buildVideoPlan({
            transcode: false,
            width: 1920,
            height: 1080,
            fps: 15,
            budgetKbps: 1200,
          }),
        }),
      ),
    )
  })

  it('keeps the probe bound before -i when hardware decode adds input options', () => {
    // `-hwaccel` + `-hwaccel_device` are inserted into the same input half.
    // An insertion that pushed the probe pair past `-i` would leave every token
    // present and every value right.
    assertProbeBeforeInput(argv(session({ decode: VAAPI })))
  })
})

describe('HomeKit argv — the halves that are byte-identical to the pre-migration vector', () => {
  it('pins the INPUT half with hardware decode', () => {
    // `-hwaccel` and its render node travel together, both strictly before
    // `-i`. ffmpeg accepts them after `-i` without any error and then decodes
    // in software: the CPU cost stays and the log still says hardware.
    expect(inputHalf(argv(session({ decode: VAAPI })))).toEqual([
      '-hide_banner',
      '-loglevel',
      'warning',
      '-hwaccel',
      'vaapi',
      '-hwaccel_device',
      '/dev/dri/renderD128',
      '-analyzeduration',
      '200000',
      '-probesize',
      '65536',
      '-rtsp_transport',
      'tcp',
      '-i',
      RTSP_URL,
    ])
  })

  it('pins the INPUT half with software decode', () => {
    // The probe bound is pinned here on purpose: ffmpeg's default inspects the
    // input for up to 5 s before emitting, and on a 9 fps slot that measured
    // 9 s to the first packet and 12.2 s to the first key frame — a loader on
    // screen for the whole of it. Losing these two silently brings that back.
    expect(inputHalf(argv(session()))).toEqual([
      '-hide_banner',
      '-loglevel',
      'warning',
      '-analyzeduration',
      '200000',
      '-probesize',
      '65536',
      '-rtsp_transport',
      'tcp',
      '-i',
      RTSP_URL,
    ])
  })

  it('pins the whole AUDIO leg', () => {
    // Every value here was learned the expensive way — the resampler that stops
    // libopus seeing the broker's PTS jitter as "input backward in time", the
    // negotiated sample rate (a hardcoded one slides the RTP timestamps out of
    // iOS's AV-sync window and the speaker stays mute), the global header, the
    // 1:1 frame↔packet mapping. The shared `buildAudioArgs` emits exactly this
    // order, so this leg did not move a byte.
    expect(audioLeg(argv(session()))).toEqual([
      '-vn',
      '-map',
      '0:a:0?',
      '-af',
      'aresample=async=1000:first_pts=0',
      '-c:a',
      'libopus',
      '-application',
      'lowdelay',
      '-frame_duration',
      '30',
      '-flags',
      '+global_header',
      '-ar',
      '16000',
      '-b:a',
      '24k',
      '-bufsize',
      '96k',
      '-ac',
      '1',
      '-payload_type',
      '110',
      '-ssrc',
      '67890',
      '-f',
      'rtp',
      AUDIO_TARGET,
    ])
  })

  it('sends audio at the sample rate iOS negotiated, not a constant', () => {
    const args = argv(session({ audioSampleRateKhz: 24, audioPacketTimeMs: 20 }))
    expect(args[args.indexOf('-ar') + 1]).toBe('24000')
    expect(args[args.indexOf('-frame_duration') + 1]).toBe('20')
  })
})

describe('HomeKit argv — the video encode block, flag by flag', () => {
  /**
   * `{flag: value}` for every `-flag value` pair in a leg. A value that itself
   * starts with `-` still counts when it is a NUMBER — `-ssrc -12345` is the
   * signed-int32 coercion iOS forces on us, and dropping it here would make
   * this assertion silently blind to the one flag ffmpeg rejects outright.
   */
  function pairs(args: readonly string[]): Record<string, string> {
    const isValue = (v: string | undefined): v is string =>
      v !== undefined && (!v.startsWith('-') || Number.isFinite(Number(v)))
    const out: Record<string, string> = {}
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i]
      const b = args[i + 1]
      if (a !== undefined && a.startsWith('-') && isValue(b)) {
        out[a] = b
        i += 1
      }
    }
    return out
  }

  it('carries every encode flag the pre-migration vector carried, at the same value', () => {
    // The shared builder emits `-profile:v` / `-level` earlier in the block
    // than the hand-rolled vector did. ffmpeg does not care about the order of
    // output options within one output, so the assertion is on CONTENT — but
    // a DROPPED flag or a changed value still fails here.
    expect(pairs(videoLeg(argv(session({ decode: VAAPI }))))).toEqual({
      '-map': '0:v:0',
      '-c:v': 'libx264',
      '-preset': 'ultrafast',
      '-tune': 'zerolatency',
      // ONE slice per access unit, and ONE encoder thread so that asking for
      // it does not buy x264's frame-threading delay instead (D515).
      '-x264-params': 'sliced-threads=0',
      '-threads': '1',
      '-pix_fmt': 'yuv420p',
      '-r': '10',
      '-g': '40',
      '-b:v': '802k',
      '-maxrate': '802k',
      '-bufsize': '802k',
      '-profile:v': 'baseline',
      '-level': '3.1',
      '-bsf:v': 'dump_extra',
      '-payload_type': '99',
      '-ssrc': '-12345',
      '-f': 'rtp',
      // `-vf scale=W:H` REPLACES the pre-migration `-s WxH`. Equivalent for a
      // plain rescale, and named here because the two are NOT identical once
      // another `-vf` is in play — a future filter must compose, not collide.
      '-vf': 'scale=1280:720',
    })
  })

  it('bounds the one-second VBV window, which is what sizes a key frame', () => {
    // `-b:v` alone is an average and permits exactly the burst the controller
    // reported losing. `-bufsize` at ONE second of the budget (not two) is the
    // lever that forces x264 to size an IDR to fit.
    const args = argv(session())
    const budget = '802k'
    expect(args[args.indexOf('-b:v') + 1]).toBe(budget)
    expect(args[args.indexOf('-maxrate') + 1]).toBe(budget)
    // `-bufsize` appears on both planes; the VIDEO one is the first.
    expect(videoLeg(args)[videoLeg(args).indexOf('-bufsize') + 1]).toBe(budget)
  })

  it('omits rate control entirely when there is no budget', () => {
    const args = argv(
      session({
        video: buildVideoPlan({
          transcode: true,
          width: 1280,
          height: 720,
          fps: 10,
          budgetKbps: null,
        }),
      }),
    )
    const leg = videoLeg(args)
    expect(leg).not.toContain('-b:v')
    expect(leg).not.toContain('-maxrate')
    expect(leg).not.toContain('-bufsize')
    // ...and the two load-bearing flags survive its absence.
    expect(leg[leg.indexOf('-g') + 1]).toBe('40')
    expect(leg[leg.indexOf('-bsf:v') + 1]).toBe('dump_extra')
  })

  it('never lets -ssrc carry a value ffmpeg would reject', () => {
    const args = argv(session())
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] !== '-ssrc') continue
      const value = Number(args[i + 1])
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeLessThanOrEqual(2_147_483_647)
      expect(value).toBeGreaterThanOrEqual(-2_147_483_648)
    }
  })

  it('is the SOFTWARE vector plus the decode flags, and identical otherwise', () => {
    // The software retry re-runs the SAME plan with the decode decision
    // swapped. A retry that also dropped `-bsf:v dump_extra` would "work" and
    // produce a stream iOS cannot decode.
    const hardware = argv(session({ decode: VAAPI }))
    const software = argv(session())
    expect(hardware.slice(hardware.indexOf('-i'))).toEqual(software.slice(software.indexOf('-i')))
    expect(hardware).toHaveLength(software.length + 4)
  })
})
