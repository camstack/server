import { describe, expect, it } from 'vitest'
import {
  TAG_COLOR_IDS,
  TagNameSchema,
  TagsFieldSchema,
  defaultTagColorId,
  normalizeTags,
  removeFromTags,
  renameInTags,
  sameTag,
} from '../tag.js'

describe('tags', () => {
  it('compares trimmed and case-insensitively', () => {
    expect(sameTag(' Garden ', 'garden')).toBe(true)
    expect(sameTag('Garden', 'Yard')).toBe(false)
  })

  it('normalises: trim, drop empty, dedupe keeping the first spelling', () => {
    expect(normalizeTags([' Garden ', 'garden', '', '  ', 'Night'])).toEqual(['Garden', 'Night'])
  })

  it('derives one stable palette colour per tag, whatever the case', () => {
    expect(TAG_COLOR_IDS).toContain(defaultTagColorId('Garden'))
    expect(defaultTagColorId('Garden')).toBe(defaultTagColorId(' garden '))
  })

  it('rejects an empty or over-long name and more than 20 tags', () => {
    expect(TagNameSchema.safeParse('   ').success).toBe(false)
    expect(TagNameSchema.safeParse('x'.repeat(41)).success).toBe(false)
    expect(TagNameSchema.parse('  ok ')).toBe('ok')
    expect(TagsFieldSchema.safeParse(Array.from({ length: 21 }, (_, i) => `t${i}`)).success).toBe(
      false,
    )
  })

  it('renames and removes in a list, null when absent', () => {
    expect(renameInTags(['a', 'B'], 'b', 'a')).toEqual(['a'])
    expect(renameInTags(['a'], 'z', 'y')).toBeNull()
    expect(removeFromTags(['a', 'B'], 'b')).toEqual(['a'])
    expect(removeFromTags(['a'], 'z')).toBeNull()
  })
})
