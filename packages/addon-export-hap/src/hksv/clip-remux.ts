/**
 * The faststart pass: the teed clip is made SEEKABLE, once, by the process that
 * minted it.
 *
 * ## Why the producer owes this
 *
 * The tee cuts like a pipe. ffmpeg writes `frag_keyframe+empty_moov` and never
 * returns to write a trailer, so on a teed clip `mvhd.duration` and
 * `mdhd.duration` are **0**, the `stbl` sample tables are EMPTY and there is no
 * `mfra`. Measured, on this hub's own files. The result decodes end to end — it
 * plays — but nothing can map a time to a byte in it, and a time-to-byte map is
 * the whole of what a scrub, a `Range` request and a stated duration are.
 *
 * The alternative was a remux in the CONSUMER, at play time. That puts an
 * ffmpeg per viewer in the broker's runner and buffers the whole file to write
 * a trailer, every time anybody drags — the cost D570 § 5(b) rejected, moved
 * one process along. Here it is one pass per clip, at the moment the clip is
 * born, measured at 40 ms and +0.7 % bytes. A clip is written once and read
 * many times; this is the side of that asymmetry the work belongs on.
 *
 * ## The constraint that outranks the feature
 *
 * Exactly as for the tee itself: **a clip that does not seek is a clip; a clip
 * the remux ate is a HomeKit recording the operator lost.** So the pass writes
 * a SIBLING and renames over the original only once it has vouched for it, it
 * never throws, and every way of failing has its own name on the record —
 * a missing binary, a deadline and a file ffmpeg blessed but did not fix are
 * three different operator actions.
 *
 * ## The vouch is a measurement, not an exit code
 *
 * `-movflags +faststart` exiting 0 is not evidence. {@link moovPrecedesMdat}
 * reads the top-level box order off the produced file and requires `moov`
 * ahead of the media — and requires the file to be PROGRESSIVE, because the
 * fragmented shape the tee already wrote is *also* moov-first and is exactly
 * what this pass exists to replace.
 */
import { readFile, rename, rm, stat } from 'node:fs/promises'

import type { ClipFfmpegRunner } from './clip-ffmpeg-run.js'

/** A remux that has not finished by here is not going to. */
export const CLIP_REMUX_TIMEOUT_MS = 30_000

/** The sibling the pass writes before it has earned the clip's own name. */
export const CLIP_REMUX_SUFFIX = '.faststart'

/**
 * How much of the head is read back to judge the box order. The `moov` of a
 * short clip is a few hundred KB at most, and this only has to reach far enough
 * to meet the first `mdat` or `moof`.
 */
const HEAD_BYTES = 1_024 * 1_024

/** Why a teed clip could not be made seekable. Named, never blank. */
export type ClipRemuxFailureReason =
  /** The binary could not be spawned at all. */
  | 'ffmpeg-missing'
  /** ffmpeg exceeded its bound and was killed. */
  | 'timed-out'
  /** ffmpeg ran and produced no usable output — including "said ok, wrote nothing". */
  | 'remux-failed'
  /** ffmpeg exited 0 and the output is still not a front-loaded progressive MP4. */
  | 'not-seekable'

export type ClipRemuxResult =
  | {
      readonly ok: true
      readonly bytes: number
      /**
       * The duration the produced file actually HOLDS, read from its `mvhd`.
       * Absent when it could not be measured — never zero (D393).
       */
      readonly durationMs?: number
    }
  | { readonly ok: false; readonly reason: ClipRemuxFailureReason }

export interface ClipRemuxInput {
  readonly clipPath: string
}

export type ClipRemuxer = (input: ClipRemuxInput) => Promise<ClipRemuxResult>

export interface ClipRemuxArgsInput {
  readonly clipPath: string
  readonly outPath: string
}

export function buildClipRemuxArgs(input: ClipRemuxArgsInput): readonly string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-i',
    input.clipPath,
    // Stream copy. The clip is already the H.264 HomeKit was served; decoding
    // it to re-encode it would cost a transcode per recording and change the
    // bytes HomeKit acknowledged.
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    // Stated, never inferred. The sibling below is deliberately not `.mp4` —
    // so a sweep cannot mistake a half-written temporary for a clip — and
    // ffmpeg picks its muxer from the extension unless told. Left to infer, it
    // refuses the output outright and every clip comes back `remux-failed`.
    '-f',
    'mp4',
    input.outPath,
  ]
}

export interface ClipRemuxerInput {
  readonly runner: ClipFfmpegRunner
}

export function createClipRemuxer(input: ClipRemuxerInput): ClipRemuxer {
  return async ({ clipPath }): Promise<ClipRemuxResult> => {
    const outPath = `${clipPath}${CLIP_REMUX_SUFFIX}`
    try {
      const run = await input.runner(buildClipRemuxArgs({ clipPath, outPath }))
      if (run.spawnFailed) return await discard(outPath, 'ffmpeg-missing')
      if (run.timedOut) return await discard(outPath, 'timed-out')
      if (run.code !== 0) return await discard(outPath, 'remux-failed')

      const size = await sizeOf(outPath)
      if (size === null || size === 0) return await discard(outPath, 'remux-failed')
      const head = await readHead(outPath)
      if (!moovPrecedesMdat(head)) return await discard(outPath, 'not-seekable')

      // The real duration is now in the file, in a header sitting at its
      // front. Free to read, and the only honest number available: the tee's
      // own wall clock misses the prebuffer footage the first fragments carry
      // — measured 12.0 s claimed against 19.99 s held, on 101.
      const durationMs = readMovieDurationMs(head)

      // Only now does it earn the clip's own name. In place, because the id,
      // the record and the data-plane route all name that one path.
      await rename(outPath, clipPath)
      return { ok: true, bytes: size, ...(durationMs === null ? {} : { durationMs }) }
    } catch {
      return await discard(outPath, 'remux-failed')
    }
  }
}

async function discard(outPath: string, reason: ClipRemuxFailureReason): Promise<ClipRemuxResult> {
  await rm(outPath, { force: true }).catch(() => undefined)
  return { ok: false, reason }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

async function readHead(path: string): Promise<Uint8Array> {
  const buf = await readFile(path)
  return new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, HEAD_BYTES))
}

/**
 * Does this file carry a progressive index ahead of its media?
 *
 * Walks the TOP-LEVEL boxes only. Three verdicts collapse into `false`, and
 * each of them is a real file this store has held:
 *
 *  - `moov` after `mdat` — a plain mux, seekable only once the whole file is
 *    in hand, which over a `Range` reader means never.
 *  - `moof` before any `mdat` — the FRAGMENTED shape the tee writes. Its
 *    leading `moov` is the empty one `empty_moov` produced, so judging on
 *    position alone would bless exactly the file this pass replaces.
 *  - anything unreadable — a truncated header, or a box claiming a size that
 *    does not advance the cursor. A corrupt file is never guessed at, and a
 *    non-advancing size is how a scanner spins for ever.
 */
export function moovPrecedesMdat(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  let sawMoov = false
  while (at + 8 <= bytes.byteLength) {
    const declared = view.getUint32(at)
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    let size = declared
    let header = 8
    if (declared === 1) {
      if (at + 16 > bytes.byteLength) return false
      const large = view.getBigUint64(at + 8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false
      size = Number(large)
      header = 16
    }
    if (size < header) return false
    if (type === 'moov') sawMoov = true
    // `mdat` and `moof` both end the question: the first is the media, the
    // second says the samples are in the fragments and not in `moov` at all.
    if (type === 'mdat') return sawMoov
    if (type === 'moof') return false
    at += size
  }
  return false
}

/**
 * The movie duration, in ms, from the `mvhd` inside `moov`.
 *
 * `null`, never `0`, for every way of not knowing — no `moov`, no `mvhd`, a
 * truncated header, a zero timescale, or the **zero duration `empty_moov`
 * writes**, which is the case that matters: believing it would replace a
 * duration that is merely wrong with one that confidently says the clip is
 * empty (D393).
 *
 * Worth having because the alternative number is wrong in a specific,
 * measurable way: `endedAtMs - startedAtMs` is how long the TEE ran, and the
 * first fragments it wrote were the prebuffer — footage older than the tee
 * itself. On 101 that is 12.0 s claimed against 19.99 s held.
 */
export function readMovieDurationMs(bytes: Uint8Array): number | null {
  const moov = findTopLevelBox(bytes, 'moov')
  if (moov === null) return null
  const mvhd = findTopLevelBox(moov, 'mvhd')
  if (mvhd === null || mvhd.byteLength < 4) return null
  const view = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength)
  const version = mvhd[0]
  // The box PAYLOAD: version(1) flags(3), then creation and modification
  // (4 bytes each at version 0, 8 at version 1), timescale(4), duration.
  const timescaleAt = version === 1 ? 4 + 16 : 4 + 8
  const durationAt = timescaleAt + 4
  const durationSize = version === 1 ? 8 : 4
  if (durationAt + durationSize > mvhd.byteLength) return null
  const timescale = view.getUint32(timescaleAt)
  if (timescale === 0) return null
  const duration =
    version === 1 ? Number(view.getBigUint64(durationAt)) : view.getUint32(durationAt)
  if (duration <= 0 || !Number.isFinite(duration)) return null
  return Math.round((duration / timescale) * 1000)
}

/**
 * The PAYLOAD — header stripped — of the first top-level box of `type`, or
 * `null`. Stripped, because the only reason to hold a box here is to walk its
 * children, and leaving the header on makes the first child look like the
 * parent.
 *
 * Deliberately the same walk as {@link moovPrecedesMdat} rather than a shared
 * generator: that one answers a question about ORDER and stops at the media,
 * this one descends. Both refuse a box that does not advance the cursor, which
 * is the property neither can do without.
 */
function findTopLevelBox(bytes: Uint8Array, type: string): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  while (at + 8 <= bytes.byteLength) {
    const declared = view.getUint32(at)
    const found = String.fromCharCode(
      bytes[at + 4]!,
      bytes[at + 5]!,
      bytes[at + 6]!,
      bytes[at + 7]!,
    )
    let size = declared
    let header = 8
    if (declared === 1) {
      if (at + 16 > bytes.byteLength) return null
      const large = view.getBigUint64(at + 8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null
      size = Number(large)
      header = 16
    }
    if (size < header) return null
    const end = Math.min(at + size, bytes.byteLength)
    if (found === type) return at + header >= end ? null : bytes.subarray(at + header, end)
    at += size
  }
  return null
}
