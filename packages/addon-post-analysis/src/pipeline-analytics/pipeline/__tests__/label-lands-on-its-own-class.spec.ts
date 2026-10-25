/**
 * A label computed for a subject of class X never lands on a track of class Y.
 *
 * Measured on the live hub (2026-10-13, 8/8 reviewed): PERSON tracks carried
 * `dog` / `bird` attributed to `detector-link:animal-classifier`, one with
 * `classes ['person','animal']`. The tracker lets a person/animal detection
 * match across the flip, and the track's class is the VOTED one, while the
 * label rides the matched detection's own bbox — so a frame where the detector
 * called a person "dog" wrote `dog` onto a person track.
 */
import type { FrameResult, ObjectDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FrameProcessor } from '../frame-processor.js'
import { resolveTieredLabelWrite } from '../label-tier.js'

const LINK = 'detector-link:animal-classifier'
const BOX = { x: 100, y: 100, width: 50, height: 50 }

function det(
  id: string,
  macroClass: ObjectDetection['macroClass'],
  bbox = BOX,
  link?: string,
  score = 0.9,
): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass,
    score,
    labels:
      link === undefined ? [] : [{ label: link, score: 0, tier: 1, stepId: LINK, modelId: 'm' }],
    bbox,
  }
}

function frame(detections: readonly ObjectDetection[], timestamp: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: 4,
    timestamp,
    width: 640,
    height: 480,
    detections,
  }
}

describe('the tiered write rule — a classifier answer needs its own class', () => {
  it('refuses an animal-classifier link on a person track, and says why', () => {
    const decision = resolveTieredLabelWrite(
      { className: 'person' },
      { text: 'dog', tier: 1, score: 0, stepId: LINK, decidedAt: 1 },
    )
    expect(decision).toMatchObject({
      kind: 'refused',
      reason: { kind: 'class-mismatch', className: 'person', expectedClass: 'animal' },
    })
  })

  it('refuses the classifier step itself on a vehicle track, accepts it on an animal', () => {
    const c = {
      text: 'dog',
      tier: 1,
      score: 0.8,
      stepId: 'animal-classifier',
      decidedAt: 1,
    } as const
    expect(resolveTieredLabelWrite({ className: 'vehicle' }, c).kind).toBe('refused')
    expect(resolveTieredLabelWrite({ className: 'animal' }, c).kind).toBe('write')
  })
})

describe('FrameProcessor — a label rides only its own class', () => {
  it('a person track does not take the dog a flipped frame carried', () => {
    const p = new FrameProcessor(4)
    for (let i = 0; i < 4; i++) {
      const t = 1000 + i * 100
      p.process({ timestamp: t, frame: frame([det('p', 'person')], t) })
    }
    const flipped = p.process({
      timestamp: 1400,
      frame: frame([det('a', 'animal', BOX, 'dog', 0.4)], 1400),
    })
    // A weak animal read over a confirmed person is the tracker's allowed flip
    // (`animalOverPersonMaxScore`): it BINDS to the person track.
    const track = flipped.tracked.find((t) => t.matchedThisFrame)
    expect(track?.className).toBe('person')
    expect(track?.labelPatch).toBeUndefined()
    expect(p.getLastLabelWriteRefusals().map((r) => r.reason.kind)).toContain('class-mismatch')
  })

  it('a person and an animal in one frame keep each their own label', () => {
    const p = new FrameProcessor(4)
    const person = { x: 20, y: 100, width: 50, height: 120 }
    const animal = { x: 400, y: 300, width: 60, height: 40 }
    let out = p.process({ timestamp: 1000, frame: frame([], 1000) })
    for (let i = 0; i < 4; i++) {
      const t = 1000 + i * 100
      out = p.process({
        timestamp: t,
        frame: frame([det('p', 'person', person), det('a', 'animal', animal, 'dog')], t),
      })
    }
    const byClass = new Map(out.tracked.map((t) => [t.className, t.labelPatch?.label]))
    expect(byClass.get('person')).toBeUndefined()
    expect(byClass.get('animal')).toBe('dog')
  })
})
