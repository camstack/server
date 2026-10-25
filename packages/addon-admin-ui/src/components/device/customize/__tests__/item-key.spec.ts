import { describe, expect, it } from 'vitest'
import { itemKeyFromLabel } from '../item-key'

describe('itemKeyFromLabel', () => {
  it('item keys are valid composition item keys', () => {
    expect(itemKeyFromLabel('Essiccante (giorni)')).toBe('essiccante-giorni')
    expect(itemKeyFromLabel('  ')).toBe('')
  })
})
