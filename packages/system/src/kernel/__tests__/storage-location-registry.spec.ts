import { describe, it, expect } from 'vitest'
import { buildStorageLocationRegistry } from '../storage-location-registry.js'

describe('buildStorageLocationRegistry', () => {
  it('aggregates declarations from multiple addons', () => {
    const reg = buildStorageLocationRegistry([
      [{ id: 'recordings', displayName: 'Recordings', cardinality: 'multi' }],
      [{ id: 'eventMedia', displayName: 'Event Media', cardinality: 'single' }],
    ])
    expect(reg.get('recordings')?.cardinality).toBe('multi')
    expect(reg.get('eventMedia')?.cardinality).toBe('single')
    expect(
      reg
        .list()
        .map((d) => d.id)
        .toSorted(),
    ).toEqual(['eventMedia', 'recordings'])
  })
  it('first declarer wins for displayName on a shared id', () => {
    const reg = buildStorageLocationRegistry([
      [{ id: 'recordings', displayName: 'Recordings', cardinality: 'multi' }],
      [{ id: 'recordings', displayName: 'Other', cardinality: 'multi' }],
    ])
    expect(reg.get('recordings')?.displayName).toBe('Recordings')
  })
  it('throws on conflicting cardinality for a shared id', () => {
    expect(() =>
      buildStorageLocationRegistry([
        [{ id: 'recordings', displayName: 'A', cardinality: 'multi' }],
        [{ id: 'recordings', displayName: 'B', cardinality: 'single' }],
      ]),
    ).toThrow(/cardinality/i)
  })
  it('has(id) and cardinalityOf(id)', () => {
    const reg = buildStorageLocationRegistry([
      [{ id: 'logs', displayName: 'Logs', cardinality: 'single' }],
    ])
    expect(reg.has('logs')).toBe(true)
    expect(reg.has('nope')).toBe(false)
    expect(reg.cardinalityOf('logs')).toBe('single')
    expect(reg.cardinalityOf('nope')).toBeNull()
  })
})
