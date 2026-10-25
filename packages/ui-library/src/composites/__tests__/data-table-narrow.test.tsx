// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { DataTable, type DataColumn } from '../data-table'

interface Row {
  readonly name: string
  readonly node: string
  readonly state: string
  readonly seen: string
}

const ROWS: readonly Row[] = [
  { name: 'Front door', node: 'hub', state: 'online', seen: '2m' },
  { name: 'Garden', node: 'agent-1', state: 'offline', seen: '4h' },
]

const WIDE: readonly DataColumn<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name },
  { key: 'node', header: 'Node', render: (r) => r.node },
  { key: 'state', header: 'State', render: (r) => r.state },
  { key: 'seen', header: 'Last seen', render: (r) => r.seen },
  { key: 'actions', align: 'right', render: () => <button type="button">Remove</button> },
]

/** jsdom has no matchMedia; drive `useIsMobile` from this switch. */
function setViewport(narrow: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: narrow && query.includes('max-width: 767px'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

beforeEach(() => setViewport(false))

describe('DataTable — narrow-viewport rendering', () => {
  it('renders a table on a wide viewport however many columns there are', () => {
    const { container } = render(<DataTable columns={[...WIDE]} rows={[...ROWS]} />)
    expect(container.querySelector('table')).not.toBeNull()
  })

  it('scrolls INSIDE its own container, so the page body never moves sideways', () => {
    const { container } = render(<DataTable columns={[...WIDE]} rows={[...ROWS]} />)
    const wrapper = container.querySelector('table')?.parentElement
    expect(wrapper?.className).toContain('overflow-x-auto')
  })

  it('stays a horizontally-scrolling table at phone width — never a card list', () => {
    setViewport(true)
    const { container } = render(<DataTable columns={[...WIDE]} rows={[...ROWS]} />)
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelector('[data-data-table-card]')).toBeNull()
    expect(container.querySelectorAll('tbody tr')).toHaveLength(ROWS.length)
    const wrapper = container.querySelector('table')?.parentElement
    expect(wrapper?.className).toContain('overflow-x-auto')
  })

  it('still shows the empty state on a narrow viewport', () => {
    setViewport(true)
    render(<DataTable columns={[...WIDE]} rows={[]} emptyMessage="Nothing here" />)
    expect(screen.getByText('Nothing here')).not.toBeNull()
  })

  // `maxBodyHeight` is ONE decision — "this list scrolls internally" — and the
  // pinned header is half of it. A capped table whose header scrolls away is a
  // list of unlabelled cells, so the two can never be requested separately.
  it('caps the table and pins the column header when maxBodyHeight is set', () => {
    const { container } = render(
      <DataTable columns={[...WIDE]} rows={[...ROWS]} maxBodyHeight="max-h-[40vh]" />,
    )
    const wrapper = container.querySelector('table')?.parentElement
    expect(wrapper?.className).toContain('max-h-[40vh]')
    expect(wrapper?.className).toContain('overflow-y-auto')

    const header = container.querySelector('th')
    expect(header?.className).toContain('sticky')
    expect(header?.className).toContain('top-0')
  })

  it('leaves the table uncapped, and the header unpinned, by default', () => {
    const { container } = render(<DataTable columns={[...WIDE]} rows={[...ROWS]} />)
    const wrapper = container.querySelector('table')?.parentElement
    expect(wrapper?.className).not.toContain('overflow-y-auto')
    expect(container.querySelector('th')?.className).not.toContain('sticky')
  })

  it('does not wrap cell text — the row stays one line and the table scrolls', () => {
    const { container } = render(<DataTable columns={[...WIDE]} rows={[...ROWS]} />)
    const cell = container.querySelector('td')
    expect(cell?.className).toContain('whitespace-nowrap')
  })
})
