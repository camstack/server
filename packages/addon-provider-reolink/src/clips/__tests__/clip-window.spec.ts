/**
 * `listClips` answers the window it was ASKED for.
 *
 * Measured on the live hub (592, 2026-09-22) before this existed: a one-hour
 * window answered 195 rows, 173 of them outside it. The recorder's provider
 * honoured the window in the same call, so one camera with two sources gave
 * two different answers to one question.
 */
import { describe, expect, it } from 'vitest'
import { clipOverlapsWindow, listableClips, narrowClipsToWindow } from '../clip-window.js'

const H = (h: number, m = 0): number => Date.UTC(2026, 8, 22, h, m) // 2026-09-22 UTC
const WINDOW = { since: H(15), until: H(16) }

describe('clipOverlapsWindow', () => {
  it('keeps a clip wholly inside', () => {
    expect(clipOverlapsWindow({ startMs: H(15, 10), endMs: H(15, 12) }, WINDOW)).toBe(true)
  })

  it('keeps a clip that STARTS before and runs in', () => {
    // The whole reason this is overlap and not containment: the operator
    // asking for 15:00–16:00 wants the clip that began at 14:59 and was still
    // recording at 15:00.
    expect(clipOverlapsWindow({ startMs: H(14, 50), endMs: H(14, 59) }, WINDOW)).toBe(false)
    expect(clipOverlapsWindow({ startMs: H(14, 59), endMs: H(15, 3) }, WINDOW)).toBe(true)
  })

  it('keeps a clip that starts inside and runs out', () => {
    expect(clipOverlapsWindow({ startMs: H(15, 58), endMs: H(16, 4) }, WINDOW)).toBe(true)
  })

  it('keeps a clip that spans the whole window', () => {
    expect(clipOverlapsWindow({ startMs: H(14), endMs: H(17) }, WINDOW)).toBe(true)
  })

  it('drops a clip wholly before or wholly after', () => {
    expect(clipOverlapsWindow({ startMs: H(13), endMs: H(14) }, WINDOW)).toBe(false)
    expect(clipOverlapsWindow({ startMs: H(17), endMs: H(18) }, WINDOW)).toBe(false)
  })

  it('is half-open at BOTH edges, so two adjacent windows never both claim one clip', () => {
    // Ends exactly at `since` → out. Starts exactly at `until` → out.
    expect(clipOverlapsWindow({ startMs: H(14, 30), endMs: H(15) }, WINDOW)).toBe(false)
    expect(clipOverlapsWindow({ startMs: H(16), endMs: H(16, 30) }, WINDOW)).toBe(false)
    // …and the previous window DOES claim the first of those.
    expect(
      clipOverlapsWindow({ startMs: H(14, 30), endMs: H(15) }, { since: H(14), until: H(15) }),
    ).toBe(true)
  })

  it('treats a row with a broken end as an INSTANT at its start', () => {
    // A clip still being written carries a frozen `endMs` from the camera's
    // index (D563), observed equal to and once behind its own start. Judging
    // it by that end would drop a recording happening right now.
    expect(clipOverlapsWindow({ startMs: H(15, 30), endMs: H(15, 30) }, WINDOW)).toBe(true)
    expect(clipOverlapsWindow({ startMs: H(15, 30), endMs: H(9) }, WINDOW)).toBe(true)
    // And it is still OUT when the start itself is outside.
    expect(clipOverlapsWindow({ startMs: H(9), endMs: H(9) }, WINDOW)).toBe(false)
  })
})

describe('narrowClipsToWindow', () => {
  it('keeps order and reports what the window did not ask for', () => {
    const rows = [
      { startMs: H(13), endMs: H(13, 5) },
      { startMs: H(15, 10), endMs: H(15, 11) },
      { startMs: H(15, 40), endMs: H(15, 41) },
      { startMs: H(18), endMs: H(18, 2) },
    ]
    const out = narrowClipsToWindow(rows, WINDOW)
    expect(out.kept.map((r) => r.startMs)).toEqual([H(15, 10), H(15, 40)])
    expect(out.dropped).toBe(2)
  })

  it('reports zero dropped when the day is already inside the window', () => {
    const rows = [{ startMs: H(15, 1), endMs: H(15, 2) }]
    expect(narrowClipsToWindow(rows, WINDOW)).toEqual({ kept: rows, dropped: 0 })
  })

  it('answers empty for a window the day does not reach, and SAYS how many it dropped', () => {
    const rows = [{ startMs: H(3), endMs: H(4) }]
    const out = narrowClipsToWindow(rows, WINDOW)
    expect(out.kept).toEqual([])
    expect(out.dropped).toBe(1)
  })
})

/**
 * A clip the camera is still writing is not listed at all.
 *
 * Operator, 2026-09-22: *"Niente clips in preparazione, non ha senso
 * visualizzarle."* Four places were bending around such a row — a frozen
 * `endMs` (D563), a byte read that refuses it by name, a loop that cannot run,
 * and a player route that would cache a truncated copy under an immutable key.
 * Not listing it deletes all four questions.
 */
describe('listableClips — the one gate on what leaves the provider', () => {
  const open = { startMs: H(15, 20), endMs: H(15, 20), inProgress: true }
  const closed = { startMs: H(15, 10), endMs: H(15, 12) }
  const yesterday = { startMs: H(3), endMs: H(4) }

  it('keeps closed rows inside the window', () => {
    expect(listableClips([closed], WINDOW).kept).toEqual([closed])
  })

  it('drops a row still being written, and counts it separately', () => {
    const out = listableClips([closed, open], WINDOW)
    expect(out.kept).toEqual([closed])
    expect(out.inProgress).toBe(1)
    expect(out.outOfWindow).toBe(0)
  })

  it('counts the two reasons apart — they are different facts about the day', () => {
    const out = listableClips([closed, open, yesterday], WINDOW)
    expect(out.kept).toEqual([closed])
    expect(out.inProgress).toBe(1)
    expect(out.outOfWindow).toBe(1)
  })

  it('never counts an out-of-window row twice, even when it is also open', () => {
    // It is dropped by the window first; reporting it under both would make
    // the log line's arithmetic disagree with the row count.
    const out = listableClips([{ ...yesterday, inProgress: true }], WINDOW)
    expect(out.outOfWindow).toBe(1)
    expect(out.inProgress).toBe(0)
  })

  it('answers empty rather than throwing when every row is refused', () => {
    expect(listableClips([open], WINDOW).kept).toEqual([])
  })
})
