import { describe, it, expect } from 'vitest'
import type { ExportTargetEntry } from '@camstack/types/node'
import { syncStateFromJson, syncStateToJson } from '../reconcile/sync-state.js'

describe('hap sync-state serialization', () => {
  it('round-trips a populated map', () => {
    const map = new Map<number, ExportTargetEntry>([
      [7, { fingerprint: 'aaa', externalIds: ['uuid-7'] }],
      [9, { fingerprint: 'bbb', externalIds: ['uuid-9'] }],
    ])
    const json = syncStateToJson(map)
    expect(json).toEqual({
      '7': { fingerprint: 'aaa', externalIds: ['uuid-7'] },
      '9': { fingerprint: 'bbb', externalIds: ['uuid-9'] },
    })
    const back = syncStateFromJson(json)
    expect(back.get(7)).toEqual({ fingerprint: 'aaa', externalIds: ['uuid-7'] })
    expect(back.size).toBe(2)
  })

  it('returns empty for empty input', () => {
    expect(syncStateFromJson({}).size).toBe(0)
    expect(syncStateToJson(new Map())).toEqual({})
  })

  it('skips non-numeric keys defensively', () => {
    const back = syncStateFromJson({
      '5': { fingerprint: 'x', externalIds: [] },
      bad: { fingerprint: 'y', externalIds: [] },
    })
    expect(back.size).toBe(1)
    expect(back.get(5)).toEqual({ fingerprint: 'x', externalIds: [] })
  })

  it('does not alias arrays between map and json (toJson)', () => {
    const ids = ['1']
    const map = new Map<number, ExportTargetEntry>([[1, { fingerprint: 'f', externalIds: ids }]])
    expect(syncStateToJson(map)['1']!.externalIds).not.toBe(ids)
  })

  it('does not alias arrays between json and map (fromJson)', () => {
    const ids = ['uuid-42']
    const json = { '42': { fingerprint: 'fp', externalIds: ids } }
    const map = syncStateFromJson(json)
    const entry = map.get(42)!
    expect(entry.externalIds).not.toBe(ids)
    expect(entry.externalIds).toEqual(ids)
  })

  it('rejects partial-numeric keys like "5abc"', () => {
    // Number('5abc') === NaN, correctly rejected.
    // Number.parseInt('5abc', 10) === 5, which would incorrectly accept it.
    const back = syncStateFromJson({ '5abc': { fingerprint: 'z', externalIds: [] } })
    expect(back.size).toBe(0)
  })
})
