/**
 * ONE JPEG out of a composition that is already running.
 *
 * ## Why this is not the ffmpeg primitive
 *
 * `FfmpegProcess` + `buildFfmpegArgs` own the STREAM job: a long-lived encode
 * with a hardware cascade, a first-data deadline and a bounded restart. This is
 * the other kind — run-to-completion, no encode plan worth sharing, finishes or
 * is killed — which is the class `scripts/check-ffmpeg-primitive.ts` already
 * carves out by name for `recorder/still/still-frame-service.ts` ("single-JPEG
 * still grab") and `builtins/snapshot/snapshot.addon.ts` ("keyframe snapshot
 * grab"). It is the same job as those two, on a pipe instead of a URL.
 *
 * ## Why a pipe and not the grid's own URL
 *
 * Dialling the relay would be a CONSUMER, and a consumer of a cold grid starts
 * the composition — N broker acquisitions for a thumbnail, which is the one
 * thing the operator ruled out. Reading the bytes of a session that is ALREADY
 * running costs nothing: the child is up, the packets are being produced, and
 * this just takes a copy of them.
 *
 * Bounded on both ends. A composition whose first key frame is far away must
 * not hold an ffmpeg (or this promise) open for ever, so the grab has a
 * deadline and the child is killed at it — a snapshot that did not arrive is
 * `null`, and `null` is a real answer.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { errMsg } from '@camstack/types'
import { GRID_WIRE_CONTAINER } from './grid-wire-format.js'
import type { GridStreamLogger } from './grid-stream-session.js'

/** Long enough for a 2 s GOP plus a probe, short enough that a list does not hang. */
const DEFAULT_TIMEOUT_MS = 8_000

/** JPEG quality. 4 is visually clean at thumbnail and list sizes and ~40 KB at 1080p. */
const JPEG_QUALITY = '4'

export type GridSpawn = typeof nodeSpawn

export interface GridFrameSamplerOptions {
  readonly binaryPath: string
  readonly logger: GridStreamLogger
  readonly timeoutMs?: number
  /** Injectable for tests. */
  readonly spawnFn?: GridSpawn
}

/** How a caller feeds the sampler: it hands over chunks and a way to stop. */
export interface GridFrameSource {
  /** Start receiving MPEG-TS chunks. Returns the handle that stops them. */
  attach(onChunk: (chunk: Buffer) => void): { close(): void } | null
}

export class GridFrameSampler {
  constructor(private readonly options: GridFrameSamplerOptions) {}

  /**
   * @returns the JPEG, or `null` — a grab that produced nothing, could not be
   * attached, or ran out of time. Every one of those is logged with the
   * device: a branch that accepts the request and produces nothing must say so.
   */
  async sample(deviceId: number, source: GridFrameSource): Promise<Buffer | null> {
    const spawnFn = this.options.spawnFn ?? nodeSpawn
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const child = spawnFn(
      this.options.binaryPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        // The composition's container, and it has to MATCH: the session hands
        // this sampler the same FLV bytes it hands the broker. Left at
        // `mpegts` after the switch, ffmpeg found no stream and every grab
        // returned nothing — the WARN said "the frame grab produced no bytes"
        // and named neither the format nor the reason (hub, 2026-09-17).
        '-f',
        GRID_WIRE_CONTAINER,
        '-i',
        'pipe:0',
        '-frames:v',
        '1',
        '-q:v',
        JPEG_QUALITY,
        '-f',
        'mjpeg',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )

    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', () => {
      // Drained so a full pipe buffer cannot freeze the grab. The reason a
      // grab failed is reported by its EMPTINESS, which is what the caller acts
      // on; ffmpeg's own words about a half-second of mid-GOP packets are not.
    })

    const hold = source.attach((chunk) => {
      if (child.stdin?.writable === true) child.stdin.write(chunk)
    })
    if (hold === null) {
      child.kill('SIGKILL')
      this.options.logger.warn('camera grid: could not attach to sample a frame', {
        tags: { deviceId },
      })
      return null
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref?.()

    try {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.once('error', () => resolve())
      })
    } finally {
      clearTimeout(timer)
      hold.close()
      try {
        child.stdin?.end()
      } catch (error) {
        this.options.logger.debug('camera grid: the frame grab stdin refused to close', {
          tags: { deviceId },
          meta: { error: errMsg(error) },
        })
      }
    }

    const jpeg = Buffer.concat(chunks)
    if (jpeg.length === 0) {
      this.options.logger.warn('camera grid: the frame grab produced no bytes', {
        tags: { deviceId },
        meta: { timeoutMs },
      })
      return null
    }
    return jpeg
  }
}
