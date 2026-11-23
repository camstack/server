// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DataTable, type DataColumn } from '../data-table'
import { ConfirmDialogProvider } from '../confirm-dialog'

interface Row {
  readonly id: string
  readonly name: string
}

const ROWS: readonly Row[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Bravo' },
]

function setup(
  run: () => Promise<unknown>,
  onRowActionError?: (m: string, row: Row) => void,
  withRowKey = true,
) {
  const columns: DataColumn<Row>[] = [
    {
      mobile: 'primary',
      key: 'name',
      header: 'Name',
      notSortableReason: 'test',
      render: (r) => r.name,
    },
    {
      mobile: 'keep',
      key: 'actions',
      header: '',
      notSortableReason: 'actions',
      render: (r, _i, table) => (
        <button
          type="button"
          aria-label={`delete ${r.id}`}
          onClick={() =>
            void table.destructive(r, {
              title: 'Delete?',
              message: 'Gone.',
              confirmLabel: 'Yes',
              run,
            })
          }
        />
      ),
    },
  ]
  const tree = (data: readonly Row[]) => (
    <ConfirmDialogProvider>
      <DataTable
        columns={columns}
        rows={[...data]}
        rowKey={withRowKey ? (r) => r.id : undefined}
        onRowActionError={onRowActionError}
      />
    </ConfirmDialogProvider>
  )
  const { rerender } = render(tree(ROWS))
  const rerenderRows = (data: readonly Row[]): void => rerender(tree(data))
  const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('tbody tr')]
  return { rows, rerenderRows }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('DataTable — row destructive action', () => {
  it('confirm closes, the row is pending until the promise settles, then idle', async () => {
    const d = deferred()
    const { rows } = setup(() => d.promise)
    fireEvent.click(screen.getByLabelText('delete a'))
    fireEvent.click(await screen.findByText('Yes'))
    await waitFor(() => expect(rows()[0]?.getAttribute('aria-busy')).toBe('true'))
    expect(rows()[1]?.getAttribute('aria-busy')).toBeNull()
    expect(screen.queryByText('Yes')).toBeNull()
    d.resolve()
    await waitFor(() => expect(rows()[0]?.getAttribute('aria-busy')).toBeNull())
  })

  it('a failure keeps the row, tinted with the message, and reports it', async () => {
    const onError = vi.fn()
    const { rows } = setup(() => Promise.reject(new Error('boom')), onError)
    fireEvent.click(screen.getByLabelText('delete a'))
    fireEvent.click(await screen.findByText('Yes'))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('boom', ROWS[0]))
    expect(rows()).toHaveLength(2)
    expect(rows()[0]?.getAttribute('title')).toBe('boom')
  })

  it('declining runs nothing', async () => {
    const run = vi.fn(() => Promise.resolve())
    setup(run)
    fireEvent.click(screen.getByLabelText('delete a'))
    fireEvent.click(await screen.findByText('Cancel'))
    expect(run).not.toHaveBeenCalled()
  })
  it('a failed row that is refetched away leaves no tint when it comes back', async () => {
    const { rows, rerenderRows } = setup(() => Promise.reject(new Error('boom')))
    fireEvent.click(screen.getByLabelText('delete a'))
    fireEvent.click(await screen.findByText('Yes'))
    await waitFor(() => expect(rows()[0]?.getAttribute('title')).toBe('boom'))
    rerenderRows([ROWS[1] as Row])
    rerenderRows(ROWS)
    expect(rows()[0]?.getAttribute('title')).toBeNull()
  })

  it('without a rowKey the action is refused and never runs', async () => {
    const run = vi.fn(() => Promise.resolve())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setup(run, undefined, false)
    fireEvent.click(screen.getByLabelText('delete a'))
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(screen.queryByText('Yes')).toBeNull()
    expect(run).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
