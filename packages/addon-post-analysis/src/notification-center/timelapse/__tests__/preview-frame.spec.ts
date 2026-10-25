/**
 * The timelapse PREVIEW frame — the still a notification card shows.
 *
 * Three halves, tested apart because they fail apart: the ffmpeg argv that
 * pulls one frame out of the finished mp4 (pure, asserted verbatim — an argv is
 * a contract with another process), the TITLE layout (pure: wrap, shrink,
 * elide, and the SVG it produces), and the composite itself (sharp: blur the
 * middle frame, darken it, draw the title over it).
 *
 * The design under test, verbatim from the operator: the preview is the
 * timelapse's middle frame BLURRED as a background, with the title LARGE and
 * CENTERED on top — the advanced-notifier style — and an empty `previewText`
 * ships the plain, UNBLURRED frame, because the blur exists only to make the
 * title pop.
 */

import type { IScopedLogger } from '@camstack/types'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import type { TimelapsePreviewPorts } from '../preview-frame.js'
import {
  buildPreviewFrameArgs,
  buildTitleSvg,
  drawPreviewTitle,
  fitTitle,
  PREVIEW_BLUR_SIGMA_MAX,
  PREVIEW_BLUR_SIGMA_MIN,
  PREVIEW_FRAME_MAX_WIDTH,
  previewBlurSigma,
  previewFrameSeekSec,
  renderTimelapsePreview,
  TITLE_MAX_LINES,
  TITLE_MIN_FONT_PX,
} from '../preview-frame.js'
import { buildTestMp4 } from './mp4-fixture.js'

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as IScopedLogger

describe('previewFrameSeekSec', () => {
  it('lands in the MIDDLE of the rendered video, not on frame 0', () => {
    // Frame 0 of a 21:00→07:00 timelapse is the instant the window opened —
    // the least representative frame in it.
    expect(previewFrameSeekSec(48)).toBe(24)
  })

  it('never seeks past a video too short to have a middle', () => {
    expect(previewFrameSeekSec(0)).toBe(0)
    expect(previewFrameSeekSec(-1)).toBe(0)
  })
})

describe('buildPreviewFrameArgs', () => {
  it('seeks BEFORE the input and asks for exactly one JPEG on stdout', () => {
    const args = buildPreviewFrameArgs({ inputPath: '/t/e1.mp4', atSec: 24 })
    // `-ss` before `-i` is the cheap keyframe seek; after `-i` it decodes the
    // whole file to get there (minutes, on a ten-hour source).
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args).toContain('/t/e1.mp4')
    expect(args.join(' ')).toContain('-frames:v 1')
    expect(args.at(-1)).toBe('pipe:1')
    expect(args.join(' ')).toContain(`scale='min(${PREVIEW_FRAME_MAX_WIDTH},iw)':-2`)
  })

  it('asks for mjpeg explicitly — the output has no filename to infer from', () => {
    const args = buildPreviewFrameArgs({ inputPath: '/t/e1.mp4', atSec: 0 })
    expect(args.join(' ')).toContain('-f image2')
    expect(args).toContain('mjpeg')
  })
})

describe('previewBlurSigma', () => {
  it('scales the blur with the frame, so a 360p and a 1080p preview look alike', () => {
    expect(previewBlurSigma(960)).toBeGreaterThan(previewBlurSigma(480))
  })

  it('stays inside the tasteful band at both extremes', () => {
    expect(previewBlurSigma(64)).toBe(PREVIEW_BLUR_SIGMA_MIN)
    expect(previewBlurSigma(4096)).toBe(PREVIEW_BLUR_SIGMA_MAX)
    expect(previewBlurSigma(960)).toBeGreaterThanOrEqual(8)
    expect(previewBlurSigma(960)).toBeLessThanOrEqual(12)
  })
})

describe('fitTitle', () => {
  // LIVE, 2026-08-12: the first captioned preview drew
  // "Timelapse Camera front door 21:00→07:00" at 27 px on a 640 px frame
  // and the last glyphs touched the right border. `previewText` is operator
  // free text up to 200 chars, so the overflow is unbounded without a fit.
  const LIVE = 'Timelapse Camera front door 21:00→07:00'

  function widest(t: { lines: readonly string[]; fontPx: number }): number {
    return Math.max(...t.lines.map((l) => l.length)) * t.fontPx * 0.62
  }

  it('is BIG — the font is a fraction of the frame WIDTH, not of a caption bar', () => {
    const t = fitTitle('Timelapse', 960, 540)
    // ~1/12 of the width: 80 px on a 960 px frame. The old bottom-caption drew
    // 40 px there, which is a label, not a title.
    expect(t.fontPx).toBeGreaterThanOrEqual(72)
    expect(t.fontPx).toBeLessThanOrEqual(88)
    expect(t.lines).toEqual(['Timelapse'])
  })

  it('wraps a two-word title onto a second line rather than shrinking it away', () => {
    const t = fitTitle('Timelapse front door', 960, 540)
    expect(t.lines.length).toBe(2)
    expect(t.lines.join(' ')).toBe('Timelapse front door')
    expect(widest(t)).toBeLessThanOrEqual(960)
  })

  it('shrinks the live title until it fits TWO lines inside the frame', () => {
    const t = fitTitle(LIVE, 960, 540)
    expect(t.lines.length).toBeLessThanOrEqual(TITLE_MAX_LINES)
    expect(t.lines.join(' ')).toBe(LIVE)
    expect(widest(t)).toBeLessThanOrEqual(960)
  })

  it('elides a title no font size can fit, and still fits', () => {
    const t = fitTitle('x'.repeat(200), 960, 540)
    expect(t.lines.length).toBe(TITLE_MAX_LINES)
    expect(t.lines.at(-1)?.endsWith('…')).toBe(true)
    expect(t.lines.join('').length).toBeLessThan(200)
    expect(widest(t)).toBeLessThanOrEqual(960)
  })

  it('never shrinks below the legibility floor', () => {
    expect(fitTitle('x'.repeat(200), 320, 180).fontPx).toBeGreaterThanOrEqual(TITLE_MIN_FONT_PX)
  })

  it('scales the font with the frame, so a 1080p render reads the same', () => {
    expect(fitTitle('Timelapse', 1920, 1080).fontPx).toBeGreaterThan(
      fitTitle('Timelapse', 640, 360).fontPx,
    )
  })

  it('collapses whitespace so an operator newline cannot open a blank line', () => {
    expect(fitTitle('  Timelapse   \n front door ', 1920, 1080).lines.join(' ')).toBe(
      'Timelapse front door',
    )
  })
})

describe('buildTitleSvg', () => {
  const svg = buildTitleSvg({
    width: 960,
    height: 540,
    title: fitTitle('Timelapse front door', 960, 540),
  })

  it('centres every line horizontally on the frame', () => {
    expect(svg).toContain('text-anchor="middle"')
    expect(svg).toContain('x="480"')
    // Nothing is pinned to the bottom any more — the old caption bar drew a
    // strip at y = height - barHeight and left-aligned text at x = pad.
    expect(svg).not.toContain(`y="${540 - 24}"`)
  })

  it('centres the block vertically — half the lines above the midline, half below', () => {
    const ys = [...svg.matchAll(/<text[^>]*\sy="(\d+)"/g)].map((m) => Number(m[1]))
    expect(ys.length).toBeGreaterThan(0)
    expect(Math.min(...ys)).toBeLessThan(270)
    expect(Math.max(...ys)).toBeGreaterThan(270)
  })

  it('darkens the whole frame, not a strip, so white text always reads', () => {
    expect(svg).toMatch(/<rect x="0" y="0" width="960" height="540"[^>]*fill="black"/)
  })

  it('draws the title bold, white, at the fitted size', () => {
    const { fontPx } = fitTitle('Timelapse front door', 960, 540)
    expect(svg).toContain(`font-size="${fontPx}"`)
    expect(svg).toContain('font-weight="bold"')
    expect(svg).toContain('fill="white"')
    expect(svg).toContain('font-family="DejaVu Sans,Helvetica,Arial,sans-serif"')
  })

  it('lays a shadow copy under each line — a white title over a bright frame', () => {
    // Two <text> per line: the offset dark copy, then the white one.
    expect([...svg.matchAll(/<text/g)].length).toBe(
      fitTitle('Timelapse front door', 960, 540).lines.length * 2,
    )
  })

  it('escapes a title that would otherwise break the document', () => {
    const out = buildTitleSvg({ width: 320, height: 180, title: fitTitle('A & B <c>', 320, 180) })
    expect(out).not.toMatch(/<c>/)
    expect(out).toContain('&amp;')
  })
})

describe('drawPreviewTitle', () => {
  /** A fine vertical grating: maximum high-frequency detail, so a blur that
   *  ran is measurable and a blur that did not cannot be faked. */
  async function grating(width = 320, height = 180): Promise<Buffer> {
    const raw = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const on = x % 8 < 4 ? 255 : 0
        const i = (y * width + x) * 3
        raw[i] = on
        raw[i + 1] = on
        raw[i + 2] = on
      }
    }
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg()
      .toBuffer()
  }

  async function detail(jpeg: Buffer): Promise<number> {
    const stats = await sharp(jpeg).stats()
    return stats.channels[0]?.stdev ?? 0
  }

  it('BLURS the frame under the title', async () => {
    const base = await grating()
    const out = await drawPreviewTitle(base, 'Timelapse front door', logger)
    expect(out).not.toBeNull()
    // The grating's 4 px stripes cannot survive a sigma ≥ 4 blur; if the frame
    // were composited sharp, the stdev would barely move.
    expect(await detail(out as Buffer)).toBeLessThan((await detail(base)) * 0.3)
  })

  it('keeps the frame size and format', async () => {
    const out = await drawPreviewTitle(await grating(), 'Timelapse front door', logger)
    const meta = await sharp(out as Buffer).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(320)
    expect(meta.height).toBe(180)
  })

  it('returns the PLAIN, UNBLURRED frame when there is no title', async () => {
    // The blur exists to make the title pop. With no title there is nothing to
    // pop, and a blurred picture is strictly worse than the picture.
    const base = await grating()
    const out = await drawPreviewTitle(base, '', logger)
    expect(Buffer.compare(out as Buffer, base)).toBe(0)
  })

  it('survives a title that would otherwise break the SVG', async () => {
    const out = await drawPreviewTitle(await grating(), 'A & B <c> "d"', logger)
    expect(out).not.toBeNull()
    expect((await sharp(out as Buffer).metadata()).format).toBe('jpeg')
  })
})

describe('renderTimelapsePreview', () => {
  /** Where the node's pinned build lives in these specs. Any absolute path
   *  that is NOT a bare name proves the point: the spawn got the RESOLVED path. */
  const PINNED = '/data/deps/ffmpeg-8.1.2-5'

  async function jpegFrame(): Promise<Buffer> {
    return sharp({ create: { width: 64, height: 36, channels: 3, background: '#123456' } })
      .jpeg()
      .toBuffer()
  }

  function ports(over: Partial<TimelapsePreviewPorts> = {}): TimelapsePreviewPorts {
    return {
      logger,
      run: async () => null,
      writeTemp: async () => '/tmp/tl.mp4',
      removeTemp: async () => {},
      resolveFfmpeg: async () => PINNED,
      ...over,
    }
  }

  it('reads the duration from the video, seeks the middle and titles the frame', async () => {
    const frame = await jpegFrame()
    const calls: Array<{ cmd: string; args: readonly string[] }> = []
    const out = await renderTimelapsePreview(
      ports({
        run: async (cmd, args) => {
          calls.push({ cmd, args })
          return frame
        },
      }),
      { mp4: buildTestMp4({ durationMs: 48_000 }), text: 'Timelapse front door', deviceId: 101 },
    )
    expect(out).not.toBeNull()
    // ONE child: the duration comes from the bytes, not from an ffprobe.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toContain('24')
    expect(Buffer.compare(out as Buffer, frame)).not.toBe(0)
  })

  it('spawns the PINNED binary it was given — never a bare name looked up on PATH', async () => {
    const commands: string[] = []
    await renderTimelapsePreview(
      ports({
        run: async (cmd) => {
          commands.push(cmd)
          return await jpegFrame()
        },
      }),
      { mp4: buildTestMp4({ durationMs: 10_000 }), text: 'x', deviceId: 101 },
    )
    expect(commands).toEqual([PINNED])
  })

  it('REFUSES, with a per-camera ERROR, when the pinned build cannot be resolved', async () => {
    const error = vi.fn()
    const run = vi.fn(async () => await jpegFrame())
    const writeTemp = vi.fn(async () => '/tmp/tl.mp4')
    const out = await renderTimelapsePreview(
      ports({
        logger: { ...logger, error },
        run,
        writeTemp,
        resolveFfmpeg: async () => {
          throw new Error('download failed')
        },
      }),
      { mp4: buildTestMp4({ durationMs: 10_000 }), text: 'x', deviceId: 101 },
    )
    expect(out).toBeNull()
    // Nothing spawned at all — in particular not a PATH `ffmpeg` — and the
    // video was never even staged: the cheap question comes first.
    expect(run).not.toHaveBeenCalled()
    expect(writeTemp).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('pinned ffmpeg could not be resolved'),
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })

  it('falls back to the first frame when the video carries no duration — a worse picture, not none', async () => {
    const frame = await jpegFrame()
    const seeks: string[] = []
    const out = await renderTimelapsePreview(
      ports({
        run: async (_cmd, args) => {
          seeks.push(args[args.indexOf('-ss') + 1] ?? '')
          return frame
        },
      }),
      { mp4: new Uint8Array([1]), text: '', deviceId: 101 },
    )
    expect(seeks).toEqual(['0'])
    expect(out).not.toBeNull()
  })

  it('answers null — never throws — when no frame can be extracted', async () => {
    const out = await renderTimelapsePreview(ports({ run: async () => null }), {
      mp4: buildTestMp4({ durationMs: 10_000 }),
      text: 'x',
      deviceId: 101,
    })
    expect(out).toBeNull()
  })

  it('removes the staged video on EVERY outcome', async () => {
    const removeTemp = vi.fn(async () => {})
    await renderTimelapsePreview(ports({ removeTemp }), {
      mp4: new Uint8Array([1]),
      text: 'x',
      deviceId: 101,
    })
    expect(removeTemp).toHaveBeenCalledWith('/tmp/tl.mp4')
  })
})
