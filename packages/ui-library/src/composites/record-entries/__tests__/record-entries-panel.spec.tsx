// @vitest-environment jsdom
import type { EntryKindInfo, EntryView } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const ENTRIES: readonly EntryView[] = [
  { id: 'a', name: 'Home', rev: 1, updatedAt: 1, data: { name: 'Home' } },
  { id: 'b', name: 'Office', rev: 1, updatedAt: 1, data: { name: 'Office' } },
]

vi.mock('../../../generated/system-hooks', () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false })
  return {
    useRecordEntriesListEntries: () => ({
      data: { entries: ENTRIES },
      isPending: false,
      isError: false,
      error: null,
    }),
    useRecordEntriesPutEntry: mutation,
    useRecordEntriesDeleteEntry: mutation,
  }
})

import { ConfirmDialogProvider } from '../../confirm-dialog'
import { RecordEntriesPanel } from '../record-entries-panel'

const KIND: EntryKindInfo = {
  owner: 'google-services',
  kind: 'brokers',
  title: 'Google accounts',
  nameField: 'name',
  fields: { type: 'object', properties: { name: { type: 'string' } } },
  secretPaths: [],
  rows: 2,
}

function renderPanel(props: Partial<React.ComponentProps<typeof RecordEntriesPanel>> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ConfirmDialogProvider>
          <RecordEntriesPanel kind={KIND} {...props} />
        </ConfirmDialogProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('RecordEntriesPanel row extensions', () => {
  it('has only Edit and Delete per row by default', () => {
    renderPanel()
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(within(row).getAllByRole('button').length).toBe(3)
  })

  it('renders the caller-supplied row actions and extra columns per entry', () => {
    renderPanel({
      rowActions: (entry) => <button type="button">{`Sign in ${entry.id}`}</button>,
      extraColumns: [
        {
          key: 'status',
          header: 'Status',
          render: (entry) => <span>{`status-${entry.id}`}</span>,
        },
      ],
    })
    expect(screen.getByRole('button', { name: 'Sign in a' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in b' })).toBeTruthy()
    expect(screen.getByText('Status')).toBeTruthy()
    expect(screen.getByText('status-b')).toBeTruthy()
  })
})
