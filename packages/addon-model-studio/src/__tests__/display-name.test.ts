import { describe, expect, it } from 'vitest'
import {
  MODEL_DISPLAY_NAME_MAX,
  optionalImportName,
  parseDisplayName,
  resolveModelDisplayName,
} from '../display-name.js'

describe('parseDisplayName', () => {
  it('trims and collapses whitespace', () => {
    expect(parseDisplayName('  Porch \t camera  ')).toEqual({
      kind: 'set',
      name: 'Porch camera',
    })
  })

  it('an empty or blank value means reset to the imported name', () => {
    expect(parseDisplayName('')).toEqual({ kind: 'reset' })
    expect(parseDisplayName('   ')).toEqual({ kind: 'reset' })
  })

  it('caps the length after trimming', () => {
    expect(parseDisplayName(`  ${'a'.repeat(MODEL_DISPLAY_NAME_MAX)}  `).kind).toBe('set')
    expect(parseDisplayName('a'.repeat(MODEL_DISPLAY_NAME_MAX + 1)).kind).toBe('invalid')
  })

  it('rejects control characters that are not whitespace', () => {
    expect(parseDisplayName('bad\u0007name').kind).toBe('invalid')
  })
})

describe('optionalImportName', () => {
  it('an empty field sends no name, so the source default applies', () => {
    expect(optionalImportName(undefined)).toBeUndefined()
    expect(optionalImportName('  ')).toBeUndefined()
  })

  it('a typed name is cleaned; an unacceptable one throws with the reason', () => {
    expect(optionalImportName(' Coral  person ')).toBe('Coral person')
    expect(() => optionalImportName('x'.repeat(200))).toThrow(/Display name rejected/)
  })
})

describe('resolveModelDisplayName', () => {
  it('shows the name, else the id', () => {
    expect(resolveModelDisplayName({ id: 'plus-catalog-1', name: 'Porch' })).toBe('Porch')
    expect(resolveModelDisplayName({ id: 'plus-catalog-1', name: '  ' })).toBe('plus-catalog-1')
    expect(resolveModelDisplayName({ id: 'plus-catalog-1' })).toBe('plus-catalog-1')
  })
})
