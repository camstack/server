// @vitest-environment jsdom
/**
 * The section's tag selection follows the registry's writes (D1054): a renamed
 * tag stays selected under its new name, a removed one leaves the selection —
 * no invisible chip waiting to filter if the name comes back.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useTagFilter } from '../use-tag-filter'

interface Row {
  readonly id: string
  readonly tags: readonly string[]
}
const ROWS: readonly Row[] = [
  { id: 'a', tags: ['Night', 'Garden'] },
  { id: 'b', tags: ['Garden'] },
]
const getTags = (r: Row): readonly string[] => r.tags
const searchText = (r: Row): readonly string[] => [r.id]

describe('useTagFilter selection', () => {
  beforeEach(() => window.localStorage.clear())

  it('a renamed tag stays selected under its new name; a removed one drops', () => {
    const { result } = renderHook(() =>
      useTagFilter({ section: 'spec', rows: ROWS, getTags, searchText }),
    )
    act(() => result.current.setSelected(['Night', 'Garden']))
    act(() => result.current.followRename('Night', 'Evening'))
    expect(result.current.selected).toEqual(['Evening', 'Garden'])
    act(() => result.current.followRename('Garden', null))
    expect(result.current.selected).toEqual(['Evening'])
  })

  it('the search matches a tag name through the shared table filter', () => {
    const { result } = renderHook(() =>
      useTagFilter({ section: 'spec', rows: ROWS, getTags, searchText }),
    )
    act(() => result.current.filter.setSearch('night'))
    expect(result.current.visible.map((r) => r.id)).toEqual(['a'])
  })
})
