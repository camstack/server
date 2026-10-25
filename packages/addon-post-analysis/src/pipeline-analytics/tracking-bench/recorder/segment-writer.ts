/**
 * One segment file: JSONL through one async gzip stream (spec §3.3).
 *
 * `append` never blocks and never throws on backpressure. When the sink says
 * "wait", records queue — for up to {@link BACKPRESSURE_MAX_MS} of RECORD time
 * after the first queued one — and past that they are DROPPED. On `drain` the
 * queue is written, then one `gap` record naming what was lost, and a line
 * `tracking tape gap` tagged with the camera. The frame path is the hub's
 * analytics thread; a tape is not worth stalling it.
 *
 * Every exit of this writer is logged, tagged with the camera (D447): the
 * backpressure `gap`, hitting the size cap (once), a clean `close`, and a
 * `close` whose sink could not finish — the last of these is caught here and
 * turned into an outcome the caller can see, never an uncaught rejection.
 */
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { errMsg, type IScopedLogger } from '@camstack/types'
import { encodeTapeLine } from '../tape-codec.js'
import type { TapeEndReason, TapeGap, TapeRecord } from '../tape-schema.js'

export const BACKPRESSURE_MAX_MS = 5_000
const SEGMENT_MAX_RAW_BYTES = 32 * 1024 * 1024

export interface TapeSink {
  /** `false` = buffered, wait for `drain` before writing more. */
  write(line: string): boolean
  onceDrain(listener: () => void): void
  /**
   * Push zlib's pending output to the file without closing the segment
   * (D681 follow-up: a silent camera's open segment otherwise keeps its
   * tail in the gzip buffer until rotation — crash loss + lagging
   * `bytesLastHour`).
   */
  flush(): Promise<void>
  finish(): Promise<void>
}

/**
 * Wrap a destination writable in a gzip transform, wired with `pipeline()`,
 * and return it as a `TapeSink`. `openGzipFileSink` is a thin
 * `createWriteStream` wrapper around this.
 *
 * `pipeline()`, not `gzip.pipe(out)`: a plain `.pipe()` does NOT destroy the
 * source when the destination errors (a documented Node caveat) — the gzip
 * stream would keep accepting writes with nowhere to drain, exactly the
 * unbounded-buffer risk this file's backpressure/size-cap discipline exists
 * to prevent, just triggered by a disk fault instead of a slow consumer.
 * `pipeline()` destroys BOTH streams the moment either one errors.
 *
 * Exported (rather than folded into `openGzipFileSink`) so a spec can drive
 * the destination directly — a `node:stream` `PassThrough`, destroyed with an
 * error — and prove the cross-destroy without depending on a real disk fault.
 */
export function openGzipStream(out: Writable): TapeSink {
  const gzip = createGzip()
  const closed = pipeline(gzip, out)
  // A stream can error at ANY time, long before a segment rotates and
  // `finish()` gets around to awaiting `closed` — Node marks a rejection
  // "unhandled" (and, by default, crashes the process) the moment a promise
  // rejects with no reaction attached in that same tick, not when someone
  // eventually awaits it. Observing it here, with a no-op, does not consume
  // it for `finish()`'s own `await closed` below — every awaiter of one
  // promise gets its own independent settlement.
  closed.catch(() => {})
  return {
    write: (line) => gzip.write(line),
    onceDrain: (listener) => {
      gzip.once('drain', listener)
    },
    flush: () =>
      new Promise<void>((resolve, reject) => {
        // The typed callback takes no argument: a flush that failed leaves the
        // stream `errored`, which is read here rather than from an untyped arg.
        gzip.flush(() => {
          const err = gzip.errored
          if (err !== null) reject(err)
          else resolve()
        })
      }),
    finish: async () => {
      gzip.end()
      await closed
    },
  }
}

export async function openGzipFileSink(file: string): Promise<TapeSink> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  return openGzipStream(createWriteStream(file))
}

export type AppendOutcome = 'written' | 'queued' | 'dropped' | 'full'
export type CloseOutcome = 'closed' | 'close-failed'

export interface SegmentWriterDeps {
  readonly sink: TapeSink
  readonly deviceId: number
  readonly segmentOriginMs: number
  readonly logger: IScopedLogger
  readonly maxRawBytes?: number
}

export interface SegmentCounts {
  readonly frames: number
  readonly skips: number
  readonly gaps: number
}

/** Record time lost to backpressure, reported as one `gap` on drain. */
interface LostSpan {
  readonly fromT: number
  readonly toT: number
}

export class TapeSegmentWriter {
  private readonly deps: SegmentWriterDeps
  private readonly maxRawBytes: number
  private blocked = false
  private readonly queue: TapeRecord[] = []
  private queueStartT = 0
  private lost: LostSpan | null = null
  private raw = 0
  private frames = 0
  private skips = 0
  private gaps = 0
  private loggedFull = false

  constructor(deps: SegmentWriterDeps) {
    this.deps = deps
    this.maxRawBytes = deps.maxRawBytes ?? SEGMENT_MAX_RAW_BYTES
  }

  get isFull(): boolean {
    return this.raw >= this.maxRawBytes
  }

  get counts(): SegmentCounts {
    return { frames: this.frames, skips: this.skips, gaps: this.gaps }
  }

  get rawBytesWritten(): number {
    return this.raw
  }

  /**
   * Never refuses a record for size: past the cap the record is still
   * written and `'full'` tells the recorder to rotate BEFORE the next frame —
   * so the cap overshoots by at most one frame's records, and nothing of a
   * frame already begun (its frame, drop, processor or scene record) is lost
   * without a `gap`.
   */
  append(record: TapeRecord, t: number): AppendOutcome {
    if (this.blocked) {
      if (this.queue.length === 0) this.queueStartT = t
      if (t - this.queueStartT > BACKPRESSURE_MAX_MS) {
        this.lost = this.lost === null ? { fromT: t, toT: t } : { fromT: this.lost.fromT, toT: t }
        return 'dropped'
      }
      this.queue.push(record)
      return 'queued'
    }
    this.writeNow(record)
    if (!this.isFull) return 'written'
    if (!this.loggedFull) {
      this.loggedFull = true
      this.deps.logger.info('tracking tape segment full', {
        tags: { deviceId: this.deps.deviceId },
        meta: {
          rawBytes: this.raw,
          maxRawBytes: this.maxRawBytes,
          segmentOriginMs: this.deps.segmentOriginMs,
        },
      })
    }
    return 'full'
  }

  writeGap(fromT: number, toT: number, reason: TapeGap['reason']): void {
    this.writeNow({ kind: 'gap', fromT, toT, reason })
    this.deps.logger.warn('tracking tape gap', {
      tags: { deviceId: this.deps.deviceId },
      meta: { fromT, toT, reason, segmentOriginMs: this.deps.segmentOriginMs },
    })
  }

  /**
   * Push the sink's pending gzip output to disk without ending the segment.
   * A quiet / silent camera otherwise keeps its tail only in the zlib
   * buffer until the next rotation (D681 follow-up). Never throws into the
   * caller's frame path: a flush fault is logged and swallowed here.
   */
  async flushToDisk(): Promise<void> {
    try {
      await this.deps.sink.flush()
    } catch (err) {
      this.deps.logger.warn('tracking tape segment flush failed', {
        tags: { deviceId: this.deps.deviceId },
        meta: { segmentOriginMs: this.deps.segmentOriginMs, error: errMsg(err) },
      })
    }
  }

  /**
   * Always ends the segment's records (queue flush, lost-span gap, `end`
   * record) before touching the sink, so a sink that cannot finish still
   * leaves a decodable body behind it. `sink.finish()`'s rejection is caught
   * here — never left to propagate uncaught to the recorder — logged with
   * the reason and `tags: { deviceId }`, and turned into `'close-failed'`.
   */
  async close(reason: TapeEndReason, durationMs: number): Promise<CloseOutcome> {
    this.blocked = false
    for (const r of this.queue.splice(0)) this.writeNow(r)
    this.flushLost()
    this.writeNow({ kind: 'end', durationMs, ...this.counts, reason })
    try {
      await this.deps.sink.finish()
    } catch (err) {
      this.deps.logger.warn('tracking tape segment close failed', {
        tags: { deviceId: this.deps.deviceId },
        meta: { reason, durationMs, error: errMsg(err) },
      })
      return 'close-failed'
    }
    this.deps.logger.info('tracking tape segment sink closed', {
      tags: { deviceId: this.deps.deviceId },
      meta: { reason, durationMs, ...this.counts, rawBytes: this.raw },
    })
    return 'closed'
  }

  private count(record: TapeRecord): void {
    if (record.kind === 'frame') this.frames += 1
    else if (record.kind === 'skip') this.skips += 1
    else if (record.kind === 'gap') this.gaps += 1
  }

  private writeNow(record: TapeRecord): void {
    const line = encodeTapeLine(record)
    this.raw += Buffer.byteLength(line)
    this.count(record)
    if (!this.deps.sink.write(line) && !this.blocked) {
      this.blocked = true
      this.deps.sink.onceDrain(() => this.onDrain())
    }
  }

  private flushLost(): void {
    const lost = this.lost
    if (lost === null) return
    this.lost = null
    this.writeGap(lost.fromT, lost.toT, 'backpressure')
  }

  private onDrain(): void {
    this.blocked = false
    while (this.queue.length > 0 && !this.blocked) {
      const next = this.queue.shift()
      if (next !== undefined) this.writeNow(next)
    }
    if (!this.blocked) this.flushLost()
  }
}
