import { describe, it, expect } from 'vitest'
import { TrackBestSelector } from '../track-best-detection.js'

const bbox = { x: 0, y: 0, w: 10, h: 10 }

describe('TrackBestSelector', () => {
  it('accepts the first sighting as the best and holds its full payload', () => {
    const sel = new TrackBestSelector()
    const isNew = sel.observe({
      trackId: 't1',
      confidence: 0.6,
      atMs: 100,
      className: 'person',
      bbox,
      embedding: [1, 2, 3],
      embeddingModelId: 'mobileclip-s0',
      faceBbox: { x: 1, y: 1, w: 4, h: 4 },
    })
    expect(isNew).toBe(true)
    const peak = sel.peak('t1')
    expect(peak).toMatchObject({
      confidence: 0.6,
      atMs: 100,
      className: 'person',
      embedding: [1, 2, 3],
      embeddingModelId: 'mobileclip-s0',
      faceBbox: { x: 1, y: 1, w: 4, h: 4 },
    })
    expect(Object.hasOwn(peak ?? {}, 'trackId')).toBe(false) // payload excludes the trackId key
  })

  it('advances the held payload only on a strictly higher confidence', () => {
    const sel = new TrackBestSelector()
    sel.observe({ trackId: 't1', confidence: 0.6, atMs: 100, className: 'person', bbox })
    expect(
      sel.observe({ trackId: 't1', confidence: 0.5, atMs: 200, className: 'person', bbox }),
    ).toBe(false)
    expect(sel.peak('t1')?.confidence).toBe(0.6)
    expect(sel.peak('t1')?.atMs).toBe(100)

    const better = sel.observe({
      trackId: 't1',
      confidence: 0.9,
      atMs: 300,
      className: 'person',
      bbox,
      embedding: [9],
    })
    expect(better).toBe(true)
    expect(sel.peak('t1')?.confidence).toBe(0.9)
    expect(sel.peak('t1')?.embedding).toEqual([9])
  })

  it('honours hysteresis — a marginal gain does not churn the best', () => {
    const sel = new TrackBestSelector({ hysteresis: 0.05 })
    sel.observe({ trackId: 't1', confidence: 0.8, atMs: 100, className: 'car', bbox })
    // +0.03 ≤ hysteresis → not a new best.
    expect(
      sel.observe({ trackId: 't1', confidence: 0.83, atMs: 200, className: 'car', bbox }),
    ).toBe(false)
    // +0.1 > hysteresis → new best.
    expect(sel.observe({ trackId: 't1', confidence: 0.9, atMs: 300, className: 'car', bbox })).toBe(
      true,
    )
  })

  it('honours minGapMs — rate-limits accepted bests within the window', () => {
    const sel = new TrackBestSelector({ minGapMs: 2000 })
    sel.observe({ trackId: 't1', confidence: 0.6, atMs: 1000, className: 'person', bbox })
    // Higher confidence but inside the gap → rejected.
    expect(
      sel.observe({ trackId: 't1', confidence: 0.9, atMs: 1500, className: 'person', bbox }),
    ).toBe(false)
    // Higher confidence, gap respected → accepted.
    expect(
      sel.observe({ trackId: 't1', confidence: 0.95, atMs: 3200, className: 'person', bbox }),
    ).toBe(true)
  })

  it('tracks are independent and peakConfidence reflects the held peak', () => {
    const sel = new TrackBestSelector()
    sel.observe({ trackId: 'a', confidence: 0.4, atMs: 1, className: 'person', bbox })
    sel.observe({ trackId: 'b', confidence: 0.7, atMs: 1, className: 'car', bbox })
    expect(sel.peakConfidence('a')).toBe(0.4)
    expect(sel.peakConfidence('b')).toBe(0.7)
    expect(sel.peakConfidence('missing')).toBeUndefined()
  })

  it('delete drops a track; clear drops all', () => {
    const sel = new TrackBestSelector()
    sel.observe({ trackId: 'a', confidence: 0.4, atMs: 1, className: 'person', bbox })
    sel.observe({ trackId: 'b', confidence: 0.7, atMs: 1, className: 'car', bbox })
    sel.delete('a')
    expect(sel.peak('a')).toBeUndefined()
    expect(sel.peak('b')).toBeDefined()
    // After delete, the same track's next sighting is a fresh first-best.
    expect(sel.observe({ trackId: 'a', confidence: 0.1, atMs: 2, className: 'person', bbox })).toBe(
      true,
    )
    sel.clear()
    expect(sel.peak('a')).toBeUndefined()
    expect(sel.peak('b')).toBeUndefined()
  })
})
