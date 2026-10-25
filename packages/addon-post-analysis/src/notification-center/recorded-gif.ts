/**
 * The notification GIF for a moment only the RECORDINGS still hold — derived
 * from the recorded clip's own bytes (D682).
 *
 * ## Why this exists
 *
 * A package pick-up is concluded five minutes after the parcel went
 * (`PACKAGE_STILLNESS_TTL_MS`). Once its footage is anchored on the pick-up
 * itself rather than on the conclusion (`media-anchor.ts`), the window is far
 * older than any clip ring (≤ 60 s, `NC_CLIP_RETENTION_MAX_SEC`), so the ring
 * refuses it. A gif-only rule then had NOTHING: the recorded cut served only a
 * rule that asked for a video. The honest fix for "the gif shows the
 * empty doormat" is not "no gif" — it is the gif of the pick-up, from the
 * recordings.
 *
 * ## One cut, and the gif is DERIVED from it
 *
 * The recorded clip (`recorded-clip.ts`, one `recordingExport` render) is the
 * only cut. The gif is derived from ITS bytes with the SAME filter chain the
 * broker uses on a ring cut (`gifFromMp4Args` in `@camstack/types`), so a gif
 * of an old moment and a gif of a live one look the same, and a rule that asks
 * for both a gif and a video gets two containers of ONE window — the guarantee
 * `NcEventMediaRequest` exists for.
 *
 * ## Never throws, every miss named
 *
 * `derive-failed` (ffmpeg could not produce it) and `stage-failed` (the clip
 * could not be written where ffmpeg can read it) are logged with
 * `tags: { deviceId }` (D400: a missing attachment names its reason).
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gifDeriveSpeed, gifFromMp4Args, type IScopedLogger } from '@camstack/types'
import { NC_GIF_FPS, NC_GIF_MAX_WIDTH, NC_GIF_SPEED } from './event-media/event-media-service.js'

/** Bound on one derive: a ~10 s window encodes in well under a second; a
 *  derive that has not finished in 20 s is wedged. Same bound as the broker's. */
const NC_RECORDED_GIF_TIMEOUT_MS = 20_000

/** A notification gif is a few hundred KB; this is headroom, not a budget. */
const RECORDED_GIF_MAX_BUFFER = 32 * 1024 * 1024

/** Why no gif was derived. */
export type NcRecordedGifRefusal = 'stage-failed' | 'derive-failed'

/** The gif, or the named reason there is none. */
export type NcRecordedGifResult =
  | { readonly ok: true; readonly gif: Uint8Array<ArrayBuffer> }
  | { readonly ok: false; readonly reason: NcRecordedGifRefusal }

/** One derive. */
export interface NcRecordedGifRequest {
  readonly deviceId: number
  /** The recorded clip's bytes — the one cut this gif is derived from. */
  readonly mp4: Uint8Array
  /** The rate the clip was already rendered at. Absent ⇒ real time. */
  readonly videoSpeed?: number
  /** For the log lines only. */
  readonly ruleId: string
  readonly recordId: string
}

/** One command's stdout, or the error that stopped it (for the log line). */
export type NcRecordedGifRunResult =
  | { readonly ok: true; readonly stdout: Buffer }
  | { readonly ok: false; readonly error: string }

/** Runs one command. Never rejects. */
export type NcRecordedGifRun = (
  cmd: string,
  args: readonly string[],
) => Promise<NcRecordedGifRunResult>

/** Everything the derive reaches outside itself. */
export interface NcRecordedGifPorts {
  readonly logger: IScopedLogger
  /** The PINNED ffmpeg (`ctx.deps.ensureFfmpeg`, D540) — never the host's. */
  readonly resolveFfmpeg: () => Promise<string>
  readonly run: NcRecordedGifRun
  /** Stage the clip where ffmpeg can open it; the caller removes it. A file
   *  rather than a pipe: an export is faststart today, but a derive that
   *  depends on where the muxer put `moov` is one muxer change from failing. */
  readonly writeTemp: (bytes: Uint8Array) => Promise<string>
  readonly removeTemp: (file: string) => Promise<void>
}

/**
 * Derive the gif. Never throws; every `ok: false` has logged its reason.
 */
export async function deriveRecordedGif(
  ports: NcRecordedGifPorts,
  req: NcRecordedGifRequest,
): Promise<NcRecordedGifResult> {
  const tags = { deviceId: req.deviceId }
  const common = { ruleId: req.ruleId, eventId: req.recordId, sourceBytes: req.mp4.byteLength }
  let file: string
  try {
    file = await ports.writeTemp(req.mp4)
  } catch (err) {
    ports.logger.warn('recorded gif: could not stage the recorded clip — no gif', {
      tags,
      meta: { ...common, reason: 'stage-failed', error: String(err) },
    })
    return { ok: false, reason: 'stage-failed' }
  }
  try {
    const speed = gifDeriveSpeed(NC_GIF_SPEED, req.videoSpeed ?? 1)
    const args = gifFromMp4Args({
      maxWidth: NC_GIF_MAX_WIDTH,
      fps: NC_GIF_FPS,
      speed,
      input: file,
    })
    const startedAt = Date.now()
    let ran: NcRecordedGifRunResult
    try {
      ran = await ports.run(await ports.resolveFfmpeg(), args)
    } catch (err) {
      ran = { ok: false, error: String(err) }
    }
    const out = ran.ok ? ran.stdout : null
    if (out === null || out.byteLength === 0) {
      ports.logger.warn('recorded gif: the derive failed — the notification carries no gif', {
        tags,
        meta: {
          ...common,
          reason: 'derive-failed',
          error: ran.ok ? 'ffmpeg produced no bytes' : ran.error.slice(-400),
        },
      })
      return { ok: false, reason: 'derive-failed' }
    }
    const gif = new Uint8Array(new ArrayBuffer(out.byteLength))
    gif.set(out)
    ports.logger.info('recorded gif: derived from the recorded clip', {
      tags,
      meta: {
        ...common,
        gifBytes: gif.byteLength,
        width: NC_GIF_MAX_WIDTH,
        fps: NC_GIF_FPS,
        speed,
        encodeMs: Date.now() - startedAt,
      },
    })
    return { ok: true, gif }
  } finally {
    await ports.removeTemp(file).catch((err: unknown) => {
      // `force: true` already hides ENOENT, so whatever lands here is a real
      // leak in the temp directory — worth one line, never a failed gif.
      ports.logger.warn('recorded gif: could not remove the staged clip', {
        tags,
        meta: { ...common, file, error: String(err) },
      })
    })
  }
}

/** What the production wiring supplies. */
export interface NcRecordedGifPortsInput {
  readonly logger: IScopedLogger
  readonly resolveFfmpeg: () => Promise<string>
}

/** The production ports: the pinned ffmpeg, a temp file, a bounded child. */
export function buildRecordedGifPorts(input: NcRecordedGifPortsInput): NcRecordedGifPorts {
  return {
    logger: input.logger,
    resolveFfmpeg: input.resolveFfmpeg,
    run: (cmd, args) =>
      new Promise<NcRecordedGifRunResult>((resolve) => {
        execFile(
          cmd,
          [...args],
          {
            encoding: 'buffer',
            maxBuffer: RECORDED_GIF_MAX_BUFFER,
            timeout: NC_RECORDED_GIF_TIMEOUT_MS,
            killSignal: 'SIGKILL',
          },
          (err, stdout) =>
            resolve(err !== null ? { ok: false, error: String(err) } : { ok: true, stdout }),
        )
      }),
    writeTemp: (bytes) =>
      stageTempClip(path.join(os.tmpdir(), `camstack-nc-gif-${randomUUID()}.mp4`), bytes, {
        write: (file, data) => fs.writeFile(file, data),
        remove: (file) => fs.rm(file, { force: true }),
      }),
    removeTemp: (file) => fs.rm(file, { force: true }),
  }
}

/** The two filesystem calls staging needs — a seam so a write that fails
 *  PART-WAY can be exercised without filling a disk. */
export interface NcTempClipIo {
  readonly write: (file: string, bytes: Uint8Array) => Promise<void>
  readonly remove: (file: string) => Promise<void>
}

/**
 * Write the clip to `file`, and on a failed write remove whatever landed.
 *
 * The path is named BEFORE the write, because a write can create the file and
 * then fail (ENOSPC half-way): the caller's `finally` only knows a path the
 * write RETURNED, so a partial `camstack-nc-gif-*.mp4` used to stay in the temp
 * directory for good. The write's error is re-thrown — the caller names it
 * (`stage-failed`, tagged per camera). A removal that ALSO fails is a real leak
 * and rides in that same error's message, so it reaches that one line rather
 * than a second, untagged one.
 */
export async function stageTempClip(
  file: string,
  bytes: Uint8Array,
  io: NcTempClipIo,
): Promise<string> {
  try {
    await io.write(file, bytes)
    return file
  } catch (err) {
    const leaked = await io.remove(file).then(
      () => null,
      (removeErr: unknown) => String(removeErr),
    )
    if (leaked === null) throw err
    throw new Error(`${String(err)}; the partial file ${file} was NOT removed: ${leaked}`)
  }
}
