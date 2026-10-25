import { describe, expect, it } from 'vitest'
import type { ExportDense } from '@camstack/types'
import {
  TIMELAPSE_CHUNK_MS,
  denseRangesForChunk,
  splitTimelapseChunks,
} from '../export-timelapse-chunks.js'

const seg = (uri: string, durMs: number) => ({ uri, durMs })

describe('splitTimelapseChunks', () => {
  it('the default chunk is one hour of FOOTAGE, not one hour of wall clock', () => {
    expect(TIMELAPSE_CHUNK_MS).toBe(3_600_000)
  })

  it('returns no chunks for an empty playlist', () => {
    expect(splitTimelapseChunks([])).toEqual([])
  })

  it('keeps a short night as a single chunk — no extra ffmpeg', () => {
    const entries = [seg('/a.m4s', 10_000), seg('/b.m4s', 10_000)]
    expect(splitTimelapseChunks(entries)).toEqual([{ entries, streamStartMs: 0 }])
  })

  it('splits a 10 h concat into hour-sized chunks and never cuts a segment', () => {
    const entries = Array.from({ length: 20 }, (_, i) => seg(`/h${i}.m4s`, 30 * 60_000))
    const chunks = splitTimelapseChunks(entries)
    expect(chunks).toHaveLength(10)
    expect(chunks[0]?.entries).toHaveLength(2)
    expect(chunks[0]?.streamStartMs).toBe(0)
    expect(chunks[1]?.streamStartMs).toBe(3_600_000)
    expect(chunks[9]?.streamStartMs).toBe(9 * 3_600_000)
    expect(
      chunks.every((c) => c.entries.reduce((s, e) => s + e.durMs, 0) <= TIMELAPSE_CHUNK_MS),
    ).toBe(true)
  })

  it('a single segment longer than the chunk stays whole — it is already one file', () => {
    const long = [seg('/huge.m4s', 5 * 3_600_000)]
    expect(splitTimelapseChunks(long)).toEqual([{ entries: long, streamStartMs: 0 }])
  })
})

describe('denseRangesForChunk', () => {
  const dense: ExportDense = {
    everyMs: 1000,
    ranges: [
      { fromSec: 100, toSec: 130 },
      { fromSec: 4000, toSec: 4030 },
    ],
  }

  it('drops ranges that sit entirely in another chunk', () => {
    expect(denseRangesForChunk(dense, 0, 3_600_000)).toEqual({
      everyMs: 1000,
      ranges: [{ fromSec: 100, toSec: 130 }],
    })
  })

  it("shifts a range onto the chunk's own t=0", () => {
    expect(denseRangesForChunk(dense, 3_600_000, 3_600_000)).toEqual({
      everyMs: 1000,
      ranges: [{ fromSec: 400, toSec: 430 }],
    })
  })

  it('clips a range that straddles the chunk edge', () => {
    const wide: ExportDense = {
      everyMs: 1000,
      ranges: [{ fromSec: 3500, toSec: 3700 }],
    }
    expect(denseRangesForChunk(wide, 0, 3_600_000)).toEqual({
      everyMs: 1000,
      ranges: [{ fromSec: 3500, toSec: 3600 }],
    })
    expect(denseRangesForChunk(wide, 3_600_000, 3_600_000)).toEqual({
      everyMs: 1000,
      ranges: [{ fromSec: 0, toSec: 100 }],
    })
  })

  it('absent / empty dense stays absent — the select stays single-rate', () => {
    expect(denseRangesForChunk(undefined, 0, 3_600_000)).toBeUndefined()
    expect(denseRangesForChunk({ everyMs: 1000, ranges: [] }, 0, 3_600_000)).toBeUndefined()
  })
})
