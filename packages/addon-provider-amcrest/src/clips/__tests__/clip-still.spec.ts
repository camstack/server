/**
 * The cut itself: where in the clip the camera is ASKED to start, what ffmpeg
 * is told, and what every dead end is CALLED.
 *
 * Nothing here asserts that a constant is present. The midpoint is proved by
 * halving several windows, the probe discipline by the ORDER of the argument
 * list, and every refusal by driving a fake ffmpeg into it.
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'

import {
  buildClipStillArgs,
  clipStillWindow,
  cutClipStill,
  CLIP_STILL_WIDTH,
} from '../clip-still.js'
import type { AmcrestClipRow } from '../clip-search.js'

const START_MS = Date.UTC(2026, 8, 23, 17, 4, 59)
const END_MS = Date.UTC(2026, 8, 23, 17, 8, 24)

function makeLogger(): IScopedLogger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return logger
}

function makeRow(overrides: Partial<AmcrestClipRow> = {}): AmcrestClipRow {
  return {
    clipKey: `${String(START_MS / 1000)}-${String(END_MS / 1000)}`,
    startMs: START_MS,
    endMs: END_MS,
    windowMs: END_MS - START_MS,
    sizeBytes: 56_242_806,
    filePath: '/mnt/sd/2026-09-23/001/dav/19/19.04.59-19.08.24[M][0@0][0].mp4',
    events: ['VideoMotion'],
    flags: ['Event'],
    channel: 0,
    ...overrides,
  }
}

function fakeFfmpeg(options: {
  readonly stdout?: Buffer
  readonly stderr?: string
  readonly exit?: number
  readonly hang?: boolean
}): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  const stdout = Readable.from(options.stdout === undefined ? [] : [options.stdout])
  const stderr = Readable.from(options.stderr === undefined ? [] : [Buffer.from(options.stderr)])
  Object.assign(child, { stdout, stderr, stdin: null, kill: vi.fn() })
  if (options.hang !== true) {
    setTimeout(() => {
      child.emit('close', options.exit ?? 0)
    }, 1)
  }
  return child
}

describe('clipStillWindow', () => {
  it('asks the camera to start at the MIDPOINT of the clip, not at its head', () => {
    // Halved, for several windows — a constant, a clamp or a head-start all
    // fail at least one of these.
    expect(clipStillWindow(makeRow())?.startMs).toBe(START_MS + (END_MS - START_MS) / 2)
    const short = makeRow({ startMs: 1_000_000, endMs: 1_010_000 })
    expect(clipStillWindow(short)?.startMs).toBe(1_005_000)
    const long = makeRow({ startMs: 0, endMs: 300_000 })
    expect(clipStillWindow(long)?.startMs).toBe(150_000)
  })

  it('keeps the row’s own end, so the camera has the rest of the clip to answer from', () => {
    expect(clipStillWindow(makeRow())?.endMs).toBe(END_MS)
  })

  it('answers `null` for a row that spans nothing — never a midpoint of zero', () => {
    expect(clipStillWindow(makeRow({ endMs: START_MS }))).toBeNull()
    expect(clipStillWindow(makeRow({ endMs: START_MS - 1_000 }))).toBeNull()
  })
})

describe('buildClipStillArgs', () => {
  it('names the transport and disarms the probe BEFORE the input, or they apply to nothing', () => {
    const args = buildClipStillArgs({
      url: 'rtsp://cam/cam/playback?starttime=x',
    })
    const input = args.indexOf('-i')
    expect(input).toBeGreaterThanOrEqual(0)
    for (const flag of ['-rtsp_transport', '-analyzeduration', '-probesize']) {
      expect(args.indexOf(flag)).toBeGreaterThanOrEqual(0)
      expect(args.indexOf(flag)).toBeLessThan(input)
    }
    expect(args[args.indexOf('-rtsp_transport') + 1]).toBe('tcp')
    expect(args[args.indexOf('-analyzeduration') + 1]).toBe('0')
    expect(args[input + 1]).toBe('rtsp://cam/cam/playback?starttime=x')
  })

  it('asks for ONE frame, scaled, as mjpeg on stdout', () => {
    const args = buildClipStillArgs({ url: 'rtsp://cam/x' })
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1')
    expect(args[args.indexOf('-vf') + 1]).toContain(`scale=${String(CLIP_STILL_WIDTH)}:-2`)
    expect(args[args.lastIndexOf('-f') + 1]).toBe('mjpeg')
    expect(args[args.length - 1]).toBe('pipe:1')
  })

  it('carries no `-ss`: the seek is the URL’s own `starttime`', () => {
    // There is no input file to seek inside — `/cam/playback` is addressed by
    // a time window, and an `-ss` here would seek inside a live replay.
    expect(buildClipStillArgs({ url: 'rtsp://cam/x' })).not.toContain('-ss')
  })
})

describe('cutClipStill', () => {
  it('asks for the pinned ffmpeg at EACH cut: a failed resolution refuses, the next one recovers (D540)', async () => {
    let calls = 0
    // No seam: the resolver is the only way to a binary. Node stands in for
    // ffmpeg on the second cut — the assertion is that a spawn was reached.
    const resolveFfmpeg = async (): Promise<string> => {
      calls += 1
      if (calls === 1) throw new Error('download failed')
      return process.execPath
    }
    const first = await cutClipStill(
      { url: 'rtsp://cam/x' },
      { resolveFfmpeg, logger: makeLogger() },
    )
    expect(first).toMatchObject({ kind: 'refused', code: 'decode-failed' })
    if (first.kind !== 'refused') throw new Error('unreachable')
    expect(first.detail).toContain('no pinned ffmpeg')
    expect(first.detail).toContain('download failed')

    const second = await cutClipStill(
      { url: 'rtsp://cam/x' },
      { resolveFfmpeg, logger: makeLogger() },
    )
    expect(calls).toBe(2)
    if (second.kind === 'refused') expect(second.detail).not.toContain('no pinned ffmpeg')
  })

  it('answers the JPEG ffmpeg produced', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])
    const cut = await cutClipStill(
      { url: 'rtsp://cam/x' },
      {
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        logger: makeLogger(),
        spawnStill: () => fakeFfmpeg({ stdout: jpeg }),
      },
    )
    expect(cut.kind).toBe('ok')
    if (cut.kind !== 'ok') throw new Error('unreachable')
    expect(cut.bytes.equals(jpeg)).toBe(true)
    expect(cut.slotMs).toBeGreaterThanOrEqual(0)
  })

  it('calls a 404 the CAMERA’s refusal, with the sentence that says what a 404 covers', async () => {
    const cut = await cutClipStill(
      { url: 'rtsp://cam/x' },
      {
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        logger: makeLogger(),
        spawnStill: () =>
          fakeFfmpeg({
            exit: 8,
            stderr: 'Error opening input files: Server returned 404 Not Found',
          }),
      },
    )
    expect(cut.kind).toBe('refused')
    if (cut.kind !== 'refused') throw new Error('unreachable')
    expect(cut.code).toBe('camera-refused')
    // Never "this clip is gone": the one status covers three things.
    expect(cut.detail).toContain('404')
    expect(cut.detail).toContain('no budget for')
  })

  it('calls a failure that names no camera status OURS', async () => {
    const cut = await cutClipStill(
      { url: 'rtsp://cam/x' },
      {
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        logger: makeLogger(),
        spawnStill: () => fakeFfmpeg({ exit: 1, stderr: 'Invalid argument' }),
      },
    )
    expect(cut.kind).toBe('refused')
    if (cut.kind !== 'refused') throw new Error('unreachable')
    expect(cut.code).toBe('decode-failed')
    expect(cut.detail).toContain('Invalid argument')
  })

  it('calls an EMPTY answer `no-keyframe` — never a black frame (D315)', async () => {
    const cut = await cutClipStill(
      { url: 'rtsp://cam/x' },
      {
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        logger: makeLogger(),
        spawnStill: () => fakeFfmpeg({ exit: 0 }),
      },
    )
    expect(cut.kind).toBe('refused')
    if (cut.kind !== 'refused') throw new Error('unreachable')
    expect(cut.code).toBe('no-keyframe')
  })

  it('kills and refuses an ffmpeg that never answers', async () => {
    const child = fakeFfmpeg({ hang: true })
    const cut = await cutClipStill(
      { url: 'rtsp://cam/x' },
      {
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        logger: makeLogger(),
        spawnStill: () => child,
        timeoutMs: 20,
      },
    )
    expect(cut.kind).toBe('refused')
    if (cut.kind !== 'refused') throw new Error('unreachable')
    expect(cut.code).toBe('camera-refused')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('gives the slot back the instant a playback wants it, and says it YIELDED', async () => {
    const child = fakeFfmpeg({ hang: true })
    const evict = new AbortController()
    const pending = cutClipStill(
      { url: 'rtsp://cam/x' },
      {
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        logger: makeLogger(),
        spawnStill: () => child,
        signal: evict.signal,
        timeoutMs: 10_000,
      },
    )
    evict.abort()
    const cut = await pending
    expect(cut.kind).toBe('refused')
    if (cut.kind !== 'refused') throw new Error('unreachable')
    expect(cut.code).toBe('yielded')
    // The camera's socket really is given back, not merely reported as given
    // back: a yield that left ffmpeg running would hold the slot anyway.
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('never DIALS when the slot is claimed while the pinned ffmpeg is being resolved', async () => {
    const evict = new AbortController()
    // No seam: the real resolver path, and the claim lands DURING its await.
    const resolveFfmpeg = async (): Promise<string> => {
      evict.abort()
      return process.execPath
    }
    const cut = await cutClipStill(
      { url: 'rtsp://cam/x' },
      { resolveFfmpeg, logger: makeLogger(), signal: evict.signal },
    )
    // Refused at the pre-spawn check — a spawn would have reached the later
    // check, whose detail is "a playback wanted the slot after N ms".
    expect(cut).toEqual({
      kind: 'refused',
      code: 'yielded',
      detail: 'the slot was wanted while the pinned ffmpeg was being resolved',
    })
  })

  it('never spawns at all when the slot is already wanted', async () => {
    const spawnStill = vi.fn(() => fakeFfmpeg({ hang: true }))
    const evict = new AbortController()
    evict.abort()
    const cut = await cutClipStill(
      { url: 'rtsp://cam/x' },
      {
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        logger: makeLogger(),
        spawnStill,
        signal: evict.signal,
      },
    )
    expect(cut.kind).toBe('refused')
    if (cut.kind !== 'refused') throw new Error('unreachable')
    expect(cut.code).toBe('yielded')
    expect(spawnStill).not.toHaveBeenCalled()
  })

  it('refuses rather than throwing when ffmpeg cannot be spawned at all', async () => {
    const cut = await cutClipStill(
      { url: 'rtsp://cam/x' },
      {
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        logger: makeLogger(),
        spawnStill: () => {
          throw new Error('ENOENT')
        },
      },
    )
    expect(cut.kind).toBe('refused')
    if (cut.kind !== 'refused') throw new Error('unreachable')
    expect(cut.code).toBe('decode-failed')
  })
})
