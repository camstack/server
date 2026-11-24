// @vitest-environment jsdom
/**
 * Generic-mode list inside a modal: scrolling it, or a data refresh under it, must not disturb
 * anything behind it.
 *
 * The Add device list is a scroller inside a dialog that blurs the page behind it. A scroller that
 * does not contain its overscroll hands every fast flick that reaches an end to the page behind,
 * which then scrolls and repaints under the blur: the whole screen flashes. And a refresh of the
 * list's data (a scan answering, a query refetching) hands it a new array of equal rows: the rows
 * must stay the same DOM nodes, never be torn down and rebuilt.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { GenericModeList } from '../generic-mode'

interface Row {
  readonly id: string
  readonly name: string
}

const rowsOf = (count: number): readonly Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `d${String(i)}`, name: `Device ${String(i)}` }))

function list(items: readonly Row[]) {
  return (
    <GenericModeList<Row>
      mode="generic"
      items={items}
      getKey={(r) => r.id}
      getSearchText={(r) => r.name}
      columns={[{ key: 'name', header: 'Name', cell: (r) => r.name }]}
    />
  )
}

describe('GenericModeList scrolling', () => {
  it('contains its overscroll when its parent bounds its height, so a flick at an end never scrolls the page behind', () => {
    // jsdom has no layout: a bounded region is one whose content is taller than its box.
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900)
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
    try {
      render(list(rowsOf(30)))
      const scroller = screen.getByRole('table').closest('.overflow-y-auto')
      expect(scroller).not.toBeNull()
      expect(scroller?.className).toContain('overscroll-contain')
    } finally {
      scrollHeight.mockRestore()
      clientHeight.mockRestore()
    }
  })

  it('does not capture the wheel when its parent gives it no height (its box fits its content)', () => {
    render(list(rowsOf(30)))
    expect(screen.getByRole('table').closest('.overflow-y-auto')).toBeNull()
    expect(screen.getByRole('table').closest('.overscroll-contain')).toBeNull()
  })

  it('keeps the same row nodes when its data refreshes to an equal, new array', () => {
    const view = render(list(rowsOf(30)))
    const before = within(screen.getByRole('table')).getAllByRole('row')
    view.rerender(list(rowsOf(30)))
    const after = within(screen.getByRole('table')).getAllByRole('row')
    expect(after).toHaveLength(before.length)
    after.forEach((row, i) => {
      expect(row).toBe(before[i])
    })
  })
})
