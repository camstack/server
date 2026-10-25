/**
 * Hour-sized pieces of a long timelapse concat.
 *
 * One ffmpeg that remuxes ten hours of 10-second segments is how a single
 * corrupt file parks the job at `rendering 0%` and keeps every other camera
 * behind it. Each chunk is one hour of FOOTAGE (gapless stream time), so a
 * dead hour is skipped and the night still ships.
 */

import type { ExportDense } from '@camstack/types'
import type { ExportConcatSegment } from './export-ffmpeg-args.js'

/** One hour of concatenated footage — not one hour of wall clock. */
export const TIMELAPSE_CHUNK_MS = 3_600_000

export interface TimelapseChunk {
  readonly entries: readonly ExportConcatSegment[]
  /** Stream time at the start of this chunk (ms). 0 for the first. */
  readonly streamStartMs: number
}

/**
 * Split a concat list into hour-sized chunks. A single file longer than the
 * chunk stays whole — it is already one open, and cutting it would need a
 * second demux we do not have.
 */
export function splitTimelapseChunks(
  entries: readonly ExportConcatSegment[],
  chunkMs: number = TIMELAPSE_CHUNK_MS,
): readonly TimelapseChunk[] {
  if (entries.length === 0) return []
  const chunks: TimelapseChunk[] = []
  let current: ExportConcatSegment[] = []
  let currentDur = 0
  let streamStartMs = 0
  for (const entry of entries) {
    if (current.length > 0 && currentDur + entry.durMs > chunkMs) {
      chunks.push({ entries: current, streamStartMs })
      streamStartMs += currentDur
      current = []
      currentDur = 0
    }
    current.push(entry)
    currentDur += entry.durMs
  }
  if (current.length > 0) chunks.push({ entries: current, streamStartMs })
  return chunks
}

/**
 * Move stream-time dense ranges onto a chunk's own `t=0`. Ranges that miss
 * the chunk disappear; a range that straddles the edge is clipped. Empty →
 * `undefined` so the select stays the single-rate form.
 */
export function denseRangesForChunk(
  dense: ExportDense | undefined,
  chunkStreamStartMs: number,
  chunkDurMs: number,
): ExportDense | undefined {
  if (dense === undefined || dense.ranges.length === 0) return undefined
  const startSec = chunkStreamStartMs / 1000
  const endSec = (chunkStreamStartMs + chunkDurMs) / 1000
  const ranges = []
  for (const r of dense.ranges) {
    const from = Math.max(r.fromSec, startSec)
    const to = Math.min(r.toSec, endSec)
    if (to <= from) continue
    ranges.push({ fromSec: from - startSec, toSec: to - startSec })
  }
  if (ranges.length === 0) return undefined
  return { everyMs: dense.everyMs, ranges }
}
