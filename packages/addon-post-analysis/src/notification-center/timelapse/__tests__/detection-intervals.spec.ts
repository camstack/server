/**
 * What the timelapse's dense plan is allowed to call "something happened here".
 *
 * The persisted track store is NOT that answer. Three deliberate gates destroy
 * a track before it is ever written — the confirmation gate ("birth suppressed
 * — track record retracted"), stationary promotion (a parked car is not a
 * highlight) and zero-media suppression — and all three are correct for the
 * NOTIFICATIONS surface. None is correct for "slow the video down here".
 *
 * The object-event rows survive every one of them, which is why they are the
 * second half of the input. These cases pin the merge that folds the two into
 * one array — the array the ranges AND the counts are both derived from.
 */
import { describe, expect, it } from 'vitest'
import { mergeDetectionIntervals, TRACKLESS_EVENT_GAP_MS } from '../detection-intervals.js'

const T0 = Date.UTC(2026, 7, 13, 19)

describe('mergeDetectionIntervals', () => {
  it('keeps a persisted track as it is', () => {
    const merged = mergeDetectionIntervals({
      tracks: [{ trackId: 'a', firstSeen: T0 + 1000, lastSeen: T0 + 9000, className: 'person' }],
      events: [],
    })
    expect(merged).toEqual([
      { trackId: 'a', firstSeen: T0 + 1000, lastSeen: T0 + 9000, className: 'person' },
    ])
  })

  /**
   * The operator's case, verbatim: device 101 at 23:31 CEST on 2026-08-13.
   * Two `person` object events survived — `entered` at 23:31:26 and `left` at
   * 23:31:29 — while the track behind them (`0e6a91ad…`) was retracted by the
   * confirmation gate before it could be persisted. The night's dense plan was
   * therefore built from an empty array and the video never slowed down.
   */
  it('reconstructs an interval for a track the store never persisted', () => {
    const merged = mergeDetectionIntervals({
      tracks: [],
      events: [
        { trackId: '0e6a91ad', timestamp: T0 + 1_886_000, className: 'person' },
        { trackId: '0e6a91ad', timestamp: T0 + 1_889_000, className: 'person' },
      ],
    })
    expect(merged).toEqual([
      {
        trackId: '0e6a91ad',
        firstSeen: T0 + 1_886_000,
        lastSeen: T0 + 1_889_000,
        className: 'person',
      },
    ])
  })

  it('never counts a persisted track twice through its own events', () => {
    const merged = mergeDetectionIntervals({
      tracks: [{ trackId: 'a', firstSeen: T0 + 1000, lastSeen: T0 + 9000, className: 'person' }],
      events: [
        { trackId: 'a', timestamp: T0 + 1000, className: 'person' },
        { trackId: 'a', timestamp: T0 + 5000, className: 'person' },
        { trackId: 'a', timestamp: T0 + 9000, className: 'person' },
      ],
    })
    expect(merged).toHaveLength(1)
    expect(merged[0]?.firstSeen).toBe(T0 + 1000)
  })

  it('prefers the persisted interval over the events, even when they disagree', () => {
    // The store knows when the track really started; the events only know when
    // the emitter chose to write one. Widening a persisted interval from event
    // timestamps would move a range boundary for no gain.
    const merged = mergeDetectionIntervals({
      tracks: [{ trackId: 'a', firstSeen: T0, lastSeen: T0 + 20_000, className: 'vehicle' }],
      events: [{ trackId: 'a', timestamp: T0 + 60_000, className: 'vehicle' }],
    })
    expect(merged).toEqual([
      { trackId: 'a', firstSeen: T0, lastSeen: T0 + 20_000, className: 'vehicle' },
    ])
  })

  it('folds every event of one unpersisted track into one interval', () => {
    const merged = mergeDetectionIntervals({
      tracks: [],
      events: [
        { trackId: 'z', timestamp: T0 + 30_000, className: 'vehicle' },
        { trackId: 'z', timestamp: T0 + 1000, className: 'vehicle' },
        { trackId: 'z', timestamp: T0 + 290_000, className: 'vehicle' },
      ],
    })
    expect(merged).toEqual([
      { trackId: 'z', firstSeen: T0 + 1000, lastSeen: T0 + 290_000, className: 'vehicle' },
    ])
  })

  it('resolves a class that changed mid-track to the one most rows agree on', () => {
    const merged = mergeDetectionIntervals({
      tracks: [],
      events: [
        { trackId: 'z', timestamp: T0 + 1000, className: 'animal' },
        { trackId: 'z', timestamp: T0 + 2000, className: 'person' },
        { trackId: 'z', timestamp: T0 + 3000, className: 'person' },
      ],
    })
    expect(merged[0]?.className).toBe('person')
  })

  it('breaks a tie on class by which one appeared first', () => {
    const merged = mergeDetectionIntervals({
      tracks: [],
      events: [
        { trackId: 'z', timestamp: T0 + 1000, className: 'animal' },
        { trackId: 'z', timestamp: T0 + 2000, className: 'person' },
      ],
    })
    expect(merged[0]?.className).toBe('animal')
  })

  it('sorts the result by when each detection started', () => {
    const merged = mergeDetectionIntervals({
      tracks: [{ trackId: 'later', firstSeen: T0 + 90_000, lastSeen: T0 + 95_000 }],
      events: [{ trackId: 'earlier', timestamp: T0 + 1000, className: 'person' }],
    })
    expect(merged.map((m) => m.trackId)).toEqual(['earlier', 'later'])
  })

  describe('events with no trackId', () => {
    it('joins two same-class rows inside the gap into one subject', () => {
      const merged = mergeDetectionIntervals({
        tracks: [],
        events: [
          { timestamp: T0 + 1000, className: 'person' },
          { timestamp: T0 + 1000 + TRACKLESS_EVENT_GAP_MS - 1, className: 'person' },
        ],
      })
      expect(merged).toHaveLength(1)
      expect(merged[0]).toMatchObject({
        firstSeen: T0 + 1000,
        lastSeen: T0 + 1000 + TRACKLESS_EVENT_GAP_MS - 1,
        className: 'person',
      })
    })

    it('splits two same-class rows beyond the gap into two subjects', () => {
      const merged = mergeDetectionIntervals({
        tracks: [],
        events: [
          { timestamp: T0 + 1000, className: 'person' },
          { timestamp: T0 + 1000 + TRACKLESS_EVENT_GAP_MS + 1, className: 'person' },
        ],
      })
      expect(merged).toHaveLength(2)
    })

    it('never merges across classes', () => {
      const merged = mergeDetectionIntervals({
        tracks: [],
        events: [
          { timestamp: T0 + 1000, className: 'person' },
          { timestamp: T0 + 2000, className: 'vehicle' },
        ],
      })
      expect(merged).toHaveLength(2)
    })

    it('carries no trackId out — there was none to carry', () => {
      const merged = mergeDetectionIntervals({
        tracks: [],
        events: [{ timestamp: T0 + 1000, className: 'person' }],
      })
      expect(merged[0]?.trackId).toBeUndefined()
    })
  })

  it('answers an empty array for an empty window rather than throwing', () => {
    expect(mergeDetectionIntervals({ tracks: [], events: [] })).toEqual([])
  })
})
