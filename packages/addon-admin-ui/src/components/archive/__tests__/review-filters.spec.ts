/**
 * Archive Review filters: zone, face / plate and debug narrow the rows; a row
 * whose track facts did not load is KEPT and counted, never silently dropped;
 * the density points are the rows that survived.
 */
import { describe, expect, it } from 'vitest'
import type { KeyEventRow } from '../../detection-intelligence/key-events-merge'
import {
  densityPointsOf,
  factsByTrack,
  NO_REVIEW_FILTERS,
  reviewRowFilter,
  uncheckedRows,
  zonesVisited,
  type ReviewFilters,
  type TrackFacts,
} from '../review-filters'

const AT = 1_789_900_000_000

function row(trackId: string, className = 'person', debug = false): KeyEventRow {
  return {
    id: trackId,
    trackId,
    deviceId: 101,
    timestamp: AT,
    className,
    importance: 0.5,
    bestEventId: '',
    debug,
  }
}

const TRACKS: readonly TrackFacts[] = [
  { trackId: 'drive', zoneNames: ['Driveway'], classes: ['vehicle', 'plate'] },
  { trackId: 'porch', zoneNames: ['Porch', 'Driveway'], classes: ['person'], hasFace: true },
  { trackId: 'yard', zoneNames: ['Yard'], classes: ['person', 'face'] },
  { trackId: 'none', classes: ['animal'] },
]
const FACTS = factsByTrack(TRACKS)

function keep(filters: ReviewFilters, rows: readonly KeyEventRow[]): readonly string[] {
  const pass = reviewRowFilter(filters, FACTS)
  return rows.filter(pass).map((r) => r.trackId)
}

describe('zonesVisited', () => {
  it('lists every zone any track visited, once, sorted', () => {
    expect(zonesVisited(TRACKS)).toEqual(['Driveway', 'Porch', 'Yard'])
  })
  it('is empty when no track visited a zone', () => {
    expect(zonesVisited([{ trackId: 'x' }])).toEqual([])
  })
})

describe('reviewRowFilter', () => {
  const rows = [row('drive'), row('porch'), row('yard'), row('none')]

  it('passes everything with no filter', () => {
    expect(keep(NO_REVIEW_FILTERS, rows)).toEqual(['drive', 'porch', 'yard', 'none'])
  })

  it('keeps the rows whose track visited the zone', () => {
    expect(keep({ ...NO_REVIEW_FILTERS, zone: 'Driveway' }, rows)).toEqual(['drive', 'porch'])
  })

  it('face: a face flag or a face class; plate: a plate class', () => {
    expect(keep({ ...NO_REVIEW_FILTERS, identity: 'face' }, rows)).toEqual(['porch', 'yard'])
    expect(keep({ ...NO_REVIEW_FILTERS, identity: 'plate' }, rows)).toEqual(['drive'])
  })

  it('zone and identity combine', () => {
    expect(keep({ zone: 'Driveway', identity: 'face', debug: false }, rows)).toEqual(['porch'])
  })

  it('debug keeps only debug-marked rows, with or without track facts', () => {
    const marked = [row('drive', 'vehicle', true), row('porch'), row('missing', 'person', true)]
    expect(keep({ ...NO_REVIEW_FILTERS, debug: true }, marked)).toEqual(['drive', 'missing'])
  })

  it('a row whose track did not load is kept and counted, not silently dropped', () => {
    const withMissing = [...rows, row('missing')]
    const filters = { ...NO_REVIEW_FILTERS, zone: 'Driveway' }
    expect(keep(filters, withMissing)).toEqual(['drive', 'porch', 'missing'])
    expect(uncheckedRows(withMissing, filters, FACTS)).toBe(1)
    expect(uncheckedRows(withMissing, NO_REVIEW_FILTERS, FACTS)).toBe(0)
  })

  it('with 120 tracks answered for 120 rows, every row is checked', () => {
    const many: TrackFacts[] = Array.from({ length: 120 }, (_, i) => ({
      trackId: `t${String(i)}`,
      zoneNames: i % 2 === 0 ? ['Driveway'] : ['Yard'],
    }))
    const manyRows = many.map((t) => row(t.trackId))
    const filters = { ...NO_REVIEW_FILTERS, zone: 'Driveway' }
    const facts = factsByTrack(many)
    expect(manyRows.filter(reviewRowFilter(filters, facts))).toHaveLength(60)
    expect(uncheckedRows(manyRows, filters, facts)).toBe(0)
  })
})

describe('densityPointsOf', () => {
  it('draws one point per surviving row, audio as audio and the rest as objects', () => {
    expect(densityPointsOf([row('a', 'audio'), row('b', 'person')])).toEqual([
      { atMs: AT, kind: 'audio' },
      { atMs: AT, kind: 'object' },
    ])
  })
})
