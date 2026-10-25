/**
 * Recorder STILL-frame service — decode ONE JPEG near a wall-clock instant from
 * the recorded LOW footage, on demand, for the export dialog's start/end frame
 * previews. Replaces the retired sprite-sheet scrub-thumbnail tier for this use.
 *
 * A one-off still (a dialog preview, not frame-rate playback), so the simplest
 * robust path is chosen: feed ffmpeg the segment file directly with an INPUT
 * seek (`-ss` before `-i`, which lands on the nearest keyframe at/before the
 * offset — cheap, no full decode) and ask for a single frame on stdout. No
 * WebCodecs, no mp4box parse, no persistent cache — a ~100ms one-shot is fine
 * for a dialog and keeps the endpoint stateless.
 */
import { spawn as childProcessSpawn, type ChildProcess } from 'node:child_process'
import type { IScopedLogger, PinnedFfmpegResolver } from '@camstack/types'
import { resolveStillSource, type LowSegmentRow } from './still-source.js'

/** Injectable ffmpeg spawn (matches `child_process.spawn`'s shape we use). */
export type FfmpegSpawn = (bin: string, args: readonly string[]) => ChildProcess

export interface StillFrameServiceDeps {
  /**
   * The `low` rows whose span COVERS `epochMs` — normally one, more only where
   * a restart re-recorded an instant.
   *
   * A window, deliberately, not the device's archive: this used to be
   * `listLowSegments(deviceId)`, a full COPY of the device's low rows (~10 k on
   * the live hub) linearly scanned to find the one. `resolveStillSource` still
   * owns the choice among the candidates — narrowing the input must never
   * become a second place that decides which segment wins.
   */
  readonly lowSegmentsAt: (deviceId: number, epochMs: number) => readonly LowSegmentRow[]
  readonly resolveAbsPath: (row: LowSegmentRow) => string
  readonly logger: IScopedLogger
  /** The node's pinned ffmpeg (D540). A rejection answers no still, logged per
   *  camera — never a PATH lookup. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  readonly spawn?: FfmpegSpawn
  readonly now?: () => number
}

export interface BuiltStill {
  readonly jpeg: Buffer
  /** A fully-written (past) segment → the still is immutable and cacheable. */
  readonly immutable: boolean
}

/** Hard ceiling on a single still decode (a stuck ffmpeg must never leak). */
const FFMPEG_TIMEOUT_MS = 15_000

/** At most this many concurrent ffmpeg decodes (the endpoint is authenticated
 * but request-driven — without a cap a client loop could fork-bomb the node). */
const MAX_CONCURRENT_DECODES = 3
/** Requests parked beyond the concurrency cap; overflow answers 204 instead of
 * queueing unboundedly. The real dialog fetches 2 stills — this is headroom. */
const MAX_WAIT_QUEUE = 8

export class StillFrameService {
  private inFlight = 0
  private readonly waitQueue: Array<() => void> = []

  constructor(private readonly deps: StillFrameServiceDeps) {}

  /** Acquire a decode slot; resolves false when the wait queue is saturated. */
  private acquireSlot(): Promise<boolean> {
    if (this.inFlight < MAX_CONCURRENT_DECODES) {
      this.inFlight += 1
      return Promise.resolve(true)
    }
    if (this.waitQueue.length >= MAX_WAIT_QUEUE) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      this.waitQueue.push(() => {
        this.inFlight += 1
        resolve(true)
      })
    })
  }

  private releaseSlot(): void {
    this.inFlight -= 1
    const next = this.waitQueue.shift()
    if (next !== undefined) next()
  }

  /**
   * Decode the frame covering `epochMs`. Returns the JPEG + immutability, or
   * null when no footage covers the instant / the decode yields no bytes (the
   * caller replies 204 → the dialog shows its placeholder).
   */
  async getStill(deviceId: number, epochMs: number): Promise<BuiltStill | null> {
    const source = resolveStillSource(this.deps.lowSegmentsAt(deviceId, epochMs), epochMs)
    if (source === null) {
      // A 204 with no line reads as "the dialog never asked". It is also the
      // shape a mis-narrowed candidate window would take, so the miss says so.
      this.deps.logger.debug('still: no low segment covers the instant', {
        tags: { deviceId },
        meta: { epochMs },
      })
      return null
    }
    const abs = this.deps.resolveAbsPath(source.row)
    const now = (this.deps.now ?? Date.now)()
    const immutable = source.row.startMs + source.row.durMs < now
    const acquired = await this.acquireSlot()
    if (!acquired) {
      this.deps.logger.debug('still: decode queue saturated, dropping request', {
        tags: { deviceId },
        meta: { epochMs },
      })
      return null
    }
    try {
      let bin: string
      try {
        bin = await this.deps.resolveFfmpeg()
      } catch (err: unknown) {
        this.deps.logger.error('still: refused — no pinned ffmpeg on this node (D540)', {
          tags: { deviceId },
          meta: { epochMs, error: err instanceof Error ? err.message : String(err) },
        })
        return null
      }
      const jpeg = await this.decodeFrame(bin, abs, source.offsetSec)
      if (jpeg === null || jpeg.byteLength === 0) return null
      return { jpeg, immutable }
    } finally {
      this.releaseSlot()
    }
  }

  /** Run ONE ffmpeg input-seek + single-frame decode; JPEG bytes on stdout. */
  private decodeFrame(bin: string, absPath: string, offsetSec: number): Promise<Buffer | null> {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      // INPUT seek (before -i): fast, lands on the nearest keyframe ≤ offset.
      '-ss',
      offsetSec.toFixed(3),
      '-i',
      absPath,
      '-frames:v',
      '1',
      '-f',
      'mjpeg',
      'pipe:1',
    ]
    const spawn = this.deps.spawn ?? childProcessSpawn
    return new Promise<Buffer | null>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(bin, args)
      } catch (err: unknown) {
        this.deps.logger.debug('still: ffmpeg spawn failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        resolve(null)
        return
      }
      const chunks: Buffer[] = []
      child.stdout?.on('data', (c: Buffer) => chunks.push(c))
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        this.deps.logger.debug('still: ffmpeg decode timed out', { meta: { absPath } })
        resolve(null)
      }, FFMPEG_TIMEOUT_MS)
      timer.unref?.()
      child.on('error', (err) => {
        clearTimeout(timer)
        this.deps.logger.debug('still: ffmpeg error', { meta: { error: err.message } })
        resolve(null)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0 && chunks.length === 0) {
          resolve(null)
          return
        }
        resolve(chunks.length > 0 ? Buffer.concat(chunks) : null)
      })
    })
  }
}
