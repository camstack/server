import { describe, expect, it } from 'vitest'
import { labelOf, labelsFromList, listPreview } from '../list-value'

describe('list values', () => {
  it('names items and never uses the default object tag', () => {
    expect(labelsFromList(['Salt', { label: 'Rinse aid' }, { name: 'Filter' }])).toEqual([
      'Salt',
      'Rinse aid',
      'Filter',
    ])
    const unnamed = labelOf({ foo: 1 })
    expect(unnamed).not.toBe('[object Object]')
    expect(unnamed).toBe('{"foo":1}')
    expect(labelsFromList({ label: 'nope' })).toBeNull()
  })
  it('truncates the preview and keeps the full list', () => {
    const preview = listPreview(['a', 'b', 'c', 'd', 'e'])
    expect(preview.shown).toEqual(['a', 'b', 'c'])
    expect(preview.truncated).toBe(true)
    expect(preview.labels).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})
