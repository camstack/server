/**
 * The Schedulers tab list states: unanswered is a skeleton, answered-empty is
 * the empty state with the create CTA, errored is an error.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SchedulersTab } from '../SchedulersTab'

interface ListState {
  data: readonly unknown[] | undefined
  error: Error | null
}
let listState: ListState = { data: undefined, error: null }

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useSchedulersList: () => ({ ...listState, refetch: vi.fn() }),
  useSchedulersGetStatus: () => ({ data: [], error: null }),
  useSchedulersGetTraces: () => ({ data: { traces: [], lastError: null }, error: null }),
  useSchedulersPreview: () => ({ data: { points: [] } }),
  useSchedulersUpdate: () => ({ mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
  useSchedulersSetEnabled: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}))
vi.mock('../SchedulerEditor', () => ({
  SchedulerEditor: () => <div data-testid="scheduler-editor">editor</div>,
}))

function renderTab() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <SchedulersTab />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SchedulersTab list states', () => {
  beforeEach(() => {
    listState = { data: undefined, error: null }
  })

  it('unanswered: neither the empty state nor an error', () => {
    renderTab()
    expect(screen.queryByText('No schedulers yet')).toBeNull()
    expect(screen.queryByText('Could not read the schedulers')).toBeNull()
  })

  it('answered empty: the empty state with the create CTA', () => {
    listState = { data: [], error: null }
    renderTab()
    expect(screen.getByText('No schedulers yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: /New scheduler/ })).toBeTruthy()
  })

  it('errored without data: an error, not a spinner', () => {
    listState = { data: undefined, error: new Error('boom') }
    renderTab()
    expect(screen.getByText('Could not read the schedulers')).toBeTruthy()
    expect(screen.getByText('boom')).toBeTruthy()
  })

  it('a row click opens the quick modal, not the editor; Open goes to the editor', () => {
    listState = {
      data: [
        {
          id: 'sch-garden',
          name: 'Garden lights',
          enabled: true,
          priority: 10,
          maxLateMs: 600_000,
          createdAt: 1,
          updatedAt: 1,
          profiles: [],
        },
      ],
      error: null,
    }
    renderTab()
    fireEvent.click(screen.getByText('Garden lights'))
    expect(screen.getByTestId('build-quick-modal')).toBeTruthy()
    expect(screen.queryByTestId('scheduler-editor')).toBeNull()
    fireEvent.click(screen.getByTestId('quick-modal-open'))
    expect(screen.getByTestId('scheduler-editor')).toBeTruthy()
  })
})
