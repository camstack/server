/**
 * The sorted-view census — what is in `large_object_space`.
 *
 * Production, 2026-08-29, four samples five minutes apart, hot:
 * `largeObjectSpace` 471–498 MB against `heapUsed` 1 283–1 509 MB. **Stable**,
 * so retained rather than churn, and specific to the recorder (hub-main reads
 * 110 MB on a comparable total heap). V8 only puts an object there when it
 * does not fit a normal page (~256 KB and up), which in this process is a very
 * short list — and a materialised sorted view over ~296 k rows is at the top
 * of it: one contiguous array of pointers, per (device, profile-or-all).
 *
 * `sortedViewStats` and `hydrateReuseStats` have existed since the churn work
 * and nothing has ever read them. This pins the census that makes them
 * loggable, and pins the two properties a reader depends on: a view is counted
 * only once it is MATERIALISED, and the slot count is the array's real length.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RecordingIndex } from '../recording-index.js'
import { segmentRelPath } from '../segment-path.js'
import type { SegmentRow } from '../types.js'

const HOUR_MS = 3_600_000
const HOUR0 = Math.floor(1_700_000_000_000 / HOUR_MS) * HOUR_MS

function segment(deviceId: number, profile: string, i: number): SegmentRow {
  const startMs = HOUR0 + i * 10_000
  return {
    deviceId,
    profile,
    startMs,
    durMs: 10_000,
    bytes: 1_000 + i,
    path: segmentRelPath(deviceId, profile, startMs, 10_000, 1_000 + i),
    locationId: 'recordings:default',
  }
}

describe('RecordingIndex.sortedViewCensus', () => {
  it('counts nothing until a view is materialised', () => {
    const index = new RecordingIndex()
    for (let i = 0; i < 50; i += 1) index.addSegment(segment(102, 'high', i))
    // 50 rows are held, but no read has forced a sorted copy of them.
    expect(index.sortedViewCensus()).toEqual({
      views: 0,
      rowSlots: 0,
      largestRows: 0,
      largestDeviceId: 0,
    })
  })

  it('counts one view per (device, profile-or-all) once read', () => {
    const index = new RecordingIndex()
    for (let i = 0; i < 50; i += 1) index.addSegment(segment(102, 'high', i))
    for (let i = 0; i < 20; i += 1) index.addSegment(segment(102, 'low', i))

    index.segments(102) // the all-profiles view
    index.segments(102, 'high')

    const census = index.sortedViewCensus()
    expect(census.views).toBe(2)
    // 70 in the all-profiles view + 50 in the `high` one. The rows themselves
    // are held once in `byDevice`; these are pointer slots, 8 B each.
    expect(census.rowSlots).toBe(120)
    expect(census.largestRows).toBe(70)
    expect(census.largestDeviceId).toBe(102)
  })

  it('names the camera with the biggest view — the only form the question takes', () => {
    const index = new RecordingIndex()
    for (let i = 0; i < 10; i += 1) index.addSegment(segment(101, 'high', i))
    for (let i = 0; i < 300; i += 1) index.addSegment(segment(102, 'high', i))
    index.segments(101)
    index.segments(102)

    const census = index.sortedViewCensus()
    expect(census.largestDeviceId).toBe(102)
    expect(census.largestRows).toBe(300)
    expect(census.rowSlots).toBe(310)
  })

  it('drops a device view set when it is invalidated', () => {
    const index = new RecordingIndex()
    for (let i = 0; i < 30; i += 1) index.addSegment(segment(102, 'high', i))
    index.segments(102)
    expect(index.sortedViewCensus().views).toBe(1)

    // A bulk mutation invalidates: the array is released, and the census must
    // stop counting slots that no longer exist.
    index.hydrateDevice(102, 'recordings:default', [])
    expect(index.sortedViewCensus()).toEqual({
      views: 0,
      rowSlots: 0,
      largestRows: 0,
      largestDeviceId: 0,
    })
  })
})

/**
 * A counter nobody logs is a counter nobody has. Both of these have existed
 * since the churn work and neither has ever reached a log line — which is why
 * the ~490 MB in `large_object_space` had to be diagnosed from V8 space totals
 * instead of from the recorder saying what it holds.
 */
describe('the recorder actually emits the census', () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../addon/index.ts'),
    'utf8',
  )

  it('logs it on the existing 5-minute sweep, not on a new timer', () => {
    expect(source).toContain('recorder: index census')
    expect(source).toContain('this.logIndexCensus()')
    // No second timer: the export sweep already runs at the `[mem]` cadence.
    expect(source.match(/setInterval\(/g) ?? []).toHaveLength(1)
  })

  it('reads all three accessors, and tags the camera with the largest view', () => {
    const body = source.slice(source.indexOf('private logIndexCensus'))
    const method = body.slice(0, body.indexOf('\n  }'))
    expect(method).toContain('sortedViewCensus()')
    expect(method).toContain('sortedViewStats()')
    expect(method).toContain('hydrateReuseStats()')
    expect(method).toContain('tags: { deviceId: census.largestDeviceId }')
  })
})
