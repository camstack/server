/**
 * The still minted from a saved clip — the argv, and what each way of failing
 * is CALLED.
 *
 * The vouching itself is not here: it lives in `HksvClipStore`, because whether
 * a JPEG exists is a question for the filesystem and not for the process that
 * claims to have written it (`clip-store.spec.ts`). What these tests pin is the
 * other half — that a refusal arrives with a name, so an operator asking "why
 * has this clip no picture?" gets an answer instead of a blank tile.
 */
import { describe, expect, it } from 'vitest'

import type { ClipThumbnailRun, ClipThumbnailRunner } from '../clip-thumbnail.js'
import { buildClipThumbnailArgs, createClipThumbnailMinter } from '../clip-thumbnail.js'

function at(args: readonly string[], flag: string): number {
  return args.indexOf(flag)
}

function runner(result: ClipThumbnailRun): ClipThumbnailRunner {
  return async () => result
}

describe('buildClipThumbnailArgs', () => {
  it('decodes ONE frame at the trigger instant from the saved file', () => {
    const args = buildClipThumbnailArgs({
      clipPath: '/clips/101/a.mp4',
      jpegPath: '/clips/101/a.jpg',
      seekSec: 8,
      maxWidth: 640,
    })
    // Input seek: the clip is a real seekable file, not the pipe the recorder's
    // still path reads, so the cheap seek is the correct one here.
    expect(at(args, '-ss')).toBeLessThan(at(args, '-i'))
    expect(args[at(args, '-ss') + 1]).toBe('8')
    expect(args[at(args, '-i') + 1]).toBe('/clips/101/a.mp4')
    expect(args[at(args, '-frames:v') + 1]).toBe('1')
    expect(args).toContain('mjpeg')
    expect(args.at(-1)).toBe('/clips/101/a.jpg')
    expect(args).toContain('-nostdin')
  })

  it('never seeks backwards, whatever the caller passes', () => {
    const args = buildClipThumbnailArgs({
      clipPath: '/c.mp4',
      jpegPath: '/c.jpg',
      seekSec: -5,
      maxWidth: 640,
    })
    expect(args[at(args, '-ss') + 1]).toBe('0')
  })
})

describe('createClipThumbnailMinter — every refusal has a name', () => {
  const input = {
    deviceId: 101,
    clipPath: '/c.mp4',
    jpegPath: '/c.jpg',
    triggerOffsetSec: 8,
  }

  it('reports success when ffmpeg exits 0 — the STORE still checks the file', async () => {
    const mint = createClipThumbnailMinter({
      runner: runner({ code: 0, timedOut: false, spawnFailed: false, stderr: '' }),
    })
    expect(await mint(input)).toEqual({ ok: true })
  })

  it('seeks to the TRIGGER instant the caller passed, not to frame zero', async () => {
    const seen: string[][] = []
    const mint = createClipThumbnailMinter({
      runner: async (args) => {
        seen.push([...args])
        return { code: 0, timedOut: false, spawnFailed: false, stderr: '' }
      },
    })
    await mint(input)
    const args = seen[0] ?? []
    expect(args[args.indexOf('-ss') + 1]).toBe('8')
  })

  it('names a non-zero exit as a decode failure', async () => {
    const mint = createClipThumbnailMinter({
      runner: runner({ code: 1, timedOut: false, spawnFailed: false, stderr: 'boom' }),
    })
    expect(await mint(input)).toEqual({ ok: false, reason: 'decode-failed' })
  })

  it('names a timeout as a timeout, not a decode failure', async () => {
    const mint = createClipThumbnailMinter({
      runner: runner({ code: null, timedOut: true, spawnFailed: false, stderr: '' }),
    })
    expect(await mint(input)).toEqual({ ok: false, reason: 'timed-out' })
  })

  it('names a binary that could not be spawned', async () => {
    const mint = createClipThumbnailMinter({
      runner: runner({ code: null, timedOut: false, spawnFailed: true, stderr: 'ENOENT' }),
    })
    expect(await mint(input)).toEqual({ ok: false, reason: 'ffmpeg-missing' })
  })

  it('never throws — a runner that blows up is still a named refusal', async () => {
    const mint = createClipThumbnailMinter({
      runner: async () => {
        throw new Error('unexpected')
      },
    })
    expect(await mint(input)).toEqual({ ok: false, reason: 'decode-failed' })
  })
})
