/**
 * The runner cuts a candidate birth's own pixels AT DETECTION TIME (D379).
 *
 * Every assertion here is paired with the field measurement that motivates it:
 * over three hours on the live hub the after-the-fact by-handle path missed
 * 7 452 times (99.9% `worker-lease-gone`), with misses recorded at
 * `handleAgeMs=254` — so nothing about a retention window can fix it, and the
 * only reliable instant is the one the pixels are already in hand.
 */
import { describe, expect, it } from 'vitest'
import {
  BIRTH_EVIDENCE_MAX_PER_FRAME,
  BIRTH_EVIDENCE_NOVELTY_WINDOW_MS,
  BirthNoveltyMemory,
  planBirthEvidence,
} from '../birth-evidence.js'

const FRAME = { width: 640, height: 360 } as const

const det = (
  x: number,
  y: number,
  width: number,
  height: number,
  score = 0.8,
  macroClass = 'person',
): {
  bbox: { x: number; y: number; width: number; height: number }
  score: number
  macroClass: string
} => ({
  bbox: { x, y, width, height },
  score,
  macroClass,
})

describe('BirthNoveltyMemory', () => {
  it('calls a box novel the first time and NOT novel while it is still remembered', () => {
    const memory = new BirthNoveltyMemory()
    const box = { x: 100, y: 100, width: 80, height: 160 }
    expect(memory.isNovel(101, box, 'person', 1_000)).toBe(true)
    memory.note(101, [{ bbox: box, macroClass: 'person' }], 1_000)
    expect(memory.isNovel(101, box, 'person', 1_100)).toBe(false)
  })

  it('forgets a box once the window has passed — a subject that left and came back is a new birth', () => {
    const memory = new BirthNoveltyMemory()
    const box = { x: 100, y: 100, width: 80, height: 160 }
    memory.note(101, [{ bbox: box, macroClass: 'person' }], 1_000)
    expect(memory.isNovel(101, box, 'person', 1_000 + BIRTH_EVIDENCE_NOVELTY_WINDOW_MS + 1)).toBe(
      true,
    )
  })

  it('is CLASS-AWARE: a dog at its owner’s knee is novel even though a person box covers it', () => {
    // The exact geometry of D378: a 600x1000 person box with a 250x250 animal
    // inside it. A class-blind novelty test would call the dog "already seen"
    // and it would reach the gate with no pixels of its own — which is the
    // failure D372/D377/D378 have each fought at a different layer.
    const memory = new BirthNoveltyMemory()
    memory.note(
      101,
      [{ bbox: { x: 0, y: 0, width: 600, height: 1000 }, macroClass: 'person' }],
      1_000,
    )
    expect(memory.isNovel(101, { x: 100, y: 700, width: 250, height: 250 }, 'animal', 1_050)).toBe(
      true,
    )
  })

  it('keeps cameras apart — camera 102 seeing a box says nothing about 101', () => {
    const memory = new BirthNoveltyMemory()
    const box = { x: 10, y: 10, width: 50, height: 50 }
    memory.note(102, [{ bbox: box, macroClass: 'person' }], 1_000)
    expect(memory.isNovel(101, box, 'person', 1_010)).toBe(true)
  })

  it('drops a device wholesale on detach', () => {
    const memory = new BirthNoveltyMemory()
    const box = { x: 10, y: 10, width: 50, height: 50 }
    memory.note(101, [{ bbox: box, macroClass: 'person' }], 1_000)
    memory.clearDevice(101)
    expect(memory.isNovel(101, box, 'person', 1_010)).toBe(true)
  })

  it('bounds what it remembers per camera so a crowded scene cannot grow it without limit', () => {
    const memory = new BirthNoveltyMemory()
    const boxes = Array.from({ length: 200 }, (_, i) => ({
      bbox: { x: i * 3, y: 0, width: 2, height: 2 },
      macroClass: 'person',
    }))
    memory.note(101, boxes, 1_000)
    expect(memory.rememberedCount(101)).toBeLessThanOrEqual(64)
  })
})

describe('planBirthEvidence', () => {
  const memory = (): BirthNoveltyMemory => new BirthNoveltyMemory()

  it('plans a cut for a novel box and none for one already seen', () => {
    const m = memory()
    const first = planBirthEvidence(101, [det(100, 50, 140, 160)], FRAME, m, 1_000)
    expect(first).toHaveLength(1)
    const second = planBirthEvidence(101, [det(100, 50, 140, 160)], FRAME, m, 1_100)
    expect(second).toHaveLength(0)
  })

  it('pads the box and clamps it inside the frame — never a rectangle off the raster', () => {
    const [entry] = planBirthEvidence(101, [det(0, 0, 200, 200)], FRAME, memory(), 1_000)
    expect(entry).toBeDefined()
    if (!entry) return
    expect(entry.rect.x).toBe(0)
    expect(entry.rect.y).toBe(0)
    expect(entry.rect.x + entry.rect.width).toBeLessThanOrEqual(FRAME.width)
    expect(entry.rect.y + entry.rect.height).toBeLessThanOrEqual(FRAME.height)
    // Padded, not the bare box: the gate re-detects, and a box cut flush to the
    // subject is the "130 px blob with no context" D377 measured as a coin flip.
    expect(entry.rect.width).toBeGreaterThan(200)
  })

  it('caps the target width so an evidence crop can never become a frame (D9/D18)', () => {
    const [entry] = planBirthEvidence(101, [det(0, 0, 640, 360)], FRAME, memory(), 1_000)
    expect(entry).toBeDefined()
    if (!entry) return
    expect(entry.target.width).toBeLessThanOrEqual(320)
    // Aspect preserved: a squashed crop is a different image to the detector.
    const srcAspect = entry.rect.width / entry.rect.height
    const dstAspect = entry.target.width / entry.target.height
    expect(Math.abs(srcAspect - dstAspect)).toBeLessThan(0.05)
  })

  it('never upscales — a small box is cut at its own size', () => {
    const [entry] = planBirthEvidence(101, [det(100, 100, 140, 140)], FRAME, memory(), 1_000)
    expect(entry).toBeDefined()
    if (!entry) return
    expect(entry.target.width).toBeLessThanOrEqual(entry.rect.width)
  })

  it('bounds the per-frame cost: highest score first, capped', () => {
    const dets = [
      det(0, 0, 140, 140, 0.5),
      det(150, 0, 140, 140, 0.9),
      det(300, 0, 140, 140, 0.7),
      det(450, 0, 140, 140, 0.6),
    ]
    const plan = planBirthEvidence(101, dets, FRAME, memory(), 1_000)
    expect(plan).toHaveLength(BIRTH_EVIDENCE_MAX_PER_FRAME)
    expect(plan.map((p) => p.index)).toEqual([1, 2])
  })

  it('refuses a box below the measured coin-flip size (D377, ~130 px) — the crop would not be a measurement', () => {
    expect(planBirthEvidence(101, [det(10, 10, 40, 40)], FRAME, memory(), 1_000)).toHaveLength(0)
  })

  it('refuses a degenerate or non-finite box rather than clamping it', () => {
    expect(planBirthEvidence(101, [det(10, 10, 0, 40)], FRAME, memory(), 1_000)).toHaveLength(0)
    expect(
      planBirthEvidence(101, [det(Number.NaN, 10, 40, 40)], FRAME, memory(), 1_000),
    ).toHaveLength(0)
  })

  it('refuses everything on a frame with no dimensions', () => {
    expect(
      planBirthEvidence(101, [det(10, 10, 40, 40)], { width: 0, height: 0 }, memory(), 1_000),
    ).toHaveLength(0)
  })

  it('remembers EVERY detection of the frame, not only the ones it planned', () => {
    // Otherwise the cap turns into a leak: the two boxes that lost the budget
    // would be "novel" again on the very next frame, forever.
    const m = memory()
    const dets = [det(0, 0, 60, 60, 0.9), det(100, 0, 60, 60, 0.8), det(200, 0, 60, 60, 0.7)]
    planBirthEvidence(101, dets, FRAME, m, 1_000)
    expect(planBirthEvidence(101, dets, FRAME, m, 1_100)).toHaveLength(0)
  })
})
