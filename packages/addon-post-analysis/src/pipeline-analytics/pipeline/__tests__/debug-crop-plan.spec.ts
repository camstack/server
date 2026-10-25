/**
 * The rectangle a DEBUG crop cuts, pinned.
 *
 * Every case here is one of the three 2026-09-18 traces the operator could not
 * close: a reflection tracked as a subject (the mirror is OUTSIDE a tight box),
 * a growth rescue that should not have fired (the two boxes are DISJOINT — a
 * crop of the winner shows nothing about the decision), and a best shot stuck
 * on a border-touching frame (the crop was a sliver and did not say it was at
 * an edge).
 */
import { describe, expect, it } from 'vitest'
import {
  DEBUG_CROP_CONTEXT_RATIO,
  DEBUG_CROP_MIN_SIDE_FRAC,
  debugCropLabel,
  debugCropMeta,
  planDebugCrop,
} from '../debug-crop-plan.js'

const FW = 1920
const FH = 1080

describe('planDebugCrop — the rectangle', () => {
  it('refuses a degenerate frame and says which', () => {
    const r = planDebugCrop({
      decision: 'best-shot',
      subject: { x: 10, y: 10, w: 20, h: 20 },
      frameWidth: 0,
      frameHeight: 0,
    })
    expect(r.kind).toBe('refused')
    if (r.kind === 'refused') expect(r.reason).toBe('degenerate-frame')
  })

  it('refuses a degenerate subject and says which', () => {
    const r = planDebugCrop({
      decision: 'best-shot',
      subject: { x: 10, y: 10, w: 0, h: 20 },
      frameWidth: FW,
      frameHeight: FH,
    })
    expect(r.kind).toBe('refused')
    if (r.kind === 'refused') expect(r.reason).toBe('degenerate-subject')
  })

  it('pads a mid-frame subject by the CONTEXT ratio, not an enrichment padding', () => {
    // A 300x200 subject in the middle of the frame. At ratio 1.0 the window is
    // 3x the box on each axis: the neighbourhood that explains a reflection.
    const r = planDebugCrop({
      decision: 'reflection-suspect',
      subject: { x: 800, y: 400, w: 300, h: 200 },
      frameWidth: FW,
      frameHeight: FH,
    })
    expect(r.kind).toBe('plan')
    if (r.kind !== 'plan') return
    expect(r.contextRatio).toBe(DEBUG_CROP_CONTEXT_RATIO)
    expect(r.rect.w).toBeCloseTo(300 * (1 + 2 * DEBUG_CROP_CONTEXT_RATIO), 3)
    expect(r.rect.h).toBeCloseTo(200 * (1 + 2 * DEBUG_CROP_CONTEXT_RATIO), 3)
    expect(r.floorApplied).toBe(false)
    expect(r.clippedSides).toEqual([])
  })

  it('covers the UNION of subject and rival when a decision picked between two', () => {
    // best-shot: the candidate and the held peak it displaced need not
    // overlap at all (different frames, different poses). A crop of the
    // winner alone cannot show what it beat.
    const subject = { x: 900, y: 500, w: 40, h: 40 }
    const rival = { x: 1000, y: 560, w: 120, h: 180 }
    const r = planDebugCrop({
      decision: 'best-shot',
      subject,
      rival,
      frameWidth: FW,
      frameHeight: FH,
    })
    expect(r.kind).toBe('plan')
    if (r.kind !== 'plan') return
    // The union spans x 900..1120, y 500..740 — both boxes are strictly inside
    // the window, with context around them.
    expect(r.rect.x).toBeLessThan(subject.x)
    expect(r.rect.y).toBeLessThan(subject.y)
    expect(r.rect.x + r.rect.w).toBeGreaterThan(rival.x + rival.w)
    expect(r.rect.y + r.rect.h).toBeGreaterThan(rival.y + rival.h)
    // and both are drawn, crop-relative, so the reader can tell them apart.
    expect(r.boxes.map((b) => b.role)).toEqual(['subject', 'rival'])
    const drawnSubject = r.boxes[0]
    expect(drawnSubject).toBeDefined()
    if (!drawnSubject) return
    expect(drawnSubject.x).toBeCloseTo(subject.x - r.rect.x, 3)
    expect(drawnSubject.y).toBeCloseTo(subject.y - r.rect.y, 3)
    expect(drawnSubject.w).toBe(subject.w)
  })

  it('grows a SLIVER subject to the minimum side so the crop is legible', () => {
    // 24x18 px on a 1920x1080 frame: padded at ratio 1.0 the window is 72x54 —
    // a sliver, which is exactly what made the last investigation guesswork.
    const r = planDebugCrop({
      decision: 'best-shot',
      subject: { x: 900, y: 500, w: 24, h: 18 },
      frameWidth: FW,
      frameHeight: FH,
    })
    expect(r.kind).toBe('plan')
    if (r.kind !== 'plan') return
    expect(r.floorApplied).toBe(true)
    expect(r.contextRatio).toBeGreaterThan(DEBUG_CROP_CONTEXT_RATIO)
    const minSide = DEBUG_CROP_MIN_SIDE_FRAC * Math.min(FW, FH)
    // The SHORT side of the window reaches the floor; more source pixels means
    // a bigger legible image with NO upscale anywhere.
    expect(Math.min(r.rect.w, r.rect.h)).toBeGreaterThanOrEqual(minSide - 0.001)
    // The subject is still in there, and still drawn.
    expect(r.boxes[0]?.w).toBe(24)
  })

  it('never asks for more than the frame', () => {
    const r = planDebugCrop({
      decision: 'best-shot',
      subject: { x: 100, y: 100, w: 1700, h: 900 },
      frameWidth: FW,
      frameHeight: FH,
    })
    expect(r.kind).toBe('plan')
    if (r.kind !== 'plan') return
    expect(r.rect.x).toBeGreaterThanOrEqual(0)
    expect(r.rect.y).toBeGreaterThanOrEqual(0)
    expect(r.rect.x + r.rect.w).toBeLessThanOrEqual(FW + 0.001)
    expect(r.rect.y + r.rect.h).toBeLessThanOrEqual(FH + 0.001)
  })

  it('NAMES the borders a clipped subject touches — the frame position is the evidence', () => {
    // The mirror trace: the subject is flush against the right border. The crop
    // window slides inside the frame (padBbox keeps the extent), so position in
    // the crop no longer says "edge" — the plan must say it in words.
    const r = planDebugCrop({
      decision: 'best-shot',
      subject: { x: 1860, y: 400, w: 60, h: 300 },
      frameWidth: FW,
      frameHeight: FH,
    })
    expect(r.kind).toBe('plan')
    if (r.kind !== 'plan') return
    expect(r.clippedSides).toEqual(['right'])
    expect(r.subjectCenterNorm.x).toBeCloseTo(1890 / FW, 3)
  })

  it('names EVERY border a corner subject touches', () => {
    const r = planDebugCrop({
      decision: 'birth-confirmation',
      subject: { x: 0, y: 0, w: 80, h: 80 },
      frameWidth: FW,
      frameHeight: FH,
    })
    expect(r.kind).toBe('plan')
    if (r.kind !== 'plan') return
    expect(r.clippedSides).toEqual(['left', 'top'])
  })
})

describe('debugCropMeta / debugCropLabel — what the crop IS', () => {
  const plan = planDebugCrop({
    decision: 'best-shot',
    subject: { x: 900, y: 500, w: 40, h: 40 },
    rival: { x: 1000, y: 560, w: 120, h: 180 },
    frameWidth: FW,
    frameHeight: FH,
  })

  it('carries the decision, the track, and the numbers the decision rested on', () => {
    expect(plan.kind).toBe('plan')
    if (plan.kind !== 'plan') return
    const meta = debugCropMeta(plan, {
      decision: 'best-shot',
      trackId: 'abc123',
      rivalTrackId: 'def456',
      timestamp: 1_700_000_000_000,
      evidence: { areaRatio: 13.5, centroidDist: 118.4, trackAgeMs: 640, accepted: true },
    })
    expect(meta.decision).toBe('best-shot')
    expect(meta.trackId).toBe('abc123')
    expect(meta.rivalTrackId).toBe('def456')
    expect(meta.areaRatio).toBe(13.5)
    expect(meta.centroidDist).toBe(118.4)
    expect(meta.accepted).toBe(true)
    // the rectangle it cut, so a stored crop can be re-derived from the line
    expect(meta.cropRect).toBe(
      `${Math.round(plan.rect.x)},${Math.round(plan.rect.y)} ${Math.round(plan.rect.w)}x${Math.round(plan.rect.h)}`,
    )
    expect(meta.contextRatio).toBe(plan.contextRatio)
    expect(meta.floorApplied).toBe(plan.floorApplied)
  })

  it('an evidence key never shadows a structural one', () => {
    expect(plan.kind).toBe('plan')
    if (plan.kind !== 'plan') return
    const meta = debugCropMeta(plan, {
      decision: 'best-shot',
      trackId: 'abc123',
      timestamp: 1,
      // a caller that spells `decision` in its evidence must not be able to
      // rename the decision the crop belongs to.
      evidence: { decision: 'something-else', trackId: 'wrong' },
    })
    expect(meta.decision).toBe('best-shot')
    expect(meta.trackId).toBe('abc123')
  })

  it('burns an attributable caption into the crop', () => {
    expect(plan.kind).toBe('plan')
    if (plan.kind !== 'plan') return
    const label = debugCropLabel(plan, {
      decision: 'best-shot',
      trackId: 'abc123',
      rivalTrackId: 'def456',
      timestamp: 1,
      evidence: { areaRatio: 13.5, accepted: true },
    })
    expect(label).toContain('best-shot')
    expect(label).toContain('abc123')
    expect(label).toContain('areaRatio=13.5')
  })

  it('says the subject was at a border, in the caption', () => {
    const edge = planDebugCrop({
      decision: 'best-shot',
      subject: { x: 1860, y: 400, w: 60, h: 300 },
      frameWidth: FW,
      frameHeight: FH,
    })
    expect(edge.kind).toBe('plan')
    if (edge.kind !== 'plan') return
    const label = debugCropLabel(edge, {
      decision: 'best-shot',
      trackId: 'zzz',
      timestamp: 1,
      evidence: { decidedBy: 'edge-clear' },
    })
    expect(label).toContain('clipped:right')
  })
})
