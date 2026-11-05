// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DataTable, type DataColumn } from '../data-table'
import type { RowOperationState } from '../../hooks/use-row-operations'

interface Row {
  readonly id: string
  readonly name: string
}

const ROWS: readonly Row[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Bravo' },
]

const COLUMNS: readonly DataColumn<Row>[] = [
  { key: 'name', header: 'Name', sortValue: (r) => r.name, render: (r) => r.name },
]

function renderTable(
  states: Readonly<Record<string, RowOperationState>>,
  onRowClick: (row: Row) => void,
): HTMLElement[] {
  const { container } = render(
    <DataTable
      columns={[...COLUMNS]}
      rows={[...ROWS]}
      rowKey={(r) => r.id}
      onRowClick={onRowClick}
      rowState={(r) => states[r.id]}
    />,
  )
  return [...container.querySelectorAll<HTMLElement>('tbody tr')]
}

describe('DataTable — row state', () => {
  it('a pending row is busy and ignores clicks while its neighbour stays live', () => {
    const onRowClick = vi.fn()
    const [alpha, bravo] = renderTable({ a: { kind: 'pending' } }, onRowClick)
    expect(alpha?.getAttribute('aria-busy')).toBe('true')
    expect(bravo?.getAttribute('aria-busy')).toBeNull()
    if (alpha) fireEvent.click(alpha)
    expect(onRowClick).not.toHaveBeenCalled()
    if (bravo) fireEvent.click(bravo)
    expect(onRowClick).toHaveBeenCalledTimes(1)
  })

  it('a failed row stays clickable and exposes the message', () => {
    const onRowClick = vi.fn()
    const [alpha] = renderTable({ a: { kind: 'failed', message: 'provider offline' } }, onRowClick)
    expect(alpha?.getAttribute('title')).toBe('provider offline')
    if (alpha) fireEvent.click(alpha)
    expect(onRowClick).toHaveBeenCalledTimes(1)
  })
})
