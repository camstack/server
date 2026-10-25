import type { FrameResult, ObjectDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  injectSecondarySubjects,
  SECONDARY_SUBJECT_MAX_RIDES,
  SECONDARY_SUBJECT_TTL_MS,
  SecondarySubjectQueue,
} from '../secondary-subjects.js'

const dog = { className: 'animal', score: 0.8, bbox: { x: 300, y: 400, w: 100, h: 100 } }

function frame(detections: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f1',
    deviceId: 101,
    timestamp: 1_000,
    width: 3840,
    height: 2160,
    detections,
  }
}

const person: ObjectDetection = {
  id: 'p',
  kind: 'first-level',
  macroClass: 'person',
  score: 0.9,
  labels: [],
  bbox: { x: 100, y: 200, width: 400, height: 400 },
}

describe('SecondarySubjectQueue', () => {
  it('serves a promoted subject to the next `minHits` frames of ITS key, then stops', () => {
    const queue = new SecondarySubjectQueue()
    queue.add('101:pipeline', dog, 't1', 1_000)
    expect(queue.take('616:pipeline', 1_100)).toEqual([])
    // A single ride cannot birth a track (the tracker's minHits = 3), so the
    // promotion rides exactly that many frames.
    for (let ride = 0; ride < SECONDARY_SUBJECT_MAX_RIDES; ride += 1) {
      const taken = queue.take('101:pipeline', 1_100 + ride * 100)
      expect(taken).toHaveLength(1)
      expect(taken[0]!.subject).toEqual(dog)
      expect(taken[0]!.foundBesideTrackId).toBe('t1')
    }
    expect(queue.take('101:pipeline', 1_500)).toEqual([])
  })

  it('never serves a promotion past its TTL, however many rides it has left', () => {
    const queue = new SecondarySubjectQueue()
    queue.add('101:pipeline', dog, 't1', 1_000)
    expect(queue.take('101:pipeline', 1_000 + SECONDARY_SUBJECT_TTL_MS + 1)).toEqual([])
  })

  it('stops riding a subject a real detection took over', () => {
    const queue = new SecondarySubjectQueue()
    queue.add('101:pipeline', dog, 't1', 1_000)
    const taken = queue.take('101:pipeline', 1_100)
    queue.drop('101:pipeline', taken[0]!.id)
    expect(queue.take('101:pipeline', 1_200)).toEqual([])
  })
})

describe('injectSecondarySubjects', () => {
  it('adds one first-level detection per pending subject, in frame pixels, with the gate score', () => {
    const out = injectSecondarySubjects(frame([person]), [
      { id: 's1', subject: dog, foundBesideTrackId: 't1' },
    ]).frame
    expect(out.detections).toHaveLength(2)
    const added = out.detections[1]!
    expect(added.kind).toBe('first-level')
    expect(added.macroClass).toBe('animal')
    expect(added.score).toBe(0.8)
    expect(added.bbox).toEqual({ x: 300, y: 400, width: 100, height: 100 })
    expect(added.id).toContain('t1')
  })

  it('does not double a subject the runner already detected on this frame', () => {
    const detectedDog: ObjectDetection = {
      id: 'd',
      kind: 'first-level',
      macroClass: 'animal',
      score: 0.7,
      labels: [],
      bbox: { x: 305, y: 405, width: 100, height: 100 },
    }
    const input = frame([person, detectedDog])
    const out = injectSecondarySubjects(input, [
      { id: 's1', subject: dog, foundBesideTrackId: 't1' },
    ])
    expect(out.frame).toBe(input)
    // and it is reported COVERED, so the queue stops riding it
    expect(out.covered).toEqual(['s1'])
  })

  it('leaves the frame untouched when nothing is pending', () => {
    const input = frame([person])
    expect(injectSecondarySubjects(input, []).frame).toBe(input)
  })
})
