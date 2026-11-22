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
  { mobile: 'primary', key: 'name', header: 'Name', render: (r) => r.name },
  { mobile: 'detail', key: 'node', header: 'Node', render: (r) => r.node },
  { mobile: 'keep', key: 'state', header: 'State', render: (r) => r.state },
  { mobile: 'hidden', key: 'seen', header: 'Last seen', render: (r) => r.seen },
  {
    mobile: 'keep',
    key: 'actions',
    align: 'right',
    render: () => <button type="button">Remove</button>,
  },
]

/** jsdom has no matchMedia; drive `useIsMobile` from this switch. */
function setViewport(narrow: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: narrow && query.includes('max-width: 639px'),
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

  it('scrolls INSIDE its own container from `sm` up, so the page body never moves sideways', () => {
    const { container } = render(<DataTable columns={[...WIDE]} rows={[...ROWS]} />)
    const wrapper = container.querySelector('table')?.parentElement
    expect(wrapper?.className).toContain('overflow-x-auto')
  })

  it('stays a table at phone width — never a card list', () => {
    setViewport(true)
    const { container } = render(<DataTable columns={[...WIDE]} rows={[...ROWS]} />)
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelector('[data-data-table-card]')).toBeNull()
    expect(container.querySelectorAll('tbody tr')).toHaveLength(ROWS.length)
  })

  // Which columns exist is decided in markup (a folded column is not mounted
  // twice); how the remaining ones share the width is CSS behind `sm`, which
  // `ui:shots` measures at 390 px (row height, sideways overflow).
  describe('below `sm`, by column role', () => {
    const phone = (): HTMLElement => {
      setViewport(true)
      return render(<DataTable columns={[...WIDE]} rows={[...ROWS]} minWidthPx={900} />).container
    }
    const cellKeys = (container: HTMLElement): readonly (string | null)[] =>
      Array.from(container.querySelectorAll('tbody tr:first-child td')).map((td) =>
        td.getAttribute('data-cell'),
      )

    it('drops the minimum width, so the table cannot be wider than the phone', () => {
      expect(phone().querySelector('table')?.className).toContain('max-sm:!min-w-0')
    })

    it('keeps only the primary and kept columns as columns, header included', () => {
      const container = phone()
      expect(cellKeys(container)).toEqual(['name', 'state', 'actions'])
      expect(container.querySelectorAll('th')).toHaveLength(3)
    })

    it('gives the primary column the free width and lets it wrap, so a name is never cut', () => {
      const primary = phone().querySelector('td[data-cell="name"]')
      expect(primary?.className).toContain('max-sm:w-full')
      expect(primary?.className).toContain('max-sm:whitespace-normal')
    })

    it('keeps a kept column on one line beside it', () => {
      const state = phone().querySelector('td[data-cell="state"]')
      expect(state?.className).toContain('max-sm:whitespace-nowrap')
    })

    it('reads a detail column under the primary value — once — and drops a hidden one', () => {
      const container = phone()
      const line = container.querySelector('td[data-cell="name"] [data-phone-detail]')
      expect(line?.querySelector('[data-phone-detail-of="node"]')?.textContent).toBe('hub')
      expect(screen.getAllByText('hub')).toHaveLength(1)
      expect(screen.queryByText('2m')).toBeNull()
    })

    it('renders no detail line for a table with no detail column', () => {
      setViewport(true)
      const columns = WIDE.filter((col) => col.mobile !== 'detail')
      const { container } = render(<DataTable columns={[...columns]} rows={[...ROWS]} />)
      expect(container.querySelector('[data-phone-detail]')).toBeNull()
    })

    it('mounts every column, and no detail line, from `sm` up', () => {
      const { container } = render(<DataTable columns={[...WIDE]} rows={[...ROWS]} />)
      expect(cellKeys(container)).toEqual(['name', 'node', 'state', 'seen', 'actions'])
      expect(container.querySelector('[data-phone-detail]')).toBeNull()
    })
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

  it('does not wrap cell text from `sm` up — the row stays one line and the table scrolls', () => {
    const { container } = render(<DataTable columns={[...WIDE]} rows={[...ROWS]} />)
    const cell = container.querySelector('td')
    expect(cell?.className).toContain('whitespace-nowrap')
  })
})
