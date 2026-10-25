/**
 * Corpus page slices, KPI %, and filter AND — pure query helpers (Task 2).
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateCorpusKpi,
  corpusPctOfCorpus,
  filterCorpusRows,
  paginateCorpusRows,
  workStateOf,
  type CorpusFrameRow,
} from '../retrain-corpus-query.js'

function row(
  partial: Omit<CorpusFrameRow, 'copiedAt' | 'collectionIds' | 'classes'> &
    Partial<Pick<CorpusFrameRow, 'copiedAt' | 'collectionIds' | 'classes'>>,
): CorpusFrameRow {
  return {
    copiedAt: partial.copiedAt ?? 0,
    collectionIds: partial.collectionIds ?? [],
    classes: partial.classes ?? [],
    frameId: partial.frameId,
    deviceId: partial.deviceId,
    complete: partial.complete,
    annotationCount: partial.annotationCount,
  }
}

const CORPUS: readonly CorpusFrameRow[] = [
  row({ frameId: 'a', deviceId: 101, complete: false, annotationCount: 0, copiedAt: 10 }),
  row({
    frameId: 'b',
    deviceId: 101,
    complete: false,
    annotationCount: 2,
    copiedAt: 20,
    classes: ['person'],
    collectionIds: ['col-1'],
  }),
  row({
    frameId: 'c',
    deviceId: 101,
    complete: true,
    annotationCount: 1,
    copiedAt: 30,
    classes: ['vehicle'],
    collectionIds: ['col-1', 'col-2'],
  }),
  row({
    frameId: 'd',
    deviceId: 102,
    complete: true,
    annotationCount: 0,
    copiedAt: 40,
    collectionIds: ['col-2'],
  }),
  row({
    frameId: 'e',
    deviceId: 102,
    complete: true,
    annotationCount: 3,
    copiedAt: 50,
    classes: ['person', 'package'],
  }),
]

describe('filterCorpusRows', () => {
  it('ANDs workState, deviceIds, collectionId and classes', () => {
    const kept = filterCorpusRows(CORPUS, {
      workState: 'annotated',
      deviceIds: [101],
      collectionId: 'col-1',
      classes: ['person'],
      page: 1,
      pageSize: 50,
    })
    expect(kept.map((r) => r.frameId)).toEqual(['b'])
  })

  it('treats complete+zero annotations as unannotated, never complete', () => {
    const kept = filterCorpusRows(CORPUS, {
      workState: 'complete',
      page: 1,
      pageSize: 50,
    })
    expect(kept.map((r) => r.frameId).toSorted()).toEqual(['c', 'e'])
  })

  it('omitted fields impose no constraint', () => {
    expect(filterCorpusRows(CORPUS, { page: 1, pageSize: 50 })).toHaveLength(5)
  })
})

describe('paginateCorpusRows', () => {
  it('returns a 1-based page slice and total', () => {
    const ordered = [...CORPUS].toSorted((a, b) => b.copiedAt - a.copiedAt)
    const page = paginateCorpusRows(ordered, 2, 2)
    expect(page.total).toBe(5)
    expect(page.page).toBe(2)
    expect(page.pageSize).toBe(2)
    expect(page.rows.map((r) => r.frameId)).toEqual(['c', 'b'])
  })

  it('answers an empty page when the filter matches nothing (D315 answered empty)', () => {
    const none = filterCorpusRows(CORPUS, {
      workState: 'annotated',
      deviceIds: [999],
      page: 1,
      pageSize: 50,
    })
    const page = paginateCorpusRows(none, 1, 50)
    expect(page).toEqual({ rows: [], total: 0, page: 1, pageSize: 50 })
  })
})

describe('aggregateCorpusKpi', () => {
  it('partitions via workStateOf and sets pctOfCorpus = complete(cam) / totalCorpus', () => {
    const kpi = aggregateCorpusKpi(CORPUS)
    expect(kpi.total).toBe(5)
    expect(kpi.unannotated).toBe(2) // a, d
    expect(kpi.annotated).toBe(1) // b
    expect(kpi.complete).toBe(2) // c, e
    const byDevice = new Map(kpi.cameras.map((c) => [c.deviceId, c]))
    expect(byDevice.get(101)).toEqual({
      deviceId: 101,
      unannotated: 1,
      annotated: 1,
      complete: 1,
      pctOfCorpus: 1 / 5,
    })
    expect(byDevice.get(102)).toEqual({
      deviceId: 102,
      unannotated: 1,
      annotated: 0,
      complete: 1,
      pctOfCorpus: 1 / 5,
    })
  })

  it('answers zeros and no cameras for an empty corpus', () => {
    expect(aggregateCorpusKpi([])).toEqual({
      total: 0,
      unannotated: 0,
      annotated: 0,
      complete: 0,
      cameras: [],
    })
  })
})

describe('corpusPctOfCorpus', () => {
  it('is null when totalCorpus is 0, else complete/total', () => {
    expect(corpusPctOfCorpus(0, 0)).toBeNull()
    expect(corpusPctOfCorpus(1, 0)).toBeNull()
    expect(corpusPctOfCorpus(1, 4)).toBe(0.25)
  })
})

describe('list page workState attachment (via workStateOf on index rows)', () => {
  it('labels each page row so All can distinguish the three states', () => {
    const page = paginateCorpusRows(sortNewest(CORPUS), 1, 50)
    const states = page.rows.map((r) => ({
      frameId: r.frameId,
      workState: workStateOf(r, r.annotationCount),
    }))
    expect(states).toEqual([
      { frameId: 'e', workState: 'complete' },
      { frameId: 'd', workState: 'unannotated' },
      { frameId: 'c', workState: 'complete' },
      { frameId: 'b', workState: 'annotated' },
      { frameId: 'a', workState: 'unannotated' },
    ])
  })
})

function sortNewest(rows: readonly CorpusFrameRow[]): readonly CorpusFrameRow[] {
  return [...rows].toSorted((a, b) => b.copiedAt - a.copiedAt)
}
