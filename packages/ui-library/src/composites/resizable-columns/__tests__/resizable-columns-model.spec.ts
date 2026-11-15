import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_COLUMN_PCT,
  normalizeSplit,
  readStoredSplit,
  resizeSplit,
  writeStoredSplit,
} from '../resizable-columns-model'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('normalizeSplit', () => {
  it('scales to 100 and keeps the proportions', () => {
    expect(normalizeSplit([65, 20])).toEqual([(65 / 85) * 100, (20 / 85) * 100])
    expect(normalizeSplit([15, 65, 20])).toEqual([15, 65, 20])
  })
  it('falls back to equal shares for nothing usable', () => {
    expect(normalizeSplit([0, 0])).toEqual([50, 50])
  })
})

describe('resizeSplit', () => {
  it('moves one boundary and leaves the other columns alone', () => {
    expect(resizeSplit([15, 65, 20], 0, 5)).toEqual([20, 60, 20])
    expect(resizeSplit([15, 65, 20], 1, -10)).toEqual([15, 55, 30])
  })
  it('never takes a column under the minimum, and keeps the total', () => {
    const left = resizeSplit([15, 65, 20], 0, -50)
    expect(left[0]).toBe(MIN_COLUMN_PCT)
    const right = resizeSplit([15, 65, 20], 1, 100)
    expect(right[2]).toBe(MIN_COLUMN_PCT)
    expect(right.reduce((a, b) => a + b, 0)).toBeCloseTo(100)
  })
  it('ignores a boundary that does not exist', () => {
    expect(resizeSplit([50, 50], 1, 5)).toEqual([50, 50])
  })
})

describe('split persistence', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(readStoredSplit('k', [15, 65, 20])).toEqual([15, 65, 20])
  })
  it('round-trips what was written, per key and per column count', () => {
    writeStoredSplit('k', [20, 60, 20])
    expect(readStoredSplit('k', [15, 65, 20])).toEqual([20, 60, 20])
    expect(readStoredSplit('other', [15, 65, 20])).toEqual([15, 65, 20])
    expect(readStoredSplit('k', [65, 20])).toEqual(normalizeSplit([65, 20]))
  })
  it('ignores a stored value that is not a usable split', () => {
    for (const bad of ['not json', '[1,2]', '[50,50,0]', '{"a":1}', '[10,10,10]']) {
      window.localStorage.setItem('camstack.columns.k.3', bad)
      expect(readStoredSplit('k', [15, 65, 20])).toEqual([15, 65, 20])
    }
  })
  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readStoredSplit('k', [15, 65, 20])).toEqual([15, 65, 20])
    expect(() => writeStoredSplit('k', [20, 60, 20])).not.toThrow()
  })
})
