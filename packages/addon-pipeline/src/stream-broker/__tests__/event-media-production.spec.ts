/**
 * The three gates an event production rests on.
 *
 * Each of them is a defect the operator actually received on 2026-08-08 — a
 * notification whose gif was cut from a 640×360 substream and re-encoded to
 * 480 px, beside a video of a different six seconds. So they are written as the
 * things that must not come back: the cheapest rendition being chosen, a copy
 * silently becoming a re-encode, and a produced artifact evaporating before the
 * consumer in the other runner can fetch it.
 */

import type { EncodedPacket } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { EventMediaStore } from '../stream-broker/event-media-store.js'
import {
  GIF_FPS,
  GIF_MAX_WIDTH,
  GIF_SPEED,
  gifDeriveSpeed,
  gifFilterComplex,
} from '../stream-broker/gif-from-mp4.js'
import {
  type ClipProfileCandidate,
  clipCanCopy,
  clipFfmpegArgs,
  EVENT_CLIP_ENCODE_MAX_WIDTH,
  EVENT_CLIP_MAX_HEIGHT,
  eventClipEncodeWidth,
  pickBestClipProfile,
  windowCoverage,
} from '../stream-broker/prebuffer-clip.js'

function candidate(over: Partial<ClipProfileCandidate> & { profile: 'high' | 'mid' | 'low' }) {
  return { codec: 'h264', width: 1280, height: 720, ...over }
}

describe('pickBestClipProfile', () => {
  it('prefers the LARGEST H.264 rendition at or below 1080p — not the cheapest', () => {
    // 101's real ladder. The old default took `low` and that is the whole
    // "de-pixellated gif" report.
    expect(
      pickBestClipProfile([
        candidate({ profile: 'high', width: 3840, height: 2160 }),
        candidate({ profile: 'mid', width: 1280, height: 720 }),
        candidate({ profile: 'low', width: 640, height: 360 }),
      ]),
    ).toBe('mid')
  })

  it('refuses an H.265 slot — the production copies and never transcodes', () => {
    expect(
      pickBestClipProfile([
        candidate({ profile: 'high', codec: 'h265', width: 3840, height: 2160 }),
        candidate({ profile: 'mid', codec: 'HEVC', width: 1280, height: 720 }),
      ]),
    ).toBeNull()
  })

  it('falls back to the SMALLEST slot above the ceiling when nothing fits under it', () => {
    expect(
      pickBestClipProfile([
        candidate({ profile: 'high', width: 3840, height: 2160 }),
        candidate({ profile: 'mid', width: 2560, height: 1440 }),
      ]),
    ).toBe('mid')
    expect(EVENT_CLIP_MAX_HEIGHT).toBe(1080)
  })

  it('ignores a slot that publishes no resolution — nothing could be sized', () => {
    expect(
      pickBestClipProfile([
        { profile: 'mid', codec: 'h264' },
        candidate({ profile: 'low', width: 640, height: 360 }),
      ]),
    ).toBe('low')
  })
})

describe('clipCanCopy', () => {
  const base = { format: 'mp4', maxWidth: 1280, speed: 1, hevc: false, sourceWidth: 1280 } as const

  it('copies when the geometry is an identity and the rate is real time', () => {
    expect(clipCanCopy(base)).toBe(true)
  })

  it('re-encodes for a DOWNSCALE — a scale filter forces the decode', () => {
    expect(clipCanCopy({ ...base, maxWidth: 640 })).toBe(false)
  })

  it('re-encodes for any playback rate other than 1 — setpts rewrites the timeline', () => {
    expect(clipCanCopy({ ...base, speed: 2 })).toBe(false)
  })

  it('re-encodes H.265 on purpose: an mp4 attachment has to play on a phone', () => {
    expect(clipCanCopy({ ...base, hevc: true })).toBe(false)
  })

  it('re-encodes when the source width is UNKNOWN rather than guessing', () => {
    expect(clipCanCopy({ ...base, sourceWidth: 0 })).toBe(false)
  })

  it('never copies a gif', () => {
    expect(clipCanCopy({ ...base, format: 'gif' })).toBe(false)
  })
})

describe('eventClipEncodeWidth', () => {
  it('keeps the source width at real time — an identity scale is what lets it COPY', () => {
    expect(eventClipEncodeWidth(1920, 1)).toBe(1920)
    expect(eventClipEncodeWidth(1280, 1)).toBe(1280)
  })

  it('caps a re-encode at 720p — the speed already forced the decode, so pay less for it', () => {
    // A speed other than real time means libx264 whatever the width, so the
    // width stops being free. Measured on a real 101 window: 720p crf 23 is
    // 254 KB against the 922 KB the copy carried, and 0.23 s of encode.
    expect(eventClipEncodeWidth(1920, 4)).toBe(EVENT_CLIP_ENCODE_MAX_WIDTH)
    expect(EVENT_CLIP_ENCODE_MAX_WIDTH).toBe(1280)
  })

  it('never UPSCALES a small rendition to the cap', () => {
    expect(eventClipEncodeWidth(640, 4)).toBe(640)
  })

  it('never returns zero — an unknown source width still has to render something', () => {
    expect(eventClipEncodeWidth(0, 4)).toBeGreaterThan(0)
    expect(eventClipEncodeWidth(0, 1)).toBeGreaterThan(0)
  })
})

describe('clipFfmpegArgs on the copy branch', () => {
  it('emits `-c:v copy` and NO filter graph — a filter would force a decode', () => {
    const args = clipFfmpegArgs({ format: 'mp4', maxWidth: 1280, fps: 0, copyVideo: true })
    expect(args).toContain('copy')
    expect(args).not.toContain('-vf')
    expect(args.join(' ')).not.toContain('scale=')
    expect(args).not.toContain('libx264')
  })

  it('still re-encodes when the caller did not authorise a copy', () => {
    const args = clipFfmpegArgs({ format: 'mp4', maxWidth: 480, fps: 5 })
    expect(args).toContain('libx264')
    expect(args.join(' ')).toContain('scale=480')
  })

  it('encodes a NOTIFICATION clip, not an archive — veryfast at crf 23', () => {
    // The operator took the 4x video knowing it forces the encode, so the
    // encode has to be worth the burst. Measured on a real 101 720p window:
    // crf 23 is 254 KB and 0.23 s, crf 28 is 145 KB and the same 0.23 s — the
    // time is identical, so the only question is quality, and a notification
    // video is looked at.
    const args = clipFfmpegArgs({ format: 'mp4', maxWidth: 1280, fps: 0, speed: 4 })
    expect(args).toContain('veryfast')
    expect(args[args.indexOf('-crf') + 1]).toBe('23')
  })

  it('speeds the VIDEO up too, and says so with setpts', () => {
    const vf = clipFfmpegArgs({ format: 'mp4', maxWidth: 1280, fps: 0, speed: 4 }).join(' ')
    expect(vf).toContain('setpts=PTS/4')
    // …and NOT a trailing fps: an mp4 muxer writes the timestamps it is given,
    // and pinning a rate here would duplicate or drop frames.
    expect(vf).not.toMatch(/setpts=PTS\/4,fps=/)
  })
})

describe('gifFilterComplex', () => {
  it('keeps the palette PAIR — without it a camera scene bands to a generic 256', () => {
    const filter = gifFilterComplex({ maxWidth: 640, fps: 8, speed: 1 })
    expect(filter).toContain('palettegen=stats_mode=diff')
    expect(filter).toContain('paletteuse')
    expect(filter).toContain('scale=640:-2:flags=lanczos')
  })

  it('decimates BEFORE it speeds up — the other order yields twice the frames', () => {
    // `fps` is the gif's own PLAYBACK rate, so the decimation that precedes
    // `setpts` samples `fps / speed` frames out of the source second.
    const filter = gifFilterComplex({ maxWidth: 640, fps: 8, speed: 2 })
    expect(filter).toContain('fps=4,')
    expect(filter.indexOf('fps=4')).toBeLessThan(filter.indexOf('setpts'))
  })

  it('emits no setpts at all at real time', () => {
    expect(gifFilterComplex({ maxWidth: 640, fps: 8, speed: 1 })).not.toContain('setpts')
  })
})

describe('the notification gif is 4x by default', () => {
  it('a 12 s window plays back in ~3 s — the divisor lives in setpts', () => {
    const filter = gifFilterComplex({ maxWidth: GIF_MAX_WIDTH, fps: GIF_FPS, speed: GIF_SPEED })
    const divisor = Number(/setpts=PTS\/([\d.]+)/.exec(filter)?.[1])
    expect(divisor).toBe(4)
    expect(12_000 / divisor).toBe(3_000)
  })

  it('samples FEWER source frames than it plays — 12 fps at 4x is 3 source fps', () => {
    // The whole size argument: a 4x gif of the same window carries 3 frames per
    // source second against the 8 the real-time default carried.
    const filter = gifFilterComplex({ maxWidth: GIF_MAX_WIDTH, fps: GIF_FPS, speed: GIF_SPEED })
    expect(filter).toContain('fps=3,')
    expect(GIF_FPS).toBe(12)
    expect(GIF_SPEED).toBe(4)
  })

  it('RE-DECLARES the rate after setpts — without it the muxer keeps 1 frame in 4', () => {
    // Measured on a live 101 window, not reasoned about: `fps=3,setpts=PTS/4`
    // alone produced a 3.01 s gif of TEN frames, because `setpts` compresses
    // the timestamps but leaves the filter link advertising 3 fps and the gif
    // muxer honours the link. The same window with a trailing `fps=12` is 36
    // frames — and 370 KB against 466 KB, because ten frames 4 s apart share no
    // pixels to delta-code.
    const filter = gifFilterComplex({ maxWidth: GIF_MAX_WIDTH, fps: GIF_FPS, speed: GIF_SPEED })
    expect(filter).toMatch(/fps=3,setpts=PTS\/4,fps=12,/)
    expect(filter.lastIndexOf('fps=12')).toBeGreaterThan(filter.indexOf('setpts'))
  })

  it('re-declares NOTHING at real time — one fps is already the whole answer', () => {
    const filter = gifFilterComplex({ maxWidth: 640, fps: 8, speed: 1 })
    expect(filter).toContain('[0:v]fps=8,scale=')
  })

  it('keeps the geometry the D91 session settled on — 4x must not cost pixels', () => {
    const filter = gifFilterComplex({ maxWidth: GIF_MAX_WIDTH, fps: GIF_FPS, speed: GIF_SPEED })
    expect(filter).toContain('scale=640:-2:flags=lanczos')
    expect(filter).toContain('palettegen=stats_mode=diff')
  })
})

describe('gifDeriveSpeed', () => {
  it('is the gif rate itself when the video is real time — the copy-branch default', () => {
    expect(gifDeriveSpeed(4, 1)).toBe(4)
  })

  it('DISCOUNTS the speed the mp4 already carries, so the gif is 4x absolute', () => {
    // The mp4 the gif is derived from has already been through `setpts`. Passing
    // the absolute rate again would make the gif 8x beside a 2x video.
    expect(gifDeriveSpeed(4, 2)).toBe(2)
  })

  it('collapses to real time when the video is already at the gif rate', () => {
    expect(gifDeriveSpeed(4, 4)).toBe(1)
  })
})

describe('windowCoverage', () => {
  const packet = (pts: number): EncodedPacket =>
    ({ type: 'video', pts, keyframe: true, data: new Uint8Array(1) }) as unknown as EncodedPacket

  it('places the window on WALL CLOCK by anchoring on the newest retained packet', () => {
    // The ring holds 10 s; the newest packet is "now". A window from 6 s ago to
    // 2 s ago must report exactly that, which is what lets a caller say "this
    // clip starts 4 s BEFORE the event" instead of guessing.
    const ring = [packet(0), packet(4_000), packet(8_000), packet(10_000)]
    const nowMs = 1_000_000
    const cov = windowCoverage(ring, [packet(4_000), packet(8_000)], nowMs)
    expect(cov.fromTs).toBe(nowMs - 6_000)
    expect(cov.toTs).toBe(nowMs - 2_000)
  })

  it('collapses to the instant when there is nothing to place', () => {
    expect(windowCoverage([], [], 42).fromTs).toBe(42)
  })
})

describe('EventMediaStore', () => {
  const bytes = (n: number): Uint8Array => new Uint8Array(n)

  it('a fetch does NOT consume the handle — a cross-runner retry is normal', () => {
    const store = new EventMediaStore()
    const handle = store.put({ deviceId: 101, kind: 'mp4', mime: 'video/mp4', bytes: bytes(10) })
    expect(store.get(handle)).not.toBeNull()
    expect(store.get(handle)).not.toBeNull()
  })

  it('expires — a consumer that crashed must not pin megabytes forever', () => {
    let now = 1_000
    const store = new EventMediaStore({ now: () => now, ttlMs: 5_000 })
    const handle = store.put({ deviceId: 101, kind: 'mp4', mime: 'video/mp4', bytes: bytes(10) })
    now += 4_999
    expect(store.get(handle)).not.toBeNull()
    now += 2
    expect(store.get(handle)).toBeNull()
    expect(store.bytes).toBe(0)
  })

  it('evicts oldest-first past the byte cap', () => {
    let now = 0
    const store = new EventMediaStore({ now: () => now, maxBytes: 100 })
    const first = store.put({ deviceId: 1, kind: 'mp4', mime: 'video/mp4', bytes: bytes(60) })
    now += 1
    const second = store.put({ deviceId: 2, kind: 'mp4', mime: 'video/mp4', bytes: bytes(60) })
    expect(store.get(second)).not.toBeNull()
    expect(store.get(first)).toBeNull()
  })

  it('NEVER evicts the artifact just stored, even when it alone exceeds the cap', () => {
    // The one failure a byte cap can invent: a producer hands over a handle that
    // was already dead. A 4K clip against a small cap is exactly this case.
    let now = 0
    const store = new EventMediaStore({ now: () => now, maxBytes: 100 })
    store.put({ deviceId: 1, kind: 'mp4', mime: 'video/mp4', bytes: bytes(40) })
    now += 1
    store.put({ deviceId: 2, kind: 'mp4', mime: 'video/mp4', bytes: bytes(40) })
    now += 1
    const huge = store.put({ deviceId: 3, kind: 'mp4', mime: 'video/mp4', bytes: bytes(500) })
    expect(store.get(huge)).not.toBeNull()
    expect(store.size).toBe(1)
  })
})
