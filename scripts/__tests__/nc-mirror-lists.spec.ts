import { describe, expect, it } from 'vitest'
import { literals, type ListSource } from '../lib/nc-mirror-lists.ts'

const SOURCE: ListSource = { path: 'x.ts', marker: 'export const HELD: readonly Kind[] =' }

describe('literals', () => {
  it('reads the quoted members of the list', () => {
    expect(literals(`${SOURCE.marker} ['a', 'b']`, SOURCE)).toEqual(['a', 'b'])
  })

  it('accepts the literal empty list only when asked, and only right after the marker', () => {
    const src = `${SOURCE.marker} []\n// 'comment' ['not a member']\nconst other = ['x']`
    expect(literals(src, SOURCE, true)).toEqual([])
    expect(literals(src, SOURCE)).toMatch(/is empty/)
  })

  it('a read that missed the list still errors, empty allowed or not', () => {
    // the marker is absent
    expect(literals('const other = []', SOURCE, true)).toMatch(/not found/)
    // the declaration is not a literal list
    expect(literals(`${SOURCE.marker} build()`, SOURCE, true)).toMatch(/no \[\.\.\.\] list/)
    // a list of non-string members reads as empty: the read is broken, not "nothing held back"
    expect(literals(`${SOURCE.marker} [KIND_A, KIND_B]`, SOURCE, true)).toMatch(/is empty/)
  })
})
