import { describe, it, expect } from 'vitest'
import {
  mergeKeyEvents,
  sortKeyEvents,
  filterKeyEvents,
  groupTrackIdsByDevice,
  trackSelectionKey,
  resolveWindow,
  rowDisplayLabel,
  type KeyEventRow,
} from '../key-events-merge.js'

const row = (over: Partial<KeyEventRow> & { id: string }): KeyEventRow => ({
  trackId: over.trackId ?? `trk-${over.id}`,
  deviceId: over.deviceId ?? 1,
  timestamp: over.timestamp ?? 1000,
  className: over.className ?? 'person',
  importance: over.importance ?? 0.5,
  bestEventId: over.bestEventId ?? `ev-${over.id}`,
  ...over,
})

describe('mergeKeyEvents', () => {
  it('flattens per-camera arrays preserving order', () => {
    const a = row({ id: 'a' })
    const b = row({ id: 'b' })
    const c = row({ id: 'c' })
    expect(mergeKeyEvents([[a, b], [c]])).toEqual([a, b, c])
  })

  it('returns a new array (no mutation of inputs)', () => {
    const a = row({ id: 'a' })
    const input = [[a]]
    const out = mergeKeyEvents(input)
    expect(out).not.toBe(input[0])
    expect(out).toEqual([a])
  })

  it('handles empty', () => {
    expect(mergeKeyEvents([])).toEqual([])
    expect(mergeKeyEvents([[], []])).toEqual([])
  })
})

describe('sortKeyEvents', () => {
  it('sorts by importance desc', () => {
    const lo = row({ id: 'lo', importance: 0.1 })
    const hi = row({ id: 'hi', importance: 0.9 })
    const mid = row({ id: 'mid', importance: 0.5 })
    expect(sortKeyEvents([lo, hi, mid], 'importance').map((r) => r.id)).toEqual(['hi', 'mid', 'lo'])
  })

  it('sorts by time (timestamp) desc', () => {
    const old = row({ id: 'old', timestamp: 100 })
    const recent = row({ id: 'recent', timestamp: 900 })
    const mid = row({ id: 'mid', timestamp: 500 })
    expect(sortKeyEvents([old, recent, mid], 'time').map((r) => r.id)).toEqual([
      'recent',
      'mid',
      'old',
    ])
  })

  it('does not mutate the input array', () => {
    const rows = [row({ id: 'a', importance: 0.1 }), row({ id: 'b', importance: 0.9 })]
    const snapshot = [...rows]
    sortKeyEvents(rows, 'importance')
    expect(rows).toEqual(snapshot)
  })
})

describe('filterKeyEvents', () => {
  const p1 = row({ id: 'p1', deviceId: 1, className: 'person', importance: 0.8 })
  const v2 = row({ id: 'v2', deviceId: 2, className: 'vehicle', importance: 0.3 })
  const a1 = row({ id: 'a1', deviceId: 1, className: 'animal', importance: 0.6 })
  const rows = [p1, v2, a1]

  it('empty sets = no filter (only minImportance applies)', () => {
    const out = filterKeyEvents(rows, {
      cameras: new Set<number>(),
      classes: new Set<string>(),
      minImportance: 0,
    })
    expect(out).toEqual(rows)
    expect(out).not.toBe(rows)
  })

  it('filters by camera set', () => {
    const out = filterKeyEvents(rows, {
      cameras: new Set([1]),
      classes: new Set<string>(),
      minImportance: 0,
    })
    expect(out.map((r) => r.id)).toEqual(['p1', 'a1'])
  })

  it('filters by class set', () => {
    const out = filterKeyEvents(rows, {
      cameras: new Set<number>(),
      classes: new Set(['vehicle']),
      minImportance: 0,
    })
    expect(out.map((r) => r.id)).toEqual(['v2'])
  })

  it('drops rows below minImportance', () => {
    const out = filterKeyEvents(rows, {
      cameras: new Set<number>(),
      classes: new Set<string>(),
      minImportance: 0.5,
    })
    expect(out.map((r) => r.id)).toEqual(['p1', 'a1'])
  })

  it('combines all three filters', () => {
    const out = filterKeyEvents(rows, {
      cameras: new Set([1]),
      classes: new Set(['person']),
      minImportance: 0.7,
    })
    expect(out.map((r) => r.id)).toEqual(['p1'])
  })
})

describe('trackSelectionKey', () => {
  it('composes deviceId + trackId', () => {
    expect(trackSelectionKey(1, 't1')).toBe('1:t1')
    expect(trackSelectionKey(2, 'track-158')).toBe('2:track-158')
  })

  it('disambiguates the same trackId across devices', () => {
    expect(trackSelectionKey(1, 'track-158')).not.toBe(trackSelectionKey(2, 'track-158'))
  })
})

describe('groupTrackIdsByDevice', () => {
  it('groups only selected rows by device, de-duped, matching composite keys', () => {
    const rows = [
      row({ id: 'a', deviceId: 1, trackId: 't1' }),
      row({ id: 'b', deviceId: 1, trackId: 't1' }), // dup trackId same device
      row({ id: 'c', deviceId: 1, trackId: 't2' }),
      row({ id: 'd', deviceId: 2, trackId: 't3' }),
      row({ id: 'e', deviceId: 2, trackId: 't4' }), // not selected
    ]
    const selected = new Set(['1:t1', '1:t2', '2:t3'])
    const grouped = groupTrackIdsByDevice(rows, selected)
    expect(grouped.get(1)).toEqual(['t1', 't2'])
    expect(grouped.get(2)).toEqual(['t3'])
    expect(grouped.has(2)).toBe(true)
    // t4 not selected → not present
    expect([...grouped.values()].flat()).not.toContain('t4')
  })

  it('does NOT select the wrong device when the same trackId exists on two cameras', () => {
    const rows = [
      row({ id: 'a', deviceId: 1, trackId: 'track-158' }),
      row({ id: 'b', deviceId: 2, trackId: 'track-158' }),
    ]
    // Only camera 2's track-158 is selected.
    const grouped = groupTrackIdsByDevice(rows, new Set(['2:track-158']))
    expect(grouped.has(1)).toBe(false)
    expect(grouped.get(2)).toEqual(['track-158'])
  })

  it('returns an empty map when nothing selected', () => {
    const rows = [row({ id: 'a', deviceId: 1, trackId: 't1' })]
    expect(groupTrackIdsByDevice(rows, new Set()).size).toBe(0)
  })
})

describe('rowDisplayLabel', () => {
  it('prefers subLabel, then label', () => {
    expect(rowDisplayLabel({ subLabel: 'plate', label: 'Car' })).toBe('plate')
    expect(rowDisplayLabel({ label: 'Car' })).toBe('Car')
  })

  it('falls back to the first audioLabels entry when tiers are absent', () => {
    expect(
      rowDisplayLabel({
        audioLabels: [{ label: 'speech' }, { label: 'dog' }],
      }),
    ).toBe('speech')
  })

  it('returns undefined when nothing is known', () => {
    expect(rowDisplayLabel({})).toBeUndefined()
    expect(rowDisplayLabel({ audioLabels: [] })).toBeUndefined()
  })
})

describe('resolveWindow', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('resolves both nulls to [now-30d, now]', () => {
    const now = 1_700_000_000_000
    expect(resolveWindow({ fromMs: null, toMs: null }, now)).toEqual({
      since: now - 30 * DAY,
      until: now,
    })
  })

  it('passes through concrete fromMs/toMs', () => {
    const now = 1_700_000_000_000
    expect(resolveWindow({ fromMs: 111, toMs: 222 }, now)).toEqual({
      since: 111,
      until: 222,
    })
  })

  it('resolves only-fromMs-null and only-toMs-null', () => {
    const now = 1_700_000_000_000
    expect(resolveWindow({ fromMs: null, toMs: 500 }, now)).toEqual({
      since: now - 30 * DAY,
      until: 500,
    })
    expect(resolveWindow({ fromMs: 500, toMs: null }, now)).toEqual({
      since: 500,
      until: now,
    })
  })
})
