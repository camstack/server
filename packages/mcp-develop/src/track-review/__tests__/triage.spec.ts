import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRIAGE_OPTIONS,
  detectSignals,
  extractFeatures,
  sample,
  scoreTrack,
  triageTracks,
} from '../triage.js'
import { track } from './fixtures.js'

const O = DEFAULT_TRIAGE_OPTIONS
const LIMITS = { maxSuspects: 10, controlSize: 3 }

describe('triage signals', () => {
  it('flags a label that belongs to another macro class', () => {
    const f = extractFeatures(track({ trackId: 'a', className: 'person', label: 'car' }))
    expect(detectSignals(f, O)).toContain('class-label-mismatch')
  })

  it('does not flag a label that agrees with the class', () => {
    const f = extractFeatures(track({ trackId: 'a', className: 'vehicle', label: 'car' }))
    expect(detectSignals(f, O)).not.toContain('class-label-mismatch')
  })

  it('flags confusable labels, weak scores, and very short tracks', () => {
    const t = track({
      trackId: 'a',
      className: 'animal',
      label: 'cat',
      labelScore: 0.4,
      firstSeen: 0,
      lastSeen: 100,
    })
    const s = scoreTrack(t, O)
    expect(s.signals).toEqual(
      expect.arrayContaining(['suspect-label', 'low-label-score', 'very-short']),
    )
    expect(s.score).toBe(2 + 2 + 1)
  })

  it('flags a person that never moves, but not a moving one', () => {
    const still = extractFeatures(track({ trackId: 'a', totalDistance: 0 }))
    const moving = extractFeatures(track({ trackId: 'b', totalDistance: 2 }))
    expect(detectSignals(still, O)).toContain('static-subject')
    expect(detectSignals(moving, O)).not.toContain('static-subject')
  })

  it('treats unknown observation count as unknown, not as few', () => {
    const f = extractFeatures(track({ trackId: 'a' }))
    expect(f.observations).toBeNull()
    expect(detectSignals(f, O)).not.toContain('few-observations')
  })

  it('measures the envelope area', () => {
    const f = extractFeatures(
      track({
        trackId: 'a',
        envelope: { minX: 0, minY: 0, maxX: 0.01, maxY: 0.1 },
      }),
    )
    expect(f.envelopeArea).toBeCloseTo(0.001)
    expect(detectSignals(f, O)).toContain('tiny-subject')
  })
})

describe('triageTracks', () => {
  const suspect = (id: string) =>
    track({
      trackId: id,
      className: 'animal',
      label: 'cat',
      labelScore: 0.3,
      firstSeen: 0,
      lastSeen: 50,
    })
  const clean = (id: string) =>
    track({
      trackId: id,
      className: 'vehicle',
      label: 'car',
      labelScore: 0.95,
    })

  it('ranks suspects by score then recency and caps them', () => {
    const weaker = track({
      trackId: 'w',
      className: 'animal',
      label: 'cat',
      labelScore: 0.9,
    })
    const r = triageTracks(
      [weaker, suspect('s1'), clean('c1')],
      { ...O, minScore: 2 },
      { maxSuspects: 1, controlSize: 5 },
      () => 0,
    )
    expect(r.suspectCount).toBe(2)
    expect(r.suspects.map((s) => s.features.trackId)).toEqual(['s1'])
  })

  it('draws the control sample only from non-suspects, without duplicates', () => {
    const tracks = [suspect('s'), ...['a', 'b', 'c', 'd', 'e'].map(clean)]
    const r = triageTracks(tracks, O, LIMITS, () => 0.5)
    expect(r.control).toHaveLength(3)
    const ids = r.control.map((c) => c.features.trackId)
    expect(new Set(ids).size).toBe(3)
    expect(ids).not.toContain('s')
  })

  it('ignores duplicates and synthetic sensor tracks', () => {
    const r = triageTracks(
      [clean('a'), clean('a'), { ...clean('b'), source: 'sensor' }],
      O,
      LIMITS,
      () => 0,
    )
    expect(r.examined).toBe(1)
  })

  it('is deterministic for a fixed random source', () => {
    const items = [1, 2, 3, 4, 5, 6]
    expect(sample(items, 3, () => 0.25)).toEqual(sample(items, 3, () => 0.25))
    expect(sample(items, 99, () => 0)).toHaveLength(6)
  })
})

describe('triage training membership and camera names', () => {
  // class/label mismatch (3) alone reaches the default suspect bar.
  const mk = (id: string, deviceId = 1) =>
    track({ trackId: id, deviceId, className: 'person', label: 'car' })
  const training = {
    byTrack: new Map([['curated', ['review-a']]]),
    truncated: false,
    framesRead: 1,
  }

  it('skips suspects already in the corpus, counts them, and names the camera', () => {
    const r = triageTracks([mk('curated'), mk('fresh', 2)], O, LIMITS, () => 0.5, {
      cameraNames: { 1: 'Garage', 2: 'Porch' },
      training,
      excludeInTraining: true,
    })
    expect(r.suspects.map((s) => s.features.trackId)).toEqual(['fresh'])
    expect(r.skippedInTraining).toBe(1)
    expect(r.suspects[0]!.cameraName).toBe('Porch')
    expect(r.suspects[0]!.inTraining).toBeNull()
  })

  it('keeps them, marked, when excludeInTraining is false', () => {
    const r = triageTracks([mk('curated')], O, LIMITS, () => 0.5, {
      cameraNames: {},
      training,
      excludeInTraining: false,
    })
    expect(r.suspects[0]!.inTraining).toEqual({ collections: ['review-a'] })
    expect(r.skippedInTraining).toBe(0)
  })

  it('says few-observations is not evaluated when no row carries positions', () => {
    const r = triageTracks([mk('a')], O, LIMITS, () => 0.5)
    expect(r.signalsNotEvaluated).toEqual(['few-observations'])
  })
})
