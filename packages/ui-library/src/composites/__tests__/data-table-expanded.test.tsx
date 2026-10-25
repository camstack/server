// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DataTable, type DataColumn } from '../data-table'

interface Row {
  readonly id: string
  readonly name: string
}

const ROWS: readonly Row[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Bravo' },
  { id: 'c', name: 'Charlie' },
]

const COLUMNS: readonly DataColumn<Row>[] = [
  {
    key: 'name',
    header: 'Name',
    sortValue: (r) => r.name,
    render: (r) => r.name,
  },
]

/** Text of every body row, in DOM order. */
function bodyRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('tbody tr')].map((tr) => tr.textContent ?? '')
}

describe('DataTable — expanded row detail', () => {
  it('places the detail directly under the expanded row, not after all rows', () => {
    const { container } = render(
      <DataTable
        columns={[...COLUMNS]}
        rows={[...ROWS]}
        rowKey={(r) => r.id}
        isExpanded={(r) => r.id === 'a'}
        renderExpanded={(r) => <span>detail of {r.name}</span>}
      />,
    )
    expect(bodyRows(container)).toEqual(['Alpha', 'detail of Alpha', 'Bravo', 'Charlie'])
  })

  it('keeps the detail attached to its row when the table is sorted', () => {
    const { container } = render(
      <DataTable
        columns={[...COLUMNS]}
        rows={[...ROWS]}
        rowKey={(r) => r.id}
        defaultSort={{ columnKey: 'name', dir: 'desc' }}
        isExpanded={(r) => r.id === 'b'}
        renderExpanded={(r) => <span>detail of {r.name}</span>}
      />,
    )
    expect(bodyRows(container)).toEqual(['Charlie', 'Bravo', 'detail of Bravo', 'Alpha'])
  })

  it('spans the detail across every column and renders nothing when none is open', () => {
    const { container } = render(
      <DataTable
        columns={[...COLUMNS]}
        rows={[...ROWS]}
        rowKey={(r) => r.id}
        isExpanded={(r) => r.id === 'c'}
        renderExpanded={() => <span>x</span>}
      />,
    )
    expect(container.querySelector('tr[data-expanded-row] td')?.getAttribute('colspan')).toBe('1')
    const none = render(
      <DataTable
        columns={[...COLUMNS]}
        rows={[...ROWS]}
        isExpanded={() => false}
        renderExpanded={() => <span>x</span>}
      />,
    )
    expect(none.container.querySelectorAll('tbody tr')).toHaveLength(3)
  })
})
