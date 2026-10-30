import { describe, expect, it } from 'vitest'
import type { DetectionSubject } from '../detection-subject.js'
import {
  DetectionTriggerFilter,
  detectionClassMatches,
  FIRED_MAX,
  FIRED_TTL_MS,
  type DetectionTrigger,
} from '../detection-trigger.js'

const event = (over: Record<string, unknown> = {}) => ({
  deviceId: 7,
  trackId: 't1',
  phase: 'start',
  bestClassName: 'dog',
  bestConfidence: 0.8,
  zonesVisited: ['yard'],
  ...over,
})

describe('class matching goes through the shared macro mapping', () => {
  it('a macro class matches every raw class that maps to it, a raw class only itself', () => {
    expect(detectionClassMatches('animal', 'dog')).toBe(true)
    expect(detectionClassMatches('vehicle', 'truck')).toBe(true)
    expect(detectionClassMatches('dog', 'dog')).toBe(true)
    expect(detectionClassMatches('dog', 'cat')).toBe(false)
    expect(detectionClassMatches('person', 'dog')).toBe(false)
  })
})

describe('DetectionTriggerFilter', () => {
  const trigger: DetectionTrigger = { kind: 'detection', classes: ['animal'], deviceIds: [7] }

  it('fires once per (device, track) across start + update + update', () => {
    const f = new DetectionTriggerFilter(trigger)
    expect(f.evaluate(event(), 0).kind).toBe('fire')
    const again = f.evaluate(event({ phase: 'update' }), 1)
    expect(again.kind).toBe('reject')
    expect(again.kind === 'reject' && again.reason).toBe('already fired for track t1')
    expect(f.evaluate(event({ phase: 'update' }), 2).kind).toBe('reject')
  })

  it('exposes deviceId, className, trackId and score', () => {
    const d = new DetectionTriggerFilter(trigger).evaluate(event(), 0)
    expect(d.kind === 'fire' && d.vars).toEqual({
      deviceId: 7,
      className: 'dog',
      trackId: 't1',
      score: 0.8,
      label: '',
    })
  })

  it('ignores another device without tracing it', () => {
    expect(new DetectionTriggerFilter(trigger).evaluate(event({ deviceId: 9 }), 0).kind).toBe(
      'ignore',
    )
  })

  it('rejects with a reason: class, score, zone', () => {
    const cls = new DetectionTriggerFilter({ ...trigger, classes: ['dog'] }).evaluate(
      event({ bestClassName: 'person' }),
      0,
    )
    expect(cls.kind === 'reject' && cls.reason).toBe('class person is not a animal')
    const score = new DetectionTriggerFilter({ ...trigger, minScore: 0.6 }).evaluate(
      event({ bestConfidence: 0.41 }),
      0,
    )
    expect(score.kind === 'reject' && score.reason).toBe('score 0.41 < 0.6')
    const zone = new DetectionTriggerFilter({ ...trigger, zones: ['gate'] }).evaluate(event(), 0)
    expect(zone.kind === 'reject' && zone.reason).toContain('zone mismatch')
  })

  it('a rejected track fires later, once its score rises', () => {
    const f = new DetectionTriggerFilter({ ...trigger, minScore: 0.6 })
    expect(f.evaluate(event({ bestConfidence: 0.4 }), 0).kind).toBe('reject')
    expect(f.evaluate(event({ phase: 'update', bestConfidence: 0.7 }), 1).kind).toBe('fire')
  })

  it('forgets a track on end, so a reused id can fire again', () => {
    const f = new DetectionTriggerFilter(trigger)
    f.evaluate(event(), 0)
    expect(f.evaluate(event({ phase: 'end' }), 1).kind).toBe('ignore')
    expect(f.firedCount).toBe(0)
    expect(f.evaluate(event(), 2).kind).toBe('fire')
  })

  it('forgets a track whose end was dropped after the TTL, and stays bounded', () => {
    const f = new DetectionTriggerFilter(trigger)
    f.evaluate(event(), 0)
    expect(f.evaluate(event({ phase: 'update' }), FIRED_TTL_MS - 1).kind).toBe('reject')
    expect(f.evaluate(event({ phase: 'update' }), FIRED_TTL_MS + 1).kind).toBe('fire')
    const big = new DetectionTriggerFilter(trigger)
    for (let i = 0; i < FIRED_MAX + 50; i += 1) big.evaluate(event({ trackId: `x${i}` }), i)
    expect(big.firedCount).toBe(FIRED_MAX)
  })
})

describe('a detection leaf is one macro class plus an optional label', () => {
  const leaf = (subject: DetectionSubject): DetectionTrigger => ({
    kind: 'detection',
    deviceIds: [7],
    subjects: [subject],
  })

  it('a stored raw class converts to its macro plus a sub-class label', async () => {
    const { subjectFromClassName } = await import('../detection-subject.js')
    expect(subjectFromClassName('dog')).toEqual({
      macro: 'animal',
      label: { kind: 'sub-class', className: 'dog' },
    })
    expect(subjectFromClassName('animal')).toEqual({ macro: 'animal' })
    expect(subjectFromClassName('forklift')).toEqual({ macro: 'other', className: 'forklift' })
  })

  it('no label means any subject of the macro class, and the label var is empty', () => {
    const f = new DetectionTriggerFilter(leaf({ macro: 'animal' }))
    const d = f.evaluate(event({ bestClassName: 'cat' }), 0)
    expect(d.kind).toBe('fire')
    expect(d.kind === 'fire' && d.vars.label).toBe('')
  })

  it('a sub-class label rejects another animal and fires on the matching one, with the label in the vars', () => {
    const f = new DetectionTriggerFilter(
      leaf({ macro: 'animal', label: { kind: 'sub-class', className: 'dog' } }),
    )
    expect(f.evaluate(event({ bestClassName: 'cat' }), 0).kind).toBe('reject')
    const d = new DetectionTriggerFilter(
      leaf({ macro: 'animal', label: { kind: 'sub-class', className: 'dog' } }),
    ).evaluate(event(), 0)
    expect(d.kind === 'fire' && d.vars.label).toBe('dog')
  })

  it('a face label fires when the identity LANDS on a later update, not at the first detection', () => {
    const f = new DetectionTriggerFilter(
      leaf({ macro: 'person', label: { kind: 'identity', identityId: 'i1', name: 'Ann' } }),
    )
    const first = f.evaluate(event({ bestClassName: 'person' }), 0)
    expect(first.kind).toBe('reject')
    expect(first.kind === 'reject' && first.reason).toContain('not recognised yet')
    const landed = f.evaluate(
      event({ bestClassName: 'person', phase: 'update', label: 'Ann', identityId: 'i1' }),
      1,
    )
    expect(landed.kind).toBe('fire')
    expect(landed.kind === 'fire' && landed.vars.label).toBe('Ann')
    expect(
      f.evaluate(event({ bestClassName: 'person', phase: 'update', label: 'Ann' }), 2).kind,
    ).toBe('reject')
  })

  it('a plate label fires when the plate text is read, ignoring case and separators', () => {
    const f = new DetectionTriggerFilter(
      leaf({ macro: 'vehicle', label: { kind: 'plate', text: 'AB 123 CD' } }),
    )
    expect(f.evaluate(event({ bestClassName: 'car' }), 0).kind).toBe('reject')
    const d = f.evaluate(
      event({ bestClassName: 'car', phase: 'update', plateText: 'ab-123-cd' }),
      1,
    )
    expect(d.kind).toBe('fire')
    expect(d.kind === 'fire' && d.vars.label).toBe('AB 123 CD')
  })
})
