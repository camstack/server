// @vitest-environment jsdom
/**
 * `DataTable` — controlled sort, client-side pagination and row selection.
 *
 * The selection rules are the ones a bulk action leans on, so they are pinned
 * here and not in every page that uses them:
 *  - the header checkbox selects the selectable rows of THIS PAGE only — never
 *    rows the operator cannot see;
 *  - a row `isSelectable` rejects has no checkbox and is never added;
 *  - keys of rows that are not on the page survive a page-level toggle.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataTable, type DataColumn } from '../data-table'
import { paginateRows } from '../data-table-pagination'
import type { TableSortState } from '../table-sort'

interface Row {
  readonly id: string
  readonly n: number
  readonly locked?: boolean
}

const ROWS: readonly Row[] = Array.from({ length: 7 }, (_, i) => ({
  id: `r${i}`,
  n: 70 - i * 10,
  locked: i === 1,
}))

const COLUMNS: readonly DataColumn<Row>[] = [
  { key: 'id', header: 'Id', render: (r) => r.id, sortValue: (r) => r.id },
  { key: 'n', header: 'N', render: (r) => String(r.n), sortValue: (r) => r.n },
]

const LABELS = {
  navLabel: 'Rows pages',
  previous: 'Previous page',
  next: 'Next page',
  range: (from: number, to: number, total: number) => `${from}–${to} of ${total}`,
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

const ids = (): string[] =>
  [...document.querySelectorAll('tbody tr')].map(
    (tr) => tr.querySelector('[data-cell="id"]')?.textContent ?? '',
  )

describe('paginateRows', () => {
  it('slices one page and reports a 1-based range', () => {
    const p = paginateRows(ROWS, 1, 3)
    expect(p.pageRows.map((r) => r.id)).toEqual(['r3', 'r4', 'r5'])
    expect(p).toMatchObject({ page: 1, pageCount: 3, from: 4, to: 6, total: 7 })
  })

  it('clamps a page past the end to the last page (rows shrank under it)', () => {
    const p = paginateRows(ROWS, 9, 3)
    expect(p.page).toBe(2)
    expect(p.pageRows.map((r) => r.id)).toEqual(['r6'])
  })

  it('an empty set is page 0 of 1 with an empty range', () => {
    expect(paginateRows([], 0, 3)).toMatchObject({ page: 0, pageCount: 1, from: 0, to: 0 })
  })
})

describe('DataTable pagination', () => {
  it('renders one page and walks with the pager', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        pageSize={3}
        paginationLabels={LABELS}
      />,
    )
    expect(ids()).toEqual(['r0', 'r1', 'r2'])
    const nav = screen.getByRole('navigation', { name: 'Rows pages' })
    expect(within(nav).getByText('1–3 of 7')).toBeTruthy()
    expect(within(nav).getByRole('button', { name: 'Previous page' })).toHaveProperty(
      'disabled',
      true,
    )
    fireEvent.click(within(nav).getByRole('button', { name: 'Next page' }))
    fireEvent.click(within(nav).getByRole('button', { name: 'Next page' }))
    expect(ids()).toEqual(['r6'])
    expect(within(nav).getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true)
  })

  it('sorts BEFORE paging: page 1 of a sorted table holds the first sorted rows', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        pageSize={3}
        paginationLabels={LABELS}
        defaultSort={{ columnKey: 'n', dir: 'asc' }}
      />,
    )
    expect(ids()).toEqual(['r6', 'r5', 'r4'])
  })

  it('draws no pager when everything fits on one page', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        pageSize={50}
        paginationLabels={LABELS}
      />,
    )
    expect(screen.queryByRole('navigation', { name: 'Rows pages' })).toBeNull()
  })
})

describe('DataTable controlled sort', () => {
  it('reports header clicks through onSortChange and renders the sort it is given', () => {
    const onSortChange = vi.fn()
    const { rerender } = render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        sort={null}
        onSortChange={onSortChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^N/ }))
    expect(onSortChange).toHaveBeenCalledWith({ columnKey: 'n', dir: 'asc' })
    // Controlled: nothing moves until the owner passes the new state back.
    expect(ids()[0]).toBe('r0')
    rerender(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        sort={{ columnKey: 'n', dir: 'desc' }}
        onSortChange={onSortChange}
      />,
    )
    expect(ids()[0]).toBe('r0')
    expect(screen.getByRole('columnheader', { name: /^N/ }).getAttribute('aria-sort')).toBe(
      'descending',
    )
  })

  it('a controlled owner can round-trip the state', () => {
    function Owner() {
      const [sort, setSort] = useState<TableSortState | null>(null)
      return (
        <DataTable
          columns={COLUMNS}
          rows={ROWS}
          rowKey={(r) => r.id}
          sort={sort}
          onSortChange={setSort}
        />
      )
    }
    render(<Owner />)
    fireEvent.click(screen.getByRole('button', { name: /^N/ }))
    expect(ids()[0]).toBe('r6')
  })
})

describe('DataTable selection', () => {
  function Selectable({ onChange }: { readonly onChange?: (s: ReadonlySet<string>) => void }) {
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(['r6']))
    return (
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        pageSize={3}
        paginationLabels={LABELS}
        selection={{
          selected,
          onChange: (next) => {
            setSelected(next)
            onChange?.(next)
          },
          isSelectable: (r) => r.locked !== true,
          rowLabel: (r) => `Select ${r.id}`,
          pageLabel: 'Select every row on this page',
        }}
      />
    )
  }

  it('a row that is not selectable has no checkbox', () => {
    render(<Selectable />)
    expect(screen.queryByRole('checkbox', { name: 'Select r1' })).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Select r0' })).toBeTruthy()
  })

  it('the header box selects the selectable rows of THIS page only, keeping off-page keys', () => {
    const onChange = vi.fn()
    render(<Selectable onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select every row on this page' }))
    const next = onChange.mock.calls.at(-1)?.[0] as ReadonlySet<string>
    expect([...next].toSorted()).toEqual(['r0', 'r2', 'r6'])
  })

  it('a second header click clears this page and still keeps off-page keys', () => {
    const onChange = vi.fn()
    render(<Selectable onChange={onChange} />)
    const all = screen.getByRole('checkbox', { name: 'Select every row on this page' })
    fireEvent.click(all)
    fireEvent.click(all)
    const next = onChange.mock.calls.at(-1)?.[0] as ReadonlySet<string>
    expect([...next]).toEqual(['r6'])
  })

  it('toggles one row', () => {
    const onChange = vi.fn()
    render(<Selectable onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select r2' }))
    const next = onChange.mock.calls.at(-1)?.[0] as ReadonlySet<string>
    expect([...next].toSorted()).toEqual(['r2', 'r6'])
  })
})
