// @vitest-environment jsdom
/**
 * Generic-mode list — the "Per page" selector.
 *
 * The exporter's devices table (and anything else on generic mode) had a pager
 * but no way to pick its size. A caller that passes `pageSizeSelector` gets the
 * same "Per page" control the device-mode table has, remembered per viewer
 * under the caller's key. A caller that does not keeps the fixed size and shows
 * no selector — the HA adoption modal is unchanged.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { GenericModeList } from '../generic-mode'
import { PAGE_SIZE_ALL } from '../../../hooks/use-persisted-page-size'

interface Row {
  readonly id: string
  readonly name: string
}

const ROWS: readonly Row[] = Array.from({ length: 60 }, (_, i) => ({
  id: String(i + 1),
  name: `Device ${String(i + 1).padStart(2, '0')}`,
}))

const KEY = 'camstack.test.generic.pageSize'
const SELECTOR = {
  options: [10, 25, 50, 100, PAGE_SIZE_ALL],
  defaultSize: 25,
  storageKey: KEY,
} as const

function renderList(withSelector: boolean): void {
  render(
    <GenericModeList<Row>
      mode="generic"
      items={ROWS}
      getKey={(r) => r.id}
      getSearchText={(r) => r.name}
      columns={[{ key: 'name', header: 'Name', cell: (r) => r.name }]}
      {...(withSelector ? { pageSizeSelector: SELECTOR } : {})}
    />,
  )
}

const bodyRows = (): number => {
  const table = screen.getByRole('table')
  return within(table).getAllByRole('row').length - 1 // minus the header row
}

const perPage = (): HTMLSelectElement => screen.getByRole('combobox', { name: 'Rows per page' })

beforeEach(() => {
  localStorage.clear()
})

describe('generic list — page size', () => {
  it('starts on the caller default and offers 10 / 25 / 50 / 100 / All', () => {
    renderList(true)
    expect(bodyRows()).toBe(25)
    expect(perPage().value).toBe('25')
    const labels = within(perPage())
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(labels).toEqual(['10', '25', '50', '100', 'All'])
  })

  it('changes the rows shown and remembers the choice', () => {
    renderList(true)
    fireEvent.change(perPage(), { target: { value: '10' } })
    expect(bodyRows()).toBe(10)
    expect(localStorage.getItem(KEY)).toBe('10')
  })

  it('"All" shows every row and drops the pager', () => {
    renderList(true)
    fireEvent.change(perPage(), { target: { value: String(PAGE_SIZE_ALL) } })
    expect(bodyRows()).toBe(60)
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull()
  })

  it('opens on the remembered size', () => {
    localStorage.setItem(KEY, '50')
    renderList(true)
    expect(bodyRows()).toBe(50)
  })

  it('a caller without a selector keeps its fixed size and shows no control', () => {
    renderList(false)
    expect(screen.queryByRole('combobox', { name: 'Rows per page' })).toBeNull()
    expect(bodyRows()).toBe(60) // default fixed page size is 100
  })
})
