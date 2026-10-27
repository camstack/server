import { describe, expect, it } from 'vitest'
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
    expect(cls.kind === 'reject' && cls.reason).toBe('class person not in [dog]')
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
