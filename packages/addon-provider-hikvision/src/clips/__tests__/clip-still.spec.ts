/**
 * The still: where inside the clip it is cut, and what happens when no frame
 * comes back.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import type { IScopedLogger } from '@camstack/types'

import { buildClipStillArgs, clipStillSeekSeconds, cutClipStill } from '../clip-still.js'

const logger: IScopedLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
  withTags: () => logger,
}

interface FakeFfmpeg {
  readonly spawn: (args: readonly string[]) => ChildProcess
  emit(chunk: Buffer): void
  close(code: number): void
  readonly killed: () => boolean
}

function fakeFfmpeg(): FakeFfmpeg {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let killed = false
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: () => {
      killed = true
      return true
    },
  })
  return {
    // A structural ChildProcess: this module touches stdout, stderr, `once`
    // and `kill`, and nothing else. A documented type boundary.
    spawn: () => child as unknown as ChildProcess,
    emit: (chunk) => stdout.write(chunk),
    close: (code) => child.emit('close', code),
    killed: () => killed,
  }
}

describe('where a still is cut', () => {
  it('is the MIDPOINT, and the seek is an INPUT seek', () => {
    // The first frame of a motion segment is the moment before the subject
    // arrived — the one picture that says nothing. And `-ss` must come BEFORE
    // `-i`: after it, ffmpeg decodes every frame up to the target, which on a
    // 4K clip is the difference between a tenth of a second and several.
    const args = buildClipStillArgs({ path: '/scratch/a.mp4', durationMs: 18_000 })
    expect(args.join(' ')).toContain('-ss 9.000 -i /scratch/a.mp4')
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args.join(' ')).toContain('-frames:v 1')
    // The muxer is STATED: `pipe:1` has no extension for ffmpeg to guess from.
    expect(args.join(' ')).toContain('-f mjpeg')
    expect(args.at(-1)).toBe('pipe:1')
    expect(clipStillSeekSeconds(0)).toBe(0)
  })
})

describe('cutClipStill', () => {
  it('answers with the JPEG ffmpeg produced', async () => {
    const ff = fakeFfmpeg()
    const running = cutClipStill(
      { path: '/scratch/a.mp4', durationMs: 18_000 },
      { resolveFfmpeg: async () => '/deps/ffmpeg-pinned', logger, spawnStill: ff.spawn },
    )
    ff.emit(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    await Promise.resolve()
    ff.close(0)
    expect(await running).toEqual({ kind: 'ok', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) })
  })

  it('REFUSES by name when no frame came back — never a black one', async () => {
    // D315: absence stays absence. A poster invented to fill the tile is
    // indistinguishable from a real picture of an empty scene, which is the
    // one thing an operator must be able to tell apart.
    const ff = fakeFfmpeg()
    const running = cutClipStill(
      { path: '/scratch/a.mp4', durationMs: 18_000 },
      { resolveFfmpeg: async () => '/deps/ffmpeg-pinned', logger, spawnStill: ff.spawn },
    )
    ff.close(0)
    expect(await running).toMatchObject({ kind: 'refused', code: 'no-keyframe' })
  })

  it('names OUR decoder’s failure as ours, never as the camera’s', async () => {
    // `camera-refused` here would send an operator to a camera that answered
    // perfectly. `decode-failed` is why the cap enum has that member.
    const ff = fakeFfmpeg()
    const running = cutClipStill(
      { path: '/scratch/a.mp4', durationMs: 18_000 },
      { resolveFfmpeg: async () => '/deps/ffmpeg-pinned', logger, spawnStill: ff.spawn },
    )
    ff.close(1)
    expect(await running).toMatchObject({ kind: 'refused', code: 'decode-failed' })

    const cannotSpawn = await cutClipStill(
      { path: '/scratch/a.mp4', durationMs: 18_000 },
      {
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        logger,
        spawnStill: () => {
          throw new Error('ENOENT')
        },
      },
    )
    expect(cannotSpawn).toMatchObject({ kind: 'refused', code: 'decode-failed' })
  })

  it('does not wait for an ffmpeg that is not going to answer', async () => {
    vi.useFakeTimers()
    try {
      const ff = fakeFfmpeg()
      const running = cutClipStill(
        { path: '/scratch/a.mp4', durationMs: 18_000 },
        {
          resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
          logger,
          spawnStill: ff.spawn,
          timeoutMs: 50,
        },
      )
      await vi.advanceTimersByTimeAsync(60)
      expect(await running).toMatchObject({ kind: 'refused', code: 'decode-failed' })
      // And the process goes with it: a tile's request must not leave an
      // ffmpeg behind on a node that spawns one per clip.
      expect(ff.killed()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
