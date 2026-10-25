// @vitest-environment jsdom
/**
 * `DataTable` column sorting, asserted through the DOM the operator clicks.
 *
 * The load-bearing claim is not "the header renders a chevron" — it is that a
 * column WITHOUT `sortValue` never becomes clickable. That is the guard
 * against the failure this work exists to avoid: an ordering offered on a
 * composite cell, which looks authoritative and means nothing.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { DataTable, type DataColumn } from '../data-table'

interface Row {
  readonly pid: number
  readonly cpu: number
  readonly command: string
}

const ROWS: readonly Row[] = [
  { pid: 30, cpu: 9, command: '/usr/bin/node b' },
  { pid: 10, cpu: 100, command: '/usr/bin/node a' },
  { pid: 20, cpu: 4, command: '/usr/bin/node c' },
]

const COLUMNS: readonly DataColumn<Row>[] = [
  { key: 'pid', header: 'PID', render: (r) => String(r.pid), sortValue: (r) => r.pid },
  { key: 'cpu', header: 'CPU%', render: (r) => String(r.cpu), sortValue: (r) => r.cpu },
  {
    key: 'command',
    header: 'Command',
    render: (r) => r.command,
    notSortableReason: 'argv is a composite value — no meaningful order',
  },
]

/** jsdom has no matchMedia; keep the table in its wide (row) layout. */
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

function pidOrder(): string[] {
  const body = document.querySelectorAll('tbody tr')
  return [...body].map((tr) => tr.querySelectorAll('td')[0]?.textContent ?? '')
}

describe('DataTable column sorting', () => {
  it('leaves the rows in the incoming order until a header is clicked', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.pid} />)
    expect(pidOrder()).toEqual(['30', '10', '20'])
  })

  it('opens on `defaultSort` and cycles asc → desc → incoming order on click', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.pid}
        defaultSort={{ columnKey: 'cpu', dir: 'desc' }}
      />,
    )
    // desc by CPU: 100, 9, 4
    expect(pidOrder()).toEqual(['10', '30', '20'])

    const cpuHeader = screen.getByRole('columnheader', { name: /CPU%/ })
    expect(cpuHeader.getAttribute('aria-sort')).toBe('descending')

    fireEvent.click(within(cpuHeader).getByRole('button'))
    // desc → none: back to the incoming order
    expect(pidOrder()).toEqual(['30', '10', '20'])
    expect(cpuHeader.getAttribute('aria-sort')).toBe('none')

    fireEvent.click(within(cpuHeader).getByRole('button'))
    // none → asc: 4, 9, 100
    expect(pidOrder()).toEqual(['20', '30', '10'])
    expect(cpuHeader.getAttribute('aria-sort')).toBe('ascending')
  })

  it('sorts a numeric column numerically, not as text', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.pid} />)
    const cpuHeader = screen.getByRole('columnheader', { name: /CPU%/ })
    fireEvent.click(within(cpuHeader).getByRole('button'))
    // A text sort of ['9','100','4'] would put '100' first. Numeric puts 4 first.
    expect(pidOrder()).toEqual(['20', '30', '10'])
  })

  it('offers NO click affordance and NO aria-sort on a column without `sortValue`', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.pid} />)
    const commandHeader = screen.getByRole('columnheader', { name: /Command/ })
    expect(within(commandHeader).queryByRole('button')).toBeNull()
    expect(commandHeader.hasAttribute('aria-sort')).toBe(false)
    expect(commandHeader.getAttribute('title')).toBe(
      'argv is a composite value — no meaningful order',
    )
  })

  it('ignores a `defaultSort` that names a column with no `sortValue`', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.pid}
        defaultSort={{ columnKey: 'command', dir: 'asc' }}
      />,
    )
    expect(pidOrder()).toEqual(['30', '10', '20'])
  })
})
