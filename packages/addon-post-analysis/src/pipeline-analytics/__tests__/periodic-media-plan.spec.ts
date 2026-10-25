import { describe, it, expect } from 'vitest'
import { planPeriodicMedia, type PeriodicMediaPlanInput } from '../periodic-media-plan.js'

const base = (over: Partial<PeriodicMediaPlanInput> = {}): PeriodicMediaPlanInput => ({
  debugMediaEnabled: true,
  dueSnapshot: false,
  isNewBest: false,
  thumbnailLanded: true,
  lastFrameAt: 1_000,
  now: 1_000 + 5_000,
  intervalMs: 5_000,
  ...over,
})

describe('planPeriodicMedia', () => {
  it('appends a snapshot when dueSnapshot', () => {
    const plan = planPeriodicMedia(base({ dueSnapshot: true }))
    expect(plan.appendSnapshot).toBe(true)
  })

  it('mirrors isNewBest onto bestThumbnail once a thumbnail has landed', () => {
    expect(planPeriodicMedia(base({ isNewBest: true, thumbnailLanded: true })).bestThumbnail).toBe(
      true,
    )
    expect(planPeriodicMedia(base({ isNewBest: false, thumbnailLanded: true })).bestThumbnail).toBe(
      false,
    )
  })

  it('#27-A: forces a best-thumbnail retry every frame until one has landed', () => {
    // No new-best this frame, but no thumbnail persisted yet → force a capture.
    expect(
      planPeriodicMedia(base({ isNewBest: false, thumbnailLanded: false })).bestThumbnail,
    ).toBe(true)
    // Once it lands, a non-new-best frame no longer forces a capture.
    expect(planPeriodicMedia(base({ isNewBest: false, thumbnailLanded: true })).bestThumbnail).toBe(
      false,
    )
  })

  it('defaults thumbnailLanded to already-landed when omitted (legacy callers)', () => {
    const plan = planPeriodicMedia({
      debugMediaEnabled: true,
      dueSnapshot: false,
      isNewBest: false,
      lastFrameAt: 1_000,
      now: 6_000,
      intervalMs: 5_000,
    })
    expect(plan.bestThumbnail).toBe(false)
  })

  // ── The end-of-track duplicate fix: lastFrame is NEVER the same frame as a
  //    snapshot, so it can never be byte-identical to the most recent snapshot.
  it('NEVER rolls lastFrame on a frame where a snapshot is appended', () => {
    const plan = planPeriodicMedia(
      base({ dueSnapshot: true, lastFrameAt: 0 /* interval long elapsed */ }),
    )
    expect(plan.appendSnapshot).toBe(true)
    expect(plan.rollingLastFrame).toBe(false)
  })

  it('appendSnapshot and rollingLastFrame are mutually exclusive across cases', () => {
    for (const dueSnapshot of [true, false]) {
      for (const lastFrameAt of [0, 1_000, 6_000]) {
        const plan = planPeriodicMedia(base({ dueSnapshot, lastFrameAt, now: 6_000 }))
        expect(plan.appendSnapshot && plan.rollingLastFrame).toBe(false)
      }
    }
  })

  it('does NOT roll lastFrame while firstFrame has not landed (1b659d56)', () => {
    const plan = planPeriodicMedia(
      base({
        dueSnapshot: false,
        lastFrameAt: 1_000,
        now: 6_000,
        firstFrameLanded: false,
      }),
    )
    expect(plan.rollingLastFrame).toBe(false)
  })

  it('rolls lastFrame on a NON-snapshot frame once its own interval elapsed', () => {
    // Stationary frame (no snapshot appended), own cadence elapsed → roll.
    const plan = planPeriodicMedia(base({ dueSnapshot: false, lastFrameAt: 1_000, now: 6_000 }))
    expect(plan.rollingLastFrame).toBe(true)
  })

  it('does NOT roll lastFrame before its own interval elapsed', () => {
    const plan = planPeriodicMedia(base({ dueSnapshot: false, lastFrameAt: 5_000, now: 6_000 }))
    expect(plan.rollingLastFrame).toBe(false)
  })

  // The keep-set boundary: debug media OFF removes the filmstrip and NOTHING
  // else. `lastFrame` used to be gated by the retired `saveThumbnails`; a
  // camera at the default must still close with a fresh close-candidate, or
  // the close-time promotion has nothing to absorb and the audit's
  // MISSING_LASTFRAME fires on healthy cameras.
  it('debug media off suppresses the filmstrip snapshot but STILL rolls lastFrame', () => {
    const plan = planPeriodicMedia(
      base({ debugMediaEnabled: false, dueSnapshot: true, lastFrameAt: 0, now: 6_000 }),
    )
    expect(plan.appendSnapshot).toBe(false)
    expect(plan.rollingLastFrame).toBe(true)
  })

  // ── firstFrame === lastFrame duplicate fix (birth-frame seed) ──────────────
  //
  // The `lastFrame` rolling clock (`lastFrameAtByTrack`) is SEEDED to the birth
  // timestamp in the caller (index.ts) alongside the snapshot clock. These two
  // tests pin the contract that seed enforces vs. the bug it prevents.
  it('does NOT roll lastFrame on the BIRTH frame when the clock is seeded at birth', () => {
    const birth = 1_720_000_000_000
    // Birth frame: lastFrameAt seeded to birth, now == birth, snapshot clock also
    // seeded so no snapshot is due yet. lastFrame must NOT roll — otherwise it is
    // byte-identical to the firstFrame written on this same frame.
    const plan = planPeriodicMedia(
      base({ lastFrameAt: birth, now: birth, dueSnapshot: false, intervalMs: 5_000 }),
    )
    expect(plan.rollingLastFrame).toBe(false)
  })

  it('WOULD roll lastFrame on the birth frame if left UNSEEDED (lastFrameAt=0) — the bug the seed prevents', () => {
    // Documents WHY index.ts must seed the clock at birth: with the default 0,
    // the birth frame satisfies `now - 0 >= intervalMs` and rolls a lastFrame
    // identical to the firstFrame (the reported firstFrame === lastFrame defect).
    const plan = planPeriodicMedia(
      base({ lastFrameAt: 0, now: 1_720_000_000_000, dueSnapshot: false, intervalMs: 5_000 }),
    )
    expect(plan.rollingLastFrame).toBe(true)
  })

  // ── DEFECT B: the plan advances NO clock; the caller advances `lastFrameAt`
  //    ONLY when the write lands. So a DROPPED roll (clock left un-advanced)
  //    keeps re-rolling on the next eligible frame — the retry-on-drop contract.
  it('keeps re-rolling lastFrame while the clock is NOT advanced (dropped-write retry)', () => {
    // The write dropped on frame N (recycled/blank frame) → the caller did NOT
    // advance lastFrameAt. Every later past-interval non-snapshot frame must
    // still request a roll until one actually lands.
    const lastFrameAt = 1_000
    for (const now of [7_000, 8_000, 20_000]) {
      const plan = planPeriodicMedia(
        base({ dueSnapshot: false, lastFrameAt, now, intervalMs: 5_000 }),
      )
      expect(plan.rollingLastFrame).toBe(true)
    }
  })

  it('stops rolling lastFrame once the clock advances to a landed write', () => {
    // The write LANDED on frame N (ts 6_000) → the caller advanced lastFrameAt to
    // 6_000. The immediately-following frame is now within one interval → no roll.
    const plan = planPeriodicMedia(
      base({ dueSnapshot: false, lastFrameAt: 6_000, now: 6_100, intervalMs: 5_000 }),
    )
    expect(plan.rollingLastFrame).toBe(false)
  })
})

// ── 2026-07-22: denser rolling-lastFrame cadence ─────────────────────────────
describe('planPeriodicMedia lastFrameIntervalMs', () => {
  it('rolls the lastFrame on the FASTER dedicated cadence', () => {
    const plan = planPeriodicMedia({
      debugMediaEnabled: true,
      dueSnapshot: false,
      isNewBest: false,
      lastFrameAt: 0,
      now: 1_600,
      intervalMs: 5_000,
      lastFrameIntervalMs: 1_500,
    })
    expect(plan.rollingLastFrame).toBe(true)
  })

  it('defaults to the snapshot interval when omitted (legacy)', () => {
    const plan = planPeriodicMedia({
      debugMediaEnabled: true,
      dueSnapshot: false,
      isNewBest: false,
      lastFrameAt: 0,
      now: 1_600,
      intervalMs: 5_000,
    })
    expect(plan.rollingLastFrame).toBe(false)
  })

  it('still never rolls on a snapshot frame', () => {
    const plan = planPeriodicMedia({
      debugMediaEnabled: true,
      dueSnapshot: true,
      isNewBest: false,
      lastFrameAt: 0,
      now: 1_600,
      intervalMs: 5_000,
      lastFrameIntervalMs: 1_500,
    })
    expect(plan.appendSnapshot).toBe(true)
    expect(plan.rollingLastFrame).toBe(false)
  })
})

// ── 2026-07-22 capture-pressure fix: bucket-coalesced rolls ──────────────────
describe('planPeriodicMedia bucket-coalesced lastFrame', () => {
  const base = {
    debugMediaEnabled: true,
    dueSnapshot: false,
    isNewBest: false,
    intervalMs: 5_000,
    lastFrameIntervalMs: 2_000,
  }

  it('a never-rolled track rolls on its first eligible frame (epoch clock)', () => {
    const now = 1_784_800_000_123 // any real wall-clock
    expect(planPeriodicMedia({ ...base, lastFrameAt: 0, now }).rollingLastFrame).toBe(true)
  })

  it('two tracks roll in the SAME bucket regardless of when each last rolled', () => {
    // Track A rolled at t=10_100, track B at t=11_900 — both are in bucket 5;
    // at t=12_050 (bucket 6) BOTH roll on the same frame (coalesced fetch).
    const now = 12_050
    expect(planPeriodicMedia({ ...base, lastFrameAt: 10_100, now }).rollingLastFrame).toBe(true)
    expect(planPeriodicMedia({ ...base, lastFrameAt: 11_900, now }).rollingLastFrame).toBe(true)
    // And neither re-rolls within the same bucket.
    expect(planPeriodicMedia({ ...base, lastFrameAt: 12_050, now: 13_900 }).rollingLastFrame).toBe(
      false,
    )
  })
})
