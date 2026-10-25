/**
 * A visit is a burst of EVENTS, not a stretch of recording.
 *
 * ## The live defect
 *
 * `VISIT_MERGE_GAP_MS`'s own docblock states the claim this rests on: 30 s
 * "glues those intra-visit holes **without joining visits hours apart**". It
 * was applied to the wrong input. `clusterFootageVisits` clusters AVAILABILITY,
 * and availability only has gaps on an events-mode camera, where the writer
 * opens and closes around activity. On a camera that records CONTINUOUSLY
 * there are no gaps at all, so the whole recording session became one visit.
 *
 * Measured on 592, 2026-09-21, 24 h: **seven rows covering the entire day**,
 * one of them 7 h 58 m holding 1 438 events and another 7 h 43 m holding 1 199.
 * The per-event path (`eventsToClips`, pad −5 s/+10 s) was computed and then
 * discarded on every call, because it is discarded whenever availability is
 * readable — which on such a camera is always.
 *
 * ## Why no new constant
 *
 * The same 592, same day, clustering the EVENTS at the existing 30 s:
 *
 *  - overnight 00:00→07:58, today ONE row: 120 object events → **46 visits**;
 *  - daytime 08:40→16:24, today ONE row: 173 object events → **36 visits**,
 *    median **17 s**, p90 80 s, longest 99 s.
 *
 * So the constant was right and its rationale is now true. A duration cap was
 * considered and rejected: it would have split by the clock rather than by
 * what happened, and these numbers show nothing needs splitting that way.
 */
import { describe, expect, it } from 'vitest'

import { clusterEventVisits } from '../videoclip-visits.js'
import type { EventLike, FootageRange } from '../videoclips-shared.js'

const PAD = { preMs: 5_000, postMs: 10_000 } as const

function ev(atMs: number, id = String(atMs)): EventLike {
  return { id, timestamp: atMs, kind: 'object' } as EventLike
}

/** One unbroken recording session — what a continuously-recorded camera has. */
function continuous(fromMs: number, toMs: number): readonly FootageRange[] {
  return [{ startMs: fromMs, endMs: toMs }]
}

describe('clusterEventVisits — the merge grain is the PADDING', () => {
  /**
   * *"30 secondi e' troppo, possiamo completamente eliminarlo, il merge avviene
   * quando post-event coincide con il pre del successivo"* [30 seconds is too much, we can eliminate it completely, the merge happens when post-event coincides with the pre of the next] — the operator.
   *
   * Two clips merge exactly when they would otherwise OVERLAP: `postMs` of one
   * reaching `preMs` of the next, so the threshold is `preMs + postMs` and
   * there is no separate constant to get wrong. `VISIT_MERGE_GAP_MS` (30 s) was
   * arbitrary here and sat right on a cliff — measured on 592's worst hour, 492
   * events whose largest gap was 25 s, so nothing ever reached 30 and the whole
   * hour was ONE row:
   *
   * | rule | clips | longest |
   * | --- | --- | --- |
   * | 30 s | 1 | 66 min |
   * | pre+post (15 s) | 105 | 3.5 min |
   */
  it('merges two events whose padded windows TOUCH', () => {
    // 15 s apart: the first ends exactly where the second begins.
    const visits = clusterEventVisits([ev(0), ev(15_000)], continuous(-60_000, 120_000), PAD)
    expect(visits).toHaveLength(1)
  })

  it('separates two events whose padded windows do NOT reach', () => {
    const visits = clusterEventVisits([ev(0), ev(15_001)], continuous(-60_000, 120_000), PAD)
    expect(visits).toHaveLength(2)
  })

  it('derives the grain from the pad it is GIVEN, not from a constant', () => {
    // A caller with a wider pad gets a wider grain, by construction. This is
    // what removes the separate threshold: there is nothing left to disagree.
    const wide = { preMs: 20_000, postMs: 20_000 } as const
    expect(
      clusterEventVisits([ev(0), ev(35_000)], continuous(-60_000, 120_000), wide),
    ).toHaveLength(1)
    expect(clusterEventVisits([ev(0), ev(35_000)], continuous(-60_000, 120_000), PAD)).toHaveLength(
      2,
    )
  })
})

describe('clusterEventVisits', () => {
  it('splits a continuous recording into one visit per BURST', () => {
    // The defect in one assertion: the footage is unbroken for an hour, and
    // the two bursts inside it are five minutes apart.
    const visits = clusterEventVisits(
      [ev(100_000), ev(110_000), ev(400_000), ev(405_000)],
      continuous(0, 3_600_000),
      PAD,
    )
    expect(visits).toHaveLength(2)
    expect(visits[0]?.startMs).toBe(95_000)
    expect(visits[0]?.endMs).toBe(120_000)
    expect(visits[1]?.startMs).toBe(395_000)
    expect(visits[1]?.endMs).toBe(415_000)
  })

  it('glues events inside the grain into ONE visit', () => {
    // 14 s apart: the first clip's post still reaches the second's pre.
    const visits = clusterEventVisits([ev(0), ev(14_000)], continuous(-60_000, 120_000), PAD)
    expect(visits).toHaveLength(1)
    expect(visits[0]?.endMs).toBe(24_000)
  })

  it('separates events just OUTSIDE the grain', () => {
    const visits = clusterEventVisits([ev(0), ev(16_000)], continuous(-60_000, 120_000), PAD)
    expect(visits).toHaveLength(2)
  })

  it('keeps the footage pieces a visit actually covers', () => {
    // `stillInstantMs` picks the midpoint of the LONGEST piece, so a visit that
    // carried the whole session's range would put the still hours away from
    // the event.
    const visits = clusterEventVisits(
      [ev(100_000)],
      [
        { startMs: 0, endMs: 90_000 },
        { startMs: 92_000, endMs: 200_000 },
        { startMs: 500_000, endMs: 900_000 },
      ],
      PAD,
    )
    expect(visits).toHaveLength(1)
    expect(visits[0]?.ranges).toEqual([{ startMs: 95_000, endMs: 110_000 }])
  })

  it('reports the HOLE when a visit straddles a gap in the footage', () => {
    const visits = clusterEventVisits(
      // 10 s apart — inside the grain, so one visit straddling the hole.
      [ev(100_000), ev(110_000)],
      [
        { startMs: 0, endMs: 105_000 },
        { startMs: 112_000, endMs: 200_000 },
      ],
      PAD,
    )
    expect(visits).toHaveLength(1)
    expect(visits[0]?.holes).toEqual([{ startMs: 105_000, endMs: 112_000 }])
  })

  it('DROPS a burst with no footage behind it — there is nothing to play', () => {
    // An event the recorder never kept footage for is not a clip. Listing it
    // would be a row that opens onto nothing.
    expect(clusterEventVisits([ev(500_000)], continuous(0, 100_000), PAD)).toEqual([])
  })

  it('clamps a visit to the footage rather than claiming more than exists', () => {
    const visits = clusterEventVisits([ev(10_000)], continuous(8_000, 15_000), PAD)
    expect(visits[0]?.startMs).toBe(8_000)
    expect(visits[0]?.endMs).toBe(15_000)
  })

  it('is empty for no events, and for no footage', () => {
    expect(clusterEventVisits([], continuous(0, 100_000), PAD)).toEqual([])
    expect(clusterEventVisits([ev(1_000)], [], PAD)).toEqual([])
  })

  it('orders visits oldest-first whatever order the events arrived in', () => {
    const visits = clusterEventVisits([ev(400_000), ev(100_000)], continuous(0, 600_000), PAD)
    expect(visits.map((v) => v.startMs)).toEqual([95_000, 395_000])
  })
})
