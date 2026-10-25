/**
 * The BUDGET on a pre-roll catch-up burst, and the accounting that makes it
 * reportable.
 *
 * ~4 s of retained history at a session's detection fps is tens of frames
 * arriving in one decode burst. Inferring all of them would inference-storm a
 * node the moment several cameras open at once. This policy is what turns
 * "infer the pre-roll" into a bounded, one-shot, LOSSY-BY-DESIGN pass — and
 * what says, per session, exactly what it dropped and why.
 */
import { describe, expect, it } from 'vitest'
import { PreRollBurst, planPreRollBurst, type PreRollBurstInput } from '../pre-roll-burst.js'

describe('planPreRollBurst', () => {
  it('samples the WHOLE window rather than the newest end of it', () => {
    // 4 s of history at 12 fps ≈ 48 frames; the budget is 12. Widening the
    // stride keeps coverage across the whole window. Truncating instead
    // (drop-oldest) would keep only the last second — precisely the frames the
    // live path was already going to see, so it would fix nothing: the
    // measured miss (a cyclist scored 0.5669 at −1.68 s) is at the OLD end.
    const plan = planPreRollBurst({ spanMs: 4000, detectionFps: 12, maxFrames: 12 })
    expect(plan.strideMs).toBeGreaterThanOrEqual(4000 / 12)
    expect(plan.plannedFrames).toBeLessThanOrEqual(12)
    expect(plan.subsampled).toBe(true)
  })

  it('keeps the session detection cadence when it already fits the budget', () => {
    const plan = planPreRollBurst({ spanMs: 4000, detectionFps: 2, maxFrames: 12 })
    expect(plan.strideMs).toBe(500)
    expect(plan.subsampled).toBe(false)
  })

  it('plans nothing when there is no history to spend', () => {
    const plan = planPreRollBurst({ spanMs: 0, detectionFps: 12, maxFrames: 12 })
    expect(plan.plannedFrames).toBe(0)
  })
})

describe('PreRollBurst', () => {
  const budget = { maxFrames: 4, maxWallMs: 1000 }
  const make = (): PreRollBurst =>
    new PreRollBurst({
      budget,
      plan: planPreRollBurst({ spanMs: 4000, detectionFps: 1, maxFrames: budget.maxFrames }),
      startedAtWall: 10_000,
    })

  it('admits history on the planned MEDIA stride, not on wall clock', () => {
    const burst = make()
    // Four frames 1 s apart in MEDIA time, all decoded inside 20 ms of wall
    // clock — the catch-up burst. A wall-clock throttle (what ships today,
    // frame-slot.ts:120) rejects three of these.
    expect(burst.offer(96_000, 10_000).admitted).toBe(true)
    expect(burst.offer(97_000, 10_005).admitted).toBe(true)
    expect(burst.offer(98_000, 10_010).admitted).toBe(true)
    expect(burst.offer(99_000, 10_015).admitted).toBe(true)
    expect(burst.report().inferred).toBe(4)
  })

  it('drops a frame that falls inside the media stride', () => {
    const burst = make()
    expect(burst.offer(96_000, 10_000).admitted).toBe(true)
    const verdict = burst.offer(96_100, 10_002)
    expect(verdict.admitted).toBe(false)
    expect(verdict.reason).toBe('stride')
  })

  it('stops at the FRAME budget and says so', () => {
    const burst = make()
    for (let i = 0; i < 4; i++) burst.offer(96_000 + i * 1000, 10_000)
    // Still history (media far ahead of the wall clock) — so the only thing
    // that can turn this away is the frame budget.
    expect(burst.offer(99_900, 10_020).reason).toBe('budget-frames')
    const verdict = burst.offer(99_950, 10_020)
    expect(verdict.admitted).toBe(false)
    expect(verdict.reason).toBe('budget-frames')
    expect(burst.finished).toBe(true)
  })

  it('stops at the WALL-CLOCK budget — a burst still running has lost to live', () => {
    const burst = make()
    expect(burst.offer(96_000, 10_000).admitted).toBe(true)
    const verdict = burst.offer(97_000, 11_500)
    expect(verdict.admitted).toBe(false)
    expect(verdict.reason).toBe('budget-wall-ms')
    expect(burst.finished).toBe(true)
  })

  it('ENDS at the live edge — a frame that is no longer history is not pre-roll', () => {
    const burst = make()
    burst.offer(96_000, 10_000) // establishes the lead
    // The decoder has caught up: this frame's own moment IS the wall clock.
    const verdict = burst.offer(10_020, 10_020)
    expect(verdict.admitted).toBe(false)
    expect(verdict.reason).toBe('live-edge')
    expect(burst.finished).toBe(true)
  })

  it('reports offered / inferred / dropped with a reason breakdown', () => {
    const burst = make()
    burst.offer(96_000, 10_000)
    burst.offer(96_100, 10_001)
    burst.offer(97_000, 10_002)
    burst.offer(10_003, 10_003)
    const report = burst.report()
    expect(report.offered).toBe(4)
    expect(report.inferred).toBe(2)
    expect(report.dropped).toBe(2)
    expect(report.droppedByReason.stride).toBe(1)
    expect(report.droppedByReason['live-edge']).toBe(1)
  })

  it('a burst with no budget admits nothing and still reports', () => {
    const burst = new PreRollBurst({
      budget: { maxFrames: 0, maxWallMs: 1000 },
      plan: planPreRollBurst({ spanMs: 4000, detectionFps: 1, maxFrames: 0 }),
      startedAtWall: 0,
    })
    expect(burst.offer(96_000, 0).admitted).toBe(false)
    expect(burst.report().inferred).toBe(0)
  })

  // ── the live edge is MEASURED, not declared ──────────────────────────────
  //
  // The burst used to end at a wall clock the caller computed from the SERVED
  // span — and that span never reached this process. `decode-worker-child.ts`
  // hard-coded it to 0 with a comment saying so, which meant no burst was ever
  // created: 1 157 "burst suppressed" lines in 20 h on this fleet, and the
  // broker's ~4 s of history decoded and thrown away on every session.
  //
  // The span does not have to be told. During a catch-up burst the decoder
  // races through buffered media faster than real time, so a frame's own moment
  // runs AHEAD of the wall clock; when the two converge the decoder has caught up
  // and the live path owns the camera. That is exactly the live edge, it is
  // measurable here, and it needs nothing from the broker.
  describe('PreRollBurst — the measured live edge', () => {
    const burst = (over: Partial<PreRollBurstInput> = {}): PreRollBurst =>
      new PreRollBurst({
        budget: { maxFrames: 12, maxWallMs: 5_000 },
        plan: { strideMs: 100, plannedFrames: 12, subsampled: false },
        startedAtWall: 1_000,
        ...over,
      })

    it('admits while media runs AHEAD of the wall clock', () => {
      const b = burst()
      // 400 ms of footage delivered in 10 ms of wall: still catching up.
      expect(b.offer(1_400, 1_010).admitted).toBe(true)
      expect(b.finished).toBe(false)
    })

    it('ends when the two converge — and says the span it measured', () => {
      const b = burst()
      b.offer(1_400, 1_010)
      const v = b.offer(4_000, 4_050)
      expect(v).toEqual({ admitted: false, reason: 'live-edge' })
      expect(b.finished).toBe(true)
    })

    // The slack IS the convergence threshold, not a tolerance around it: a
    // decoder within 100 ms of real time has caught up, whichever side of the
    // line jitter puts it on. Stated as the boundary so a future change to the
    // constant has to face what it means.
    it('a lead above the slack is still history', () => {
      const b = burst()
      expect(b.offer(1_150, 1_000).admitted).toBe(true)
      expect(b.finished).toBe(false)
    })

    it('a lead at or below the slack is the live edge', () => {
      const b = burst()
      b.offer(1_500, 1_000) // establishes the lead
      expect(b.offer(1_040, 1_000)).toEqual({ admitted: false, reason: 'live-edge' })
    })

    it('stays ended once it has ended', () => {
      const b = burst()
      b.offer(1_400, 1_010) // establishes the lead
      b.offer(4_000, 4_050)
      expect(b.offer(9_000, 5_000).admitted).toBe(false)
    })

    it('reports the measured span, which is what the broker actually served', () => {
      const b = burst()
      b.offer(1_400, 1_010) // 390 ms ahead
      b.offer(3_900, 1_060) // 2 840 ms ahead — the widest lead seen
      b.offer(4_100, 4_150) // converged
      expect(b.servedSpanMs()).toBe(2_840)
    })

    // The FIRST frame of a session is anchored AT the wall clock, so its lead is
    // zero by construction — the media has not had a chance to run ahead yet.
    // Ending the burst on it would end every burst on its first frame, which is
    // the same as having none.
    it('does not end on the first frame, whose lead is zero by construction', () => {
      const b = burst()
      expect(b.offer(1_000, 1_000).admitted).toBe(true)
      expect(b.finished).toBe(false)
      // …and the SECOND frame, now leading, keeps it open.
      expect(b.offer(2_000, 1_005).admitted).toBe(true)
    })

    it('ends on convergence once a lead has actually been seen', () => {
      const b = burst()
      b.offer(1_000, 1_000)
      b.offer(2_000, 1_005)
      expect(b.offer(2_100, 2_100)).toEqual({ admitted: false, reason: 'live-edge' })
    })

    it('measures nothing when no frame ever led the clock', () => {
      const b = burst()
      b.offer(1_000, 1_000)
      expect(b.servedSpanMs()).toBeNull()
    })
  })
})
