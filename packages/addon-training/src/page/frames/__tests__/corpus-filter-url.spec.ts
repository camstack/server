/**
 * Pure URL parse/serialize for the Frames corpus filter bar.
 *
 * Params (replaceState): workState, camera, collection, class, page.
 * pageSize lives in localStorage via usePersistedPageSize — not in the URL.
 */
import { describe, expect, it } from 'vitest'
import {
  applyCorpusFilterToSearchParams,
  corpusFilterFromSearchParams,
  type CorpusUrlFilter,
} from '../corpus-filter-url.js'

describe('corpusFilterFromSearchParams', () => {
  it('defaults to All work state, no cameras/collection/classes, page 1', () => {
    expect(corpusFilterFromSearchParams(new URLSearchParams())).toEqual({
      workState: undefined,
      deviceIds: [],
      collectionId: undefined,
      classes: [],
      page: 1,
    } satisfies CorpusUrlFilter)
  })

  it('parses workState, multi camera, single collection, multi class, page', () => {
    const params = new URLSearchParams(
      'workState=annotated&camera=101,108&collection=col-1&class=person,vehicle&page=3',
    )
    expect(corpusFilterFromSearchParams(params)).toEqual({
      workState: 'annotated',
      deviceIds: [101, 108],
      collectionId: 'col-1',
      classes: ['person', 'vehicle'],
      page: 3,
    })
  })

  it('ignores unknown workState and non-positive page', () => {
    const params = new URLSearchParams('workState=maybe&page=0&camera=abc,101')
    expect(corpusFilterFromSearchParams(params)).toEqual({
      workState: undefined,
      deviceIds: [101],
      collectionId: undefined,
      classes: [],
      page: 1,
    })
  })

  it('ignores unknown macro classes', () => {
    const params = new URLSearchParams('class=person,dragon,face')
    expect(corpusFilterFromSearchParams(params).classes).toEqual(['person', 'face'])
  })
})

describe('applyCorpusFilterToSearchParams', () => {
  it('round-trips and omits defaults (All / empty / page 1)', () => {
    const base = new URLSearchParams('tab=frames&noise=1')
    applyCorpusFilterToSearchParams(base, {
      workState: undefined,
      deviceIds: [],
      collectionId: undefined,
      classes: [],
      page: 1,
    })
    expect(base.get('tab')).toBe('frames')
    expect(base.get('noise')).toBe('1')
    expect(base.has('workState')).toBe(false)
    expect(base.has('camera')).toBe(false)
    expect(base.has('collection')).toBe(false)
    expect(base.has('class')).toBe(false)
    expect(base.has('page')).toBe(false)
  })

  it('writes set fields and round-trips through parse', () => {
    const params = new URLSearchParams()
    const filter: CorpusUrlFilter = {
      workState: 'complete',
      deviceIds: [101, 108],
      collectionId: 'col-9',
      classes: ['animal', 'package'],
      page: 2,
    }
    applyCorpusFilterToSearchParams(params, filter)
    expect(params.toString()).toBe(
      'workState=complete&camera=101%2C108&collection=col-9&class=animal%2Cpackage&page=2',
    )
    expect(corpusFilterFromSearchParams(params)).toEqual(filter)
  })
})
