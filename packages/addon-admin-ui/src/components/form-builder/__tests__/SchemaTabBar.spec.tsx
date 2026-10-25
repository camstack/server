// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SchemaTabBar, type SchemaTabBarTab } from '../SchemaTabBar'

const TABS: readonly SchemaTabBarTab[] = [
  { id: 'general', label: 'General' },
  { id: 'streams', label: 'Streams' },
  { id: 'detection', label: 'Detection' },
]

describe('SchemaTabBar', () => {
  it('wraps instead of scrolling horizontally', () => {
    // Reported on a phone: a horizontal scrollbar on a tab bar that fitted in one
    // row. The bar was `flex-nowrap overflow-x-auto` below `md`; `overflow-x: auto`
    // promotes `overflow-y: visible` to `auto`, the buttons' `-mb-px`/`border-b-2`
    // overflow vertically by a pixel, that raises a vertical scrollbar, which
    // narrows the row into horizontal overflow.
    //
    // jsdom does no layout, so this asserts the STRUCTURAL property that made the
    // cascade possible: the bar must not be a scroll container.
    const { container } = render(
      <SchemaTabBar tabs={TABS} activeId="general" onChange={() => undefined} />,
    )
    const bar = container.firstElementChild
    expect(bar).not.toBeNull()
    expect(bar?.className).toContain('flex-wrap')
    expect(bar?.className).not.toMatch(/overflow-x-(auto|scroll)/)
    expect(bar?.className).not.toContain('flex-nowrap')
  })

  it('renders nothing when there are no tabs', () => {
    const { container } = render(
      <SchemaTabBar tabs={[]} activeId={null} onChange={() => undefined} />,
    )
    expect(container.firstElementChild).toBeNull()
  })

  it('reports the clicked tab id', () => {
    const onChange = vi.fn()
    render(<SchemaTabBar tabs={TABS} activeId="general" onChange={onChange} />)
    screen.getByRole('button', { name: /Streams/ }).click()
    expect(onChange).toHaveBeenCalledWith('streams')
  })

  it('shows a count hint and a pending dot only when non-zero', () => {
    const { container } = render(
      <SchemaTabBar
        tabs={TABS}
        activeId="general"
        onChange={() => undefined}
        countByTab={new Map([['general', 2]])}
        pendingByTab={
          new Map([
            ['streams', 1],
            ['detection', 0],
          ])
        }
      />,
    )
    expect(screen.getByRole('button', { name: /General/ }).textContent).toContain('(2)')
    expect(screen.getByRole('button', { name: /Streams/ }).textContent).not.toContain('(')
    // One dot: `streams` has pending 1, `detection` has 0 and must not render one.
    expect(container.querySelectorAll('span.rounded-full')).toHaveLength(1)
  })
})
