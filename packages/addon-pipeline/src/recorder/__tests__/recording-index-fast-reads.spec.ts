/**
 * The searches that replaced the recorder's per-tick archive walks
 * (design `docs/design/2026-08-29-recorder-index-at-scale.md`, §7 items 2–4).
 *
 * Every read here used to be a full COPY of a device-profile's rows plus a
 * linear pass over the copy, on the scrub/playback critical path. The
 * replacements are binary searches over the live sorted view, and they are
 * only allowed to be faster — never to answer differently. So the assertions
 * are written against the ORIGINAL implementations, reproduced verbatim below
 * as oracles, and driven over generated archives that contain the shapes that
 * break a naive search: exact gaps, adjacency cracks, duplicate starts, and
 * segments that overlap each other after a restart.
 *
 * The oracles are the point of this file. A test that only asserted the fast
 * path's own idea of the right answer would pass just as happily against a
 * search that is subtly wrong at the boundary.
 */
import { describe, expect, it } from 'vitest'
import { RecordingIndex } from '../recording-index.js'
import { segmentRelPath } from '../segment-path.js'
import type { SegmentRow } from '../types.js'

const mk = (
  deviceId: number,
  profile: string,
  startMs: number,
  durMs = 10_000,
  locationId = 'loc-a',
): SegmentRow => ({
  deviceId,
  profile,
  startMs,
  durMs,
  bytes: 1000 + (startMs % 977),
  path: segmentRelPath(deviceId, profile, startMs, durMs, 1000 + (startMs % 977)),
  locationId,
})

/** Deterministic LCG — a failure here must reproduce exactly. */
function rng(seed: number): () => number {
  let state = seed
  return (): number => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

// ── The pre-change implementations, kept as oracles ────────────────────────
// Each is the body that shipped before this change, reading through
// `index.segments()` exactly as the call site did.

const oracleSegmentStartingAt = (
  idx: RecordingIndex,
  deviceId: number,
  profile: string,
  startMs: number,
): SegmentRow | undefined => idx.segments(deviceId, profile).find((s) => s.startMs === startMs)

const oracleOverlapping = (
  idx: RecordingIndex,
  deviceId: number,
  profile: string,
  fromMs: number,
  toMs: number,
): readonly SegmentRow[] =>
  idx
    .segments(deviceId, profile)
    .filter((s) => s.startMs < toMs && s.startMs + s.durMs > fromMs)
    .toSorted((a, b) => a.startMs - b.startMs)

const oracleCoveredEdgeBefore = (
  idx: RecordingIndex,
  deviceId: number,
  profile: string,
  epochMs: number,
): number | null => {
  let best: number | null = null
  for (const s of idx.segments(deviceId, profile)) {
    const end = s.startMs + s.durMs
    if (end <= epochMs && (best === null || end > best)) best = end
  }
  return best
}

/**
 * The covering answer, by definition rather than by search: every row whose
 * half-open window contains the instant, latest start wins.
 *
 * This oracle used to be forbidden. `segmentAt` took the LAST row starting
 * at-or-before the instant and stopped, so where a SHORT segment starts inside
 * a long overlapping one it reported a gap over footage on disk — and this file
 * carried a note saying so, because an oracle that quietly fixed its subject
 * would have hidden the defect instead of reporting it. The subject is fixed
 * now (bounded backward walk under `maxDurMs`), so the definition is the oracle
 * again.
 */
const oracleSegmentAt = (
  idx: RecordingIndex,
  deviceId: number,
  profile: string,
  epochMs: number,
): SegmentRow | null => {
  const covering = idx
    .segments(deviceId, profile)
    .filter((s) => epochMs >= s.startMs && epochMs < s.startMs + s.durMs)
  return covering.at(-1) ?? null
}

const oracleNearestCoveredEdge = (
  idx: RecordingIndex,
  deviceId: number,
  profile: string,
  epochMs: number,
): number | null => {
  const segs = idx.segments(deviceId, profile)
  if (segs.length === 0) return null
  if (oracleSegmentAt(idx, deviceId, profile, epochMs) !== null) return epochMs
  const next = segs.find((s) => s.startMs >= epochMs)
  return next ? next.startMs : null
}

const oracleLatestEnd = (idx: RecordingIndex, deviceId: number, profile: string): number | null => {
  let end: number | null = null
  for (const s of idx.segments(deviceId, profile)) {
    const candidate = s.startMs + s.durMs
    if (end === null || candidate > end) end = candidate
  }
  return end
}

/**
 * A sparse archive with every shape the searches have to survive: continuous
 * runs with the real ~13 ms inter-segment crack, hard gaps, a restart that
 * re-records an interval (overlaps AND duplicate starts), and one long segment
 * that ends after segments which start later.
 */
function sparseArchive(seed: number, runs: number): { idx: RecordingIndex; probes: number[] } {
  const rand = rng(seed)
  const idx = new RecordingIndex()
  const probes: number[] = []
  let clock = 1_700_000_000_000
  for (let run = 0; run < runs; run++) {
    const len = 3 + Math.floor(rand() * 12)
    for (let i = 0; i < len; i++) {
      idx.addSegment(mk(9, 'high', clock, 10_000))
      idx.addSegment(mk(9, 'low', clock, 10_000))
      probes.push(clock, clock + 5_000, clock + 9_999, clock + 10_000, clock + 10_006)
      // Consecutive segments leave a crack of a few ms — the exact thing
      // `coveredEdgeBefore` exists for.
      clock += 10_000 + 11 + Math.floor(rand() * 7)
    }
    if (rand() < 0.25) {
      // A restart re-records the last interval: overlapping spans, and one
      // duplicate start.
      const back = clock - 25_000
      idx.addSegment(mk(9, 'high', back, 60_000))
      idx.addSegment(mk(9, 'high', back + 1, 4_000))
      probes.push(back, back + 30_000, back + 60_000)
    }
    // A hard gap the operator drags across.
    const gap = 60_000 + Math.floor(rand() * 900_000)
    probes.push(clock + Math.floor(gap / 2))
    clock += gap
  }
  probes.push(0, 1, clock, clock + 5_000_000)
  return { idx, probes }
}

describe('RecordingIndex.segmentStartingAt — the point lookup byte reads use', () => {
  it('returns the same row the linear find returned, hits and misses alike', () => {
    const { idx } = sparseArchive(1234, 40)
    const all = idx.segments(9, 'high')
    expect(all.length).toBeGreaterThan(100)
    // Every real start, plus the misses that matter: one before, one after.
    for (const s of all) {
      for (const probe of [s.startMs - 1, s.startMs, s.startMs + 1]) {
        expect(idx.segmentStartingAt(9, 'high', probe)).toBe(
          oracleSegmentStartingAt(idx, 9, 'high', probe) ?? null,
        )
      }
    }
  })

  it('a miss is null, not the neighbouring row', () => {
    const idx = new RecordingIndex()
    idx.addSegment(mk(9, 'high', 10_000))
    idx.addSegment(mk(9, 'high', 30_000))
    expect(idx.segmentStartingAt(9, 'high', 20_000)).toBeNull()
    expect(idx.segmentStartingAt(9, 'high', 0)).toBeNull()
    expect(idx.segmentStartingAt(9, 'high', 99_000)).toBeNull()
    expect(idx.segmentStartingAt(9, 'nope', 10_000)).toBeNull()
    expect(new RecordingIndex().segmentStartingAt(9, 'high', 10_000)).toBeNull()
  })

  it('with two rows sharing a start it resolves to the SAME one the scan did', () => {
    // A restart can leave two rows on one start. Which one the byte reader
    // opens must not change: `.find` took the first of the sorted view.
    const idx = new RecordingIndex()
    const first = mk(9, 'high', 50_000, 10_000)
    const second = mk(9, 'high', 50_000, 4_000)
    idx.addSegment(first)
    idx.addSegment(second)
    expect(idx.segments(9, 'high')).toHaveLength(2)
    expect(idx.segmentStartingAt(9, 'high', 50_000)).toBe(
      oracleSegmentStartingAt(idx, 9, 'high', 50_000),
    )
  })
})

describe('RecordingIndex.segmentsOverlapping — the playback window slice', () => {
  it('INCLUDES a segment straddling fromMs and EXCLUDES one ending exactly at it', () => {
    // The boundary convention preserved from the filter this replaces:
    // overlap is `start < toMs && start + dur > fromMs` — both ends strict, so
    // touching is not overlapping.
    const idx = new RecordingIndex()
    const endsExactlyAtFrom = mk(9, 'high', 40_000, 10_000) // [40k, 50k)
    const straddlesFrom = mk(9, 'high', 45_000, 10_000) // [45k, 55k)
    const startsExactlyAtTo = mk(9, 'high', 70_000, 10_000) // [70k, 80k)
    const inside = mk(9, 'high', 60_000, 10_000)
    for (const s of [endsExactlyAtFrom, straddlesFrom, inside, startsExactlyAtTo]) idx.addSegment(s)

    const got = idx.segmentsOverlapping(9, 'high', 50_000, 70_000)
    expect(got.map((s) => s.startMs)).toEqual([45_000, 60_000])
    expect(got).toEqual(oracleOverlapping(idx, 9, 'high', 50_000, 70_000))
  })

  it('reaches back past MORE than one predecessor when segments overlap', () => {
    // "Start the slice one element earlier" is not enough: a restart can leave
    // several rows that all still cover fromMs, and the one that covers it can
    // be two or three elements back.
    const idx = new RecordingIndex()
    idx.addSegment(mk(9, 'high', 10_000, 120_000)) // [10k, 130k) — covers 100k
    idx.addSegment(mk(9, 'high', 20_000, 2_000)) // [20k, 22k) — does not
    idx.addSegment(mk(9, 'high', 30_000, 2_000)) // [30k, 32k) — does not
    idx.addSegment(mk(9, 'high', 40_000, 90_000)) // [40k, 130k) — covers 100k
    idx.addSegment(mk(9, 'high', 105_000, 10_000))

    const got = idx.segmentsOverlapping(9, 'high', 100_000, 110_000)
    expect(got.map((s) => s.startMs)).toEqual([10_000, 40_000, 105_000])
    expect(got).toEqual(oracleOverlapping(idx, 9, 'high', 100_000, 110_000))
  })

  it('equals the copy-filter-sort answer across a generated sparse archive', () => {
    const { idx, probes } = sparseArchive(9977, 30)
    for (const from of probes) {
      for (const width of [1, 10_000, 60_000, 3_600_000]) {
        expect(idx.segmentsOverlapping(9, 'high', from, from + width)).toEqual(
          oracleOverlapping(idx, 9, 'high', from, from + width),
        )
      }
    }
    // Degenerate windows the callers can still produce.
    expect(idx.segmentsOverlapping(9, 'high', 5_000, 5_000)).toEqual([])
    expect(idx.segmentsOverlapping(9, 'high', 10_000, 0)).toEqual([])
    expect(new RecordingIndex().segmentsOverlapping(9, 'high', 0, 1)).toEqual([])
  })

  it('is the covering set when the window is one instant (the still lookup)', () => {
    const { idx, probes } = sparseArchive(5150, 20)
    for (const epochMs of probes) {
      const covering = idx
        .segments(9, 'low')
        .filter((s) => epochMs >= s.startMs && epochMs < s.startMs + s.durMs)
      expect(idx.segmentsOverlapping(9, 'low', epochMs, epochMs + 1)).toEqual(covering)
    }
  })
})

describe('RecordingIndex.coveredEdgeBefore — bounded backward search, not a scan', () => {
  it('equals the linear result on every probe of a generated sparse archive', () => {
    for (const seed of [11, 4242, 777_777]) {
      const { idx, probes } = sparseArchive(seed, 35)
      for (const probe of probes) {
        for (const profile of ['high', 'low']) {
          expect(idx.coveredEdgeBefore(9, profile, probe)).toBe(
            oracleCoveredEdgeBefore(idx, 9, profile, probe),
          )
        }
      }
    }
  })

  it('the true edge can be EARLIER than the newest segment starting before it', () => {
    // The shape that a naive "walk back to the predecessor and stop" gets
    // wrong: the row starting just before the cursor still COVERS the cursor,
    // so it is disqualified, and the answer is a row further back.
    const idx = new RecordingIndex()
    idx.addSegment(mk(9, 'high', 10_000, 5_000)) // [10k, 15k) — ends before
    idx.addSegment(mk(9, 'high', 18_000, 60_000)) // [18k, 78k) — covers 20k
    expect(idx.coveredEdgeBefore(9, 'high', 20_000)).toBe(15_000)
    expect(idx.coveredEdgeBefore(9, 'high', 20_000)).toBe(
      oracleCoveredEdgeBefore(idx, 9, 'high', 20_000),
    )
  })

  it('a LONGER earlier segment can be the edge even after a nearer one qualifies', () => {
    // The backward walk may not stop at the first row that ends before the
    // cursor: an earlier, longer segment can end LATER than it and still
    // before the cursor. Only the maxDurMs ceiling says when there is nothing
    // left to find.
    const idx = new RecordingIndex()
    idx.addSegment(mk(9, 'high', 0, 18_000)) // ends 18_000 — the true edge
    idx.addSegment(mk(9, 'high', 10_000, 2_000)) // ends 12_000 — nearer, worse
    expect(idx.coveredEdgeBefore(9, 'high', 20_000)).toBe(18_000)
    expect(idx.coveredEdgeBefore(9, 'high', 20_000)).toBe(
      oracleCoveredEdgeBefore(idx, 9, 'high', 20_000),
    )
  })

  it('hops the inter-segment crack a backward frame-step lands in', () => {
    const idx = new RecordingIndex()
    idx.addSegment(mk(9, 'high', 10_000, 10_000)) // ends 20_000
    idx.addSegment(mk(9, 'high', 20_013, 10_000)) // the ~13 ms crack
    expect(idx.coveredEdgeBefore(9, 'high', 20_012)).toBe(20_000)
    expect(idx.coveredEdgeBefore(9, 'high', 9_999)).toBeNull()
    expect(new RecordingIndex().coveredEdgeBefore(9, 'high', 20_000)).toBeNull()
  })
})

describe('RecordingIndex.segmentAt — coverage, not "the last row that starts before"', () => {
  it('finds the LONG segment when a short one starts inside it and does not reach', () => {
    // The defect, in its smallest form. The view is sorted by `startMs`; the
    // short row sorts last and does not cover 40_000, but the long row it
    // started inside does. Taking the last-starting row and stopping reported a
    // gap over footage that is on disk.
    const idx = new RecordingIndex()
    const long = mk(9, 'high', 10_000, 60_000) // [10k, 70k)
    const shortInside = mk(9, 'high', 20_000, 4_000) // [20k, 24k)
    idx.addSegment(long)
    idx.addSegment(shortInside)

    expect(idx.segmentAt(9, 'high', 40_000)).toBe(long)
    expect(idx.segmentAt(9, 'high', 40_000)).toBe(oracleSegmentAt(idx, 9, 'high', 40_000))
    // …and the short one still wins where it DOES cover: among covering rows
    // the latest start is the answer, which is what the plain search returned.
    expect(idx.segmentAt(9, 'high', 22_000)).toBe(shortInside)
  })

  it('reaches back past MORE than one non-covering row, and no further than maxDurMs', () => {
    const idx = new RecordingIndex()
    const long = mk(9, 'high', 10_000, 120_000) // [10k, 130k)
    idx.addSegment(long)
    idx.addSegment(mk(9, 'high', 20_000, 2_000))
    idx.addSegment(mk(9, 'high', 30_000, 2_000))
    idx.addSegment(mk(9, 'high', 90_000, 1_000)) // [90k, 91k) — nearest, misses

    expect(idx.segmentAt(9, 'high', 100_000)).toBe(long)
    // Beyond every span, the bounded walk still says null rather than guessing.
    expect(idx.segmentAt(9, 'high', 130_000)).toBeNull()
    expect(idx.segmentAt(9, 'high', 130_000)).toBe(oracleSegmentAt(idx, 9, 'high', 130_000))
  })

  it('keeps the half-open boundary: start is covered, start+dur is not', () => {
    const idx = new RecordingIndex()
    const a = mk(9, 'high', 10_000, 10_000) // [10k, 20k)
    const b = mk(9, 'high', 20_000, 10_000) // [20k, 30k) — adjacent, no crack
    idx.addSegment(a)
    idx.addSegment(b)

    expect(idx.segmentAt(9, 'high', 10_000)).toBe(a)
    expect(idx.segmentAt(9, 'high', 19_999)).toBe(a)
    // Exactly the shared instant belongs to the LATER segment — `[start, end)`.
    expect(idx.segmentAt(9, 'high', 20_000)).toBe(b)
    expect(idx.segmentAt(9, 'high', 30_000)).toBeNull()
    expect(idx.segmentAt(9, 'high', 9_999)).toBeNull()
  })

  it('a genuine gap is still a gap, and an empty index is still null', () => {
    const idx = new RecordingIndex()
    idx.addSegment(mk(9, 'high', 10_000, 10_000)) // [10k, 20k)
    idx.addSegment(mk(9, 'high', 40_000, 10_000)) // [40k, 50k)
    for (const probe of [20_000, 25_000, 39_999]) {
      expect(idx.segmentAt(9, 'high', probe)).toBeNull()
      expect(idx.segmentAt(9, 'high', probe)).toBe(oracleSegmentAt(idx, 9, 'high', probe))
    }
    // The ~13 ms inter-segment crack is a real gap and stays one.
    const cracked = new RecordingIndex()
    cracked.addSegment(mk(9, 'high', 10_000, 10_000))
    cracked.addSegment(mk(9, 'high', 20_013, 10_000))
    expect(cracked.segmentAt(9, 'high', 20_006)).toBeNull()
    expect(new RecordingIndex().segmentAt(9, 'high', 10_000)).toBeNull()
    expect(idx.segmentAt(9, 'nope', 15_000)).toBeNull()
  })

  it('equals the covering definition on every probe of a generated sparse archive', () => {
    // The restart runs in `sparseArchive` are the defect shape by construction:
    // a 60 s segment with a 4 s one starting 1 ms inside it.
    for (const seed of [1234, 9977, 31337]) {
      const { idx, probes } = sparseArchive(seed, 35)
      for (const probe of probes) {
        for (const profile of ['high', 'low']) {
          expect(idx.segmentAt(9, profile, probe)).toBe(oracleSegmentAt(idx, 9, profile, probe))
        }
      }
    }
  })
})

describe('RecordingIndex.nearestCoveredEdge / latestEnd', () => {
  it('does not snap forward over footage a short overlapping segment hid', () => {
    // `nearestCoveredEdge` shares the covering check, so the operator-visible
    // symptom was a seek that skipped past playable video.
    const idx = new RecordingIndex()
    idx.addSegment(mk(9, 'high', 10_000, 60_000)) // [10k, 70k)
    idx.addSegment(mk(9, 'high', 20_000, 4_000)) // [20k, 24k)
    idx.addSegment(mk(9, 'high', 200_000, 10_000))
    expect(idx.nearestCoveredEdge(9, 'high', 40_000)).toBe(40_000)
    expect(idx.nearestCoveredEdge(9, 'high', 40_000)).toBe(
      oracleNearestCoveredEdge(idx, 9, 'high', 40_000),
    )
    // A real gap still snaps forward to the next start.
    expect(idx.nearestCoveredEdge(9, 'high', 100_000)).toBe(200_000)
  })

  it('nearestCoveredEdge equals the linear find on every probe', () => {
    const { idx, probes } = sparseArchive(31337, 30)
    for (const probe of probes) {
      expect(idx.nearestCoveredEdge(9, 'high', probe)).toBe(
        oracleNearestCoveredEdge(idx, 9, 'high', probe),
      )
    }
  })

  it('latestEnd equals the max-fold over the whole archive', () => {
    for (const seed of [3, 808, 24_601]) {
      const { idx } = sparseArchive(seed, 25)
      for (const profile of ['high', 'low', 'nope']) {
        expect(idx.latestEnd(9, profile)).toBe(oracleLatestEnd(idx, 9, profile))
      }
    }
    expect(new RecordingIndex().latestEnd(9, 'low')).toBeNull()
  })

  it('latestEnd is NOT the last row by start when an earlier segment is longer', () => {
    const idx = new RecordingIndex()
    idx.addSegment(mk(9, 'low', 10_000, 500_000)) // ends 510_000
    idx.addSegment(mk(9, 'low', 20_000, 10_000)) // ends  30_000, starts later
    expect(idx.latestEnd(9, 'low')).toBe(510_000)
  })
})
