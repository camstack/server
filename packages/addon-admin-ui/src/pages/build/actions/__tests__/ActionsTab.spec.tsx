/**
 * The Actions tab list states: unanswered is a skeleton, answered-empty is the
 * empty state with the create CTA, errored is an error — never an endless
 * "loading".
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionsTab } from '../ActionsTab'

interface ListState {
  data: readonly unknown[] | undefined
  error: Error | null
}
let listState: ListState = { data: undefined, error: null }

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useActionsList: () => ({ ...listState, refetch: vi.fn() }),
  useActionsRun: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}))
vi.mock('../ActionEditor', () => ({ ActionEditor: () => <div>editor</div> }))

function renderTab() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ActionsTab />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ActionsTab list states', () => {
  beforeEach(() => {
    listState = { data: undefined, error: null }
  })

  it('unanswered: neither the empty state nor an error', () => {
    renderTab()
    expect(screen.queryByText('No actions yet')).toBeNull()
    expect(screen.queryByText('Could not read the actions')).toBeNull()
  })

  it('answered empty: the empty state with the create CTA', () => {
    listState = { data: [], error: null }
    renderTab()
    expect(screen.getByText('No actions yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: /New action/ })).toBeTruthy()
    expect(screen.queryByText(/Loading actions/)).toBeNull()
  })

  it('errored without data: an error, not a spinner', () => {
    listState = { data: undefined, error: new Error('boom') }
    renderTab()
    expect(screen.getByText('Could not read the actions')).toBeTruthy()
    expect(screen.getByText('boom')).toBeTruthy()
  })
})
