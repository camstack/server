import { describe, expect, it } from 'vitest'
import { findVocabularyDeclarations, undrawableKeys } from '../check-icon-catalog.js'

describe('findVocabularyDeclarations — a second icon vocabulary is refused (D854)', () => {
  it('flags an icon-id array', () => {
    const hit = findVocabularyDeclarations(
      'packages/x/src/rooms.ts',
      "export const ROOM_ICON_IDS = ['sofa', 'bed'] as const",
    )
    expect(hit).toHaveLength(1)
    expect(hit[0]?.line).toBe(1)
  })

  it('flags the other spellings of the same idea', () => {
    for (const source of [
      "const ICON_KEYS: readonly string[] = ['a']",
      'export const DISPLAY_ICON_VOCABULARY = []',
      'const LOCATION_ICON_IDS = new Set()',
      'const DISPLAY_ICON_REGISTRY = {}',
      "type RoomIconId = 'sofa' | 'bed'",
    ]) {
      expect(findVocabularyDeclarations('packages/x/src/a.ts', source), source).toHaveLength(1)
    }
  })

  it('lets the catalog itself declare the key list', () => {
    expect(
      findVocabularyDeclarations(
        'packages/types/src/device/icon-catalog.generated.ts',
        'export const ICON_KEYS = [',
      ),
    ).toEqual([])
  })

  it('does not flag a glyph TABLE typed on the catalog, comments, or unrelated icon maps', () => {
    for (const source of [
      'export const FAST_ICON_GLYPHS: Partial<Record<IconKey, LucideIcon>> = {',
      '// the old LOCATION_ICON_IDS lived here',
      ' * const ROOM_ICON_IDS = []',
      'const KIND_ICON: Record<string, LucideIcon> = {',
      'type IconKey = (typeof ICON_KEYS)[number]',
    ]) {
      expect(findVocabularyDeclarations('packages/x/src/a.ts', source), source).toEqual([])
    }
  })
})

describe('undrawableKeys', () => {
  it('names a key and an alias the package cannot draw', () => {
    const accepted = (id: string): boolean => id !== 'gone' && id !== 'old-name'
    expect(
      undrawableKeys(['camera', 'gone'], { 'old-name': 'camera', fine: 'camera' }, accepted),
    ).toEqual(['gone', 'alias old-name'])
  })

  it('is empty when everything is drawn', () => {
    expect(undrawableKeys(['camera'], {}, () => true)).toEqual([])
  })
})
