/**
 * The ANIMATED preview: a dozen frames of the finished timelapse, each given
 * the same blurred-background + centred-title treatment as the still.
 *
 * The operator's ask, verbatim: *"inviato come gif o video (come per le altre
 * rule)"* [sent as a gif or video (as for the other rules)] — his advanced-notifier has a `gifRule`, and a ten-hour night reads
 * better as three seconds of motion than as one frame of it.
 *
 * Two halves tested apart: the seek plan (pure — which offsets are sampled) and
 * the assembly (sharp: N titled JPEGs → one animated GIF, under a byte budget,
 * degrading to null rather than throwing).
 */

import type { IScopedLogger } from '@camstack/types'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import type { TimelapsePreviewPorts } from '../preview-frame.js'
import {
  assemblePreviewGif,
  PREVIEW_GIF_FRAME_DELAY_MS,
  PREVIEW_GIF_FRAMES,
  PREVIEW_GIF_MAX_BYTES,
  PREVIEW_GIF_MAX_WIDTH,
  previewGifSeekSeconds,
  renderTimelapseGif,
} from '../preview-gif.js'
import { buildTestMp4 } from './mp4-fixture.js'

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as IScopedLogger

describe('previewGifSeekSeconds', () => {
  it('samples evenly ACROSS the video, never the first and last instant', () => {
    const seeks = previewGifSeekSeconds(120, 4)
    // Cell centres: frame 0 of a timelapse is the instant the window opened and
    // the final instant is often a keyframe that does not exist yet.
    expect(seeks).toEqual([15, 45, 75, 105])
  })

  it('asks for the configured frame count by default', () => {
    expect(previewGifSeekSeconds(600).length).toBe(PREVIEW_GIF_FRAMES)
  })

  it('is strictly increasing, so the animation runs forwards', () => {
    const seeks = previewGifSeekSeconds(37)
    for (let i = 1; i < seeks.length; i += 1) {
      expect(seeks[i]).toBeGreaterThan(seeks[i - 1] as number)
    }
  })

  it('collapses to a single frame at 0 for a video with no duration', () => {
    // An unprobeable video still gets a preview — one frame, from the start.
    expect(previewGifSeekSeconds(0)).toEqual([0])
    expect(previewGifSeekSeconds(-5)).toEqual([0])
  })

  it('never asks for more frames than the video has seconds to spare', () => {
    // A 3-second render sampled 12 times would seek the same keyframe 12 times
    // and produce a "moving" image that does not move.
    expect(previewGifSeekSeconds(3).length).toBeLessThanOrEqual(3)
  })
})

describe('assemblePreviewGif', () => {
  async function frames(n: number, width = 160, height = 90): Promise<readonly Buffer[]> {
    return Promise.all(
      Array.from({ length: n }, (_v, i) =>
        sharp({
          create: { width, height, channels: 3, background: { r: 20 * i, g: 60, b: 200 - 15 * i } },
        })
          .jpeg()
          .toBuffer(),
      ),
    )
  }

  it('assembles ONE animated GIF with a page per frame', async () => {
    const gif = await assemblePreviewGif(await frames(6), logger)
    expect(gif).not.toBeNull()
    const meta = await sharp(gif as Buffer, { animated: true }).metadata()
    expect(meta.format).toBe('gif')
    expect(meta.pages).toBe(6)
  })

  it('holds EVERY frame for the playback delay, not just the first', async () => {
    // sharp applies a scalar `delay` to frame 0 only: the rest would run at the
    // GIF default and the animation would flash past.
    const gif = await assemblePreviewGif(await frames(4), logger)
    const meta = await sharp(gif as Buffer, { animated: true }).metadata()
    expect(meta.delay).toEqual([
      PREVIEW_GIF_FRAME_DELAY_MS,
      PREVIEW_GIF_FRAME_DELAY_MS,
      PREVIEW_GIF_FRAME_DELAY_MS,
      PREVIEW_GIF_FRAME_DELAY_MS,
    ])
  })

  it('answers null — never throws — for no frames at all', async () => {
    expect(await assemblePreviewGif([], logger)).toBeNull()
  })

  it('answers null for frames it cannot decode, and says so', async () => {
    expect(await assemblePreviewGif([Buffer.from('not a jpeg')], logger)).toBeNull()
  })

  it('collapses frames that are byte-identical — a still night is a still GIF', async () => {
    // cgif drops a frame that repeats its predecessor exactly. That is the
    // encoder being right, and it is pinned here so a future reader does not
    // read `pages: 1` on a motionless camera as a broken assembly.
    const one = await sharp({
      create: { width: 64, height: 36, channels: 3, background: '#204060' },
    })
      .jpeg()
      .toBuffer()
    const gif = await assemblePreviewGif(
      Array.from({ length: 8 }, () => one),
      logger,
    )
    expect((await sharp(gif as Buffer, { animated: true }).metadata()).pages).toBe(1)
  })

  it('stays inside the attachment budget', async () => {
    const gif = await assemblePreviewGif(await frames(PREVIEW_GIF_FRAMES, 480, 270), logger)
    expect(gif).not.toBeNull()
    expect((gif as Buffer).byteLength).toBeLessThanOrEqual(PREVIEW_GIF_MAX_BYTES)
  })
})

describe('renderTimelapseGif', () => {
  /** A frame that DIFFERS per offset — like every real timelapse. Identical
   *  frames are legitimately collapsed by the encoder (pinned above), which
   *  would make these assertions measure the fake instead of the code. */
  async function jpegFrame(seed = 0, width = 96, height = 54): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: (seed * 17) % 256, g: 60, b: (200 - seed * 9 + 256) % 256 },
      },
    })
      .jpeg()
      .toBuffer()
  }

  const PINNED = '/data/deps/ffmpeg-8.1.2-5'

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

  it('extracts one frame per sampled offset, every one from the PINNED binary', async () => {
    const seeks: string[] = []
    const commands = new Set<string>()
    const gif = await renderTimelapseGif(
      ports({
        run: async (cmd, args) => {
          commands.add(cmd)
          seeks.push(args[args.indexOf('-ss') + 1] ?? '')
          return await jpegFrame(seeks.length)
        },
      }),
      { mp4: buildTestMp4({ durationMs: 120_000 }), text: 'Timelapse front door', deviceId: 101 },
    )
    expect([...commands]).toEqual([PINNED])
    expect(gif).not.toBeNull()
    expect(seeks.length).toBe(PREVIEW_GIF_FRAMES)
    expect(new Set(seeks).size).toBe(PREVIEW_GIF_FRAMES)
    expect((await sharp(gif as Buffer, { animated: true }).metadata()).pages).toBe(
      PREVIEW_GIF_FRAMES,
    )
  })

  it('scales the frames DOWN — a 960 px animation is not an attachment', async () => {
    const widths: string[] = []
    await renderTimelapseGif(
      ports({
        run: async (_cmd, args) => {
          widths.push(args[args.indexOf('-vf') + 1] ?? '')
          return await jpegFrame()
        },
      }),
      { mp4: buildTestMp4({ durationMs: 60_000 }), text: 'x', deviceId: 101 },
    )
    expect(widths[0]).toContain(String(PREVIEW_GIF_MAX_WIDTH))
  })

  it('titles EVERY frame, so no frame of the animation is the odd one out', async () => {
    function feed(): TimelapsePreviewPorts {
      let n = 0
      return ports({
        run: async () => {
          n += 1
          return await jpegFrame(n, 320, 180)
        },
      })
    }
    const gif = await renderTimelapseGif(feed(), {
      mp4: buildTestMp4({ durationMs: 60_000 }),
      text: 'Timelapse front door',
      deviceId: 101,
    })
    expect((await sharp(gif as Buffer, { animated: true }).metadata()).pages).toBe(
      PREVIEW_GIF_FRAMES,
    )
    // Same frames, no title: a titled animation cannot be the bare one.
    const untitled = await renderTimelapseGif(feed(), {
      mp4: buildTestMp4({ durationMs: 60_000 }),
      text: '',
      deviceId: 101,
    })
    expect(Buffer.compare(gif as Buffer, untitled as Buffer)).not.toBe(0)
    expect((gif as Buffer).byteLength).toBeGreaterThan((untitled as Buffer).byteLength)
  })

  it('survives frames that could not be extracted, as long as ONE lands', async () => {
    let n = 0
    const gif = await renderTimelapseGif(
      ports({
        run: async () => {
          n += 1
          return n % 2 === 0 ? null : await jpegFrame(n)
        },
      }),
      { mp4: buildTestMp4({ durationMs: 60_000 }), text: 'x', deviceId: 101 },
    )
    expect(gif).not.toBeNull()
    expect((await sharp(gif as Buffer, { animated: true }).metadata()).pages).toBe(
      PREVIEW_GIF_FRAMES / 2,
    )
  })

  it('answers null when NO frame could be extracted — the caller degrades', async () => {
    const gif = await renderTimelapseGif(ports({ run: async () => null }), {
      mp4: buildTestMp4({ durationMs: 60_000 }),
      text: 'x',
      deviceId: 101,
    })
    expect(gif).toBeNull()
  })

  it('REFUSES, with a per-camera ERROR, when the pinned build cannot be resolved', async () => {
    const error = vi.fn()
    const run = vi.fn(async () => await jpegFrame())
    const gif = await renderTimelapseGif(
      ports({
        logger: { ...logger, error },
        run,
        resolveFfmpeg: async () => {
          throw new Error('download failed')
        },
      }),
      { mp4: buildTestMp4({ durationMs: 60_000 }), text: 'x', deviceId: 101 },
    )
    expect(gif).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('pinned ffmpeg could not be resolved'),
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })

  it('removes the staged video on EVERY outcome', async () => {
    const removeTemp = vi.fn(async () => {})
    await renderTimelapseGif(ports({ removeTemp }), {
      mp4: new Uint8Array([1]),
      text: 'x',
      deviceId: 101,
    })
    expect(removeTemp).toHaveBeenCalledWith('/tmp/tl.mp4')
  })
})
