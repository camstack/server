/**
 * Row reading, against rows this camera really sent.
 *
 * `fixtures/3836-mediafilefind-rows.json` was captured live on 2026-09-23:
 * `dav` is a `Types: ["dav"]` search, `unfiltered` is the same window with no
 * type filter — which is how the JPEG rows get in.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AmcrestCameraClock } from '../clip-clock.js'
import {
  buildFindCondition,
  CLIP_FIND_FLAGS,
  CLIP_FIND_PAGE_SIZE,
  CLIP_FIND_TYPES,
  findWalkIsComplete,
  parseClipRow,
} from '../clip-search.js'

interface RowFixture {
  readonly dav: readonly unknown[]
  readonly unfiltered: readonly unknown[]
}

const FIXTURE: RowFixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/3836-mediafilefind-rows.json'), 'utf8'),
) as RowFixture

/** The camera's measured +2 h. */
const CLOCK: AmcrestCameraClock = { offsetMs: 2 * 60 * 60_000, readAtMs: 0 }

describe('parseClipRow, on rows the camera really sent', () => {
  it('reads the first measured row into the window the catalog declared', () => {
    const outcome = parseClipRow(FIXTURE.dav[0], CLOCK)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.startMs).toBe(Date.UTC(2026, 8, 23, 8, 23, 27))
    expect(outcome.row.endMs).toBe(Date.UTC(2026, 8, 23, 8, 24, 41))
    expect(outcome.row.windowMs).toBe(74_000)
    expect(outcome.row.sizeBytes).toBe(56_242_806)
    expect(outcome.row.filePath).toBe(
      '/mnt/sd/2026-09-23/001/dav/10/10.23.27-10.24.41[M][0@0][0].mp4',
    )
    expect(outcome.row.events).toEqual(['VideoMotion'])
    expect(outcome.row.flags).toEqual(['Event'])
    expect(outcome.row.clipKey).toBe(
      `${String(Date.UTC(2026, 8, 23, 8, 23, 27) / 1000)}-${String(Date.UTC(2026, 8, 23, 8, 24, 41) / 1000)}`,
    )
  })

  it('NEVER carries the fabricated ANPR summary the camera stamps on every row', () => {
    // Every measured row carries `Summary.TrafficCar` with a blank plate and a
    // constant 60 km/h, on a camera with no ANPR licence. A provider that
    // surfaced it would invent a plate read on every motion clip.
    const raw = FIXTURE.dav[0]
    expect(JSON.stringify(raw)).toContain('TrafficCar')
    const outcome = parseClipRow(raw, CLOCK)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(JSON.stringify(outcome.row)).not.toContain('TrafficCar')
    expect(JSON.stringify(outcome.row)).not.toContain('Plate')
    expect(JSON.stringify(outcome.row)).not.toContain('Summary')
  })

  it('does not carry `Type`, which is an ECHO of the filter and not a fact', () => {
    // The SAME recording comes back `dav` or `mp4` depending on what the
    // search asked for. Measured: identical `FilePath` in both.
    const davPath = (FIXTURE.dav[0] as { FilePath: string }).FilePath
    const mp4 = FIXTURE.unfiltered.find(
      (row) => (row as { FilePath?: string }).FilePath === davPath,
    )
    expect(mp4).toBeDefined()
    expect((FIXTURE.dav[0] as { Type: string }).Type).toBe('dav')
    expect((mp4 as { Type: string }).Type).toBe('mp4')
    const outcome = parseClipRow(FIXTURE.dav[0], CLOCK)
    if (outcome.kind !== 'ok') throw new Error('expected ok')
    expect(Object.keys(outcome.row)).not.toContain('type')
  })

  it('rejects the JPEG snapshot rows an unfiltered search returns', () => {
    // 45 of 60 rows in the measured unfiltered window were single JPEGs with
    // `Duration: 0` and `StartTime === EndTime`. They are not clips: there is
    // no window for `/cam/playback` to serve.
    const jpegs = FIXTURE.unfiltered.filter((row) => (row as { Type?: string }).Type === 'jpg')
    expect(jpegs.length).toBeGreaterThan(0)
    for (const jpeg of jpegs) {
      const outcome = parseClipRow(jpeg, CLOCK)
      expect(outcome.kind).toBe('rejected')
      if (outcome.kind === 'rejected') expect(outcome.reason).toBe('not-a-window')
    }
  })

  it('answers null for a Length of zero, never a zero size', () => {
    // A bound check that read 0 as "comfortably under the ceiling" would let
    // an unmeasurable file through the one gate that exists to stop it (D393).
    const outcome = parseClipRow(
      {
        ...(FIXTURE.dav[0] as Record<string, unknown>),
        Length: 0,
      },
      CLOCK,
    )
    if (outcome.kind !== 'ok') throw new Error('expected ok')
    expect(outcome.row.sizeBytes).toBeNull()
  })

  it('names a row with no file path rather than dropping it silently', () => {
    const outcome = parseClipRow(
      { ...(FIXTURE.dav[0] as Record<string, unknown>), FilePath: '' },
      CLOCK,
    )
    expect(outcome).toEqual({ kind: 'rejected', reason: 'no-file-path' })
  })

  it('names a row whose times it cannot read', () => {
    const bad = { ...(FIXTURE.dav[0] as Record<string, unknown>), StartTime: 'nonsense' }
    expect(parseClipRow(bad, CLOCK)).toEqual({ kind: 'rejected', reason: 'unreadable-start' })
  })
})

describe('the search condition', () => {
  it('filters to `dav`, which is what keeps the JPEGs out', () => {
    expect(CLIP_FIND_TYPES).toEqual(['dav'])
  })

  it('asks for every record reason, not just events', () => {
    // A camera scheduled for CONTINUOUS recording writes `Timing` rows, and an
    // Event-only search on such a camera reports an empty card as confidently
    // as a real one.
    expect([...CLIP_FIND_FLAGS].toSorted()).toEqual(['Event', 'Manual', 'Timing'])
  })

  it('carries the window verbatim', () => {
    expect(
      buildFindCondition({
        channel: 0,
        startWallClock: '2026-09-23 10:00:00',
        endWallClock: '2026-09-23 11:00:00',
      }),
    ).toEqual({
      Channel: 0,
      StartTime: '2026-09-23 10:00:00',
      EndTime: '2026-09-23 11:00:00',
      Flags: CLIP_FIND_FLAGS,
      Types: CLIP_FIND_TYPES,
    })
  })
})

describe('the paging terminator', () => {
  it('is `found < count` — measured over 31 pages at count 2', () => {
    expect(findWalkIsComplete(CLIP_FIND_PAGE_SIZE, CLIP_FIND_PAGE_SIZE)).toBe(false)
    expect(findWalkIsComplete(CLIP_FIND_PAGE_SIZE - 1, CLIP_FIND_PAGE_SIZE)).toBe(true)
    expect(findWalkIsComplete(0, CLIP_FIND_PAGE_SIZE)).toBe(true)
  })
})
