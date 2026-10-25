/**
 * The teed clip is made SEEKABLE, and the claim that it is, is a measurement.
 *
 * The tee cuts like a pipe: ffmpeg writes a fragmented MP4 and never returns to
 * write a trailer, so `mvhd.duration` is 0, there is no `mfra` and the sample
 * tables are empty. The file DECODES end to end — it plays — but nothing can
 * map a time to a byte in it, which is the whole of what a scrub, a Range
 * request and a duration are.
 *
 * Driven against a REAL temporary directory, for the same reason `clip-store`
 * is: every claim here is a claim about a file. In particular the vouch — "the
 * output really is front-loaded" — cannot be shown by a runner that says `ok`,
 * because "said ok, wrote a fragmented file" is precisely the failure being
 * guarded. The runner is a seam; the file is the evidence.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClipFfmpegRun } from '../clip-ffmpeg-run.js'
import {
  buildClipRemuxArgs,
  createClipRemuxer,
  CLIP_REMUX_TIMEOUT_MS,
  moovPrecedesMdat,
  readMovieDurationMs,
} from '../clip-remux.js'

/** A top-level MP4 box: 4-byte big-endian size, 4-byte type, then payload. */
function box(type: string, payloadLength: number): Uint8Array {
  const out = new Uint8Array(8 + payloadLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, 8 + payloadLength)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  return out
}

/** The same, with the 64-bit `largesize` escape (`size === 1`). */
function largeBox(type: string, payloadLength: number): Uint8Array {
  const out = new Uint8Array(16 + payloadLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, 1)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  view.setBigUint64(8, BigInt(16 + payloadLength))
  return out
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** What `+faststart` produces: `moov` ahead of the media. */
const FRONT_LOADED = concat(box('ftyp', 16), box('moov', 200), box('mdat', 4_000))
/** What a plain progressive mux produces: seekable only after a full parse. */
const TAIL_MOOV = concat(box('ftyp', 16), box('mdat', 4_000), box('moov', 200))
/** What the TEE produces: `moov` is empty and the fragments carry the samples. */
const FRAGMENTED = concat(box('ftyp', 16), box('moov', 40), box('moof', 90), box('mdat', 4_000))

describe('moovPrecedesMdat — the vouch', () => {
  it('accepts a front-loaded file', () => {
    expect(moovPrecedesMdat(FRONT_LOADED)).toBe(true)
  })

  it('refuses a file whose moov is behind the media', () => {
    expect(moovPrecedesMdat(TAIL_MOOV)).toBe(false)
  })

  it('refuses the fragmented shape the tee writes, moov-first though it is', () => {
    // `moof` before `mdat` means the samples live in the fragments, and the
    // leading `moov` is the empty one `empty_moov` wrote. Front-loaded by
    // position, unseekable in fact — this is the case the whole slice exists
    // for, so accepting it would make every other test here vacuous.
    expect(moovPrecedesMdat(FRAGMENTED)).toBe(false)
  })

  it('steps over the padding ffmpeg leaves between the index and the media', () => {
    // Not hypothetical: real `+faststart` output is `ftyp,moov,free,mdat` —
    // the pass reserves the moov's space and pads the difference. A scanner
    // that expected `mdat` to come next would refuse every file it just fixed.
    expect(
      moovPrecedesMdat(
        concat(box('ftyp', 16), box('moov', 200), box('free', 8), box('mdat', 4_000)),
      ),
    ).toBe(true)
  })

  it('reads the 64-bit largesize escape rather than walking off the file', () => {
    expect(moovPrecedesMdat(concat(largeBox('ftyp', 16), box('moov', 32), box('mdat', 64)))).toBe(
      true,
    )
  })

  it('refuses a truncated header instead of guessing', () => {
    expect(moovPrecedesMdat(FRONT_LOADED.slice(0, 6))).toBe(false)
  })

  it('refuses a box that does not advance the cursor, rather than spinning on it', () => {
    // A declared size of 0 advances by nothing. Without the `size < header`
    // guard this does not return the wrong answer — it never returns at all,
    // which is why the assertion here is reached at all rather than what it
    // says. A scanner that can hang is a runner that can hang.
    const corrupt = new Uint8Array(32)
    new DataView(corrupt.buffer).setUint32(0, 0)
    expect(moovPrecedesMdat(corrupt)).toBe(false)
  })
})

/** A `moov` carrying one `mvhd` of the given version. */
function moovWithMvhd(version: 0 | 1, timescale: number, duration: number): Uint8Array {
  const payload = version === 0 ? 100 : 112
  const mvhd = new Uint8Array(8 + payload)
  const mv = new DataView(mvhd.buffer)
  mv.setUint32(0, mvhd.length)
  for (let i = 0; i < 4; i += 1) mvhd[4 + i] = 'mvhd'.charCodeAt(i)
  mvhd[8] = version
  if (version === 0) {
    mv.setUint32(20, timescale)
    mv.setUint32(24, duration)
  } else {
    mv.setUint32(28, timescale)
    mv.setBigUint64(32, BigInt(duration))
  }
  const moov = new Uint8Array(8 + mvhd.length)
  const mo = new DataView(moov.buffer)
  mo.setUint32(0, moov.length)
  for (let i = 0; i < 4; i += 1) moov[4 + i] = 'moov'.charCodeAt(i)
  moov.set(mvhd, 8)
  return moov
}

describe('readMovieDurationMs — the duration the file actually holds', () => {
  it('reads a version-0 header', () => {
    expect(readMovieDurationMs(concat(box('ftyp', 16), moovWithMvhd(0, 1_000, 19_991)))).toBe(
      19_991,
    )
  })

  it('reads the 64-bit version-1 header', () => {
    expect(readMovieDurationMs(concat(box('ftyp', 16), moovWithMvhd(1, 90_000, 1_799_190)))).toBe(
      19_991,
    )
  })

  it('answers NULL, never zero, when there is no moov', () => {
    // A failed measurement is unknown (D393). Zero would tell a scrub axis the
    // clip is empty, which is a different and confident lie.
    expect(readMovieDurationMs(concat(box('ftyp', 16), box('mdat', 64)))).toBeNull()
  })

  it('answers NULL for the EMPTY header the tee writes', () => {
    // `empty_moov` gives `mvhd.duration = 0`, measured on this hub's own
    // clips. Believing it would replace a duration that is merely short with
    // one that is zero.
    expect(readMovieDurationMs(concat(box('ftyp', 16), moovWithMvhd(0, 1_000, 0)))).toBeNull()
  })

  it('answers NULL rather than dividing by a zero timescale', () => {
    expect(readMovieDurationMs(concat(box('ftyp', 16), moovWithMvhd(0, 0, 500)))).toBeNull()
  })

  it('answers NULL when the header is truncated mid-field', () => {
    const whole = concat(box('ftyp', 16), moovWithMvhd(0, 1_000, 19_991))
    expect(readMovieDurationMs(whole.slice(0, whole.length - 90))).toBeNull()
  })
})

describe('buildClipRemuxArgs', () => {
  it('copies the streams and front-loads the index, into a DIFFERENT file', () => {
    const args = buildClipRemuxArgs({ clipPath: '/c/a.mp4', outPath: '/c/a.mp4.faststart' })
    expect(args).toContain('-c')
    expect(args).toContain('copy')
    expect(args.join(' ')).toContain('+faststart')
    expect(args).toContain('/c/a.mp4')
    expect(args[args.length - 1]).toBe('/c/a.mp4.faststart')
    // Re-encoding a clip would cost a decode per HomeKit recording on a hub
    // that already runs a permanent prebuffer per recorded camera.
    expect(args).not.toContain('libx264')
  })

  it('NAMES the muxer, because the output filename is ours and carries no extension', () => {
    // Measured on the hub, on a real teed clip: without this ffmpeg refuses
    // with "Unable to choose an output format for '...faststart'; use a
    // standard extension" and writes nothing — every clip came back
    // `remux-failed`. The sibling is deliberately NOT `.mp4`, so that a sweep
    // can never mistake a half-written temporary for a clip; the format
    // therefore has to be stated rather than inferred from a name chosen for a
    // different reason.
    const args = buildClipRemuxArgs({ clipPath: '/c/a.mp4', outPath: '/c/a.mp4.faststart' })
    const at = args.indexOf('-f')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(args[at + 1]).toBe('mp4')
    // Before the output path, or it is an input option.
    expect(at).toBeLessThan(args.length - 1)
  })
})

describe('createClipRemuxer', () => {
  let dir: string
  let clipPath: string
  const ORIGINAL = concat(box('ftyp', 16), box('moov', 40), box('moof', 90), box('mdat', 1_000))

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hksv-remux-'))
    clipPath = join(dir, 'clip.mp4')
    await writeFile(clipPath, ORIGINAL)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const ok: ClipFfmpegRun = { code: 0, timedOut: false, spawnFailed: false, stderr: '' }

  /** A runner that writes `bytes` where ffmpeg would have, then exits `run`. */
  function runnerWriting(bytes: Uint8Array | null, run: ClipFfmpegRun = ok) {
    return async (args: readonly string[]): Promise<ClipFfmpegRun> => {
      const out = args[args.length - 1] ?? ''
      if (bytes !== null) await writeFile(out, bytes)
      return run
    }
  }

  it('replaces the clip in place and reports the file it actually left behind', async () => {
    const remuxed = concat(box('ftyp', 16), moovWithMvhd(0, 1_000, 19_991), box('mdat', 1_000))
    const result = await createClipRemuxer({ runner: runnerWriting(remuxed) })({ clipPath })

    expect(result).toEqual({ ok: true, bytes: remuxed.length, durationMs: 19_991 })
    // In place: the id, the record and the data-plane route all name this path.
    expect(new Uint8Array(await readFile(clipPath))).toEqual(remuxed)
    // `bytes` is re-stat'd rather than carried over, or the record would state
    // the pre-remux size for ever — off by the +0.7 % the pass costs.
    expect(result.ok ? result.bytes : -1).not.toBe(ORIGINAL.length)
  })

  it('carries no duration it could not measure, rather than a zero', async () => {
    const remuxed = concat(box('ftyp', 16), box('moov', 220), box('mdat', 1_000))
    const result = await createClipRemuxer({ runner: runnerWriting(remuxed) })({ clipPath })

    expect(result).toEqual({ ok: true, bytes: remuxed.length })
  })

  it('leaves no temporary file behind on success', async () => {
    const remuxed = concat(box('ftyp', 16), box('moov', 220), box('mdat', 1_000))
    await createClipRemuxer({ runner: runnerWriting(remuxed) })({ clipPath })
    await expect(stat(`${clipPath}.faststart`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('REFUSES an output that ffmpeg blessed but that is still not seekable', async () => {
    // The whole reason the store vouches instead of believing an exit code.
    const result = await createClipRemuxer({ runner: runnerWriting(FRAGMENTED) })({ clipPath })

    expect(result).toEqual({ ok: false, reason: 'not-seekable' })
  })

  it.each([
    ['ffmpeg-missing', { code: null, timedOut: false, spawnFailed: true, stderr: 'ENOENT' }],
    ['timed-out', { code: null, timedOut: true, spawnFailed: false, stderr: '' }],
    ['remux-failed', { code: 1, timedOut: false, spawnFailed: false, stderr: 'invalid data' }],
  ] as const)('names %s rather than collapsing it into "no seek"', async (reason, run) => {
    const result = await createClipRemuxer({ runner: runnerWriting(null, run) })({ clipPath })

    expect(result).toEqual({ ok: false, reason })
  })

  it('names an output that never appeared', async () => {
    const result = await createClipRemuxer({ runner: runnerWriting(null) })({ clipPath })

    expect(result).toEqual({ ok: false, reason: 'remux-failed' })
  })

  it('never throws, whatever the runner does', async () => {
    const result = await createClipRemuxer({
      runner: async () => {
        throw new Error('spawn exploded')
      },
    })({ clipPath })

    expect(result).toEqual({ ok: false, reason: 'remux-failed' })
  })

  it.each([
    ['a refused output', runnerWriting(FRAGMENTED)],
    [
      'a failed run',
      runnerWriting(null, { code: 1, timedOut: false, spawnFailed: false, stderr: '' }),
    ],
    [
      'a thrown runner',
      async () => {
        throw new Error('boom')
      },
    ],
  ])('KEEPS the original clip intact after %s', async (_label, runner) => {
    // The constraint that outranks the feature: a clip that does not seek is a
    // clip. A clip the remux ate is a HomeKit recording the operator lost.
    await createClipRemuxer({ runner })({ clipPath })

    expect(new Uint8Array(await readFile(clipPath))).toEqual(ORIGINAL)
    await expect(stat(`${clipPath}.faststart`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds itself, so a clip it cannot parse costs one deadline and not a process', () => {
    expect(CLIP_REMUX_TIMEOUT_MS).toBeGreaterThan(0)
    expect(CLIP_REMUX_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })
})
