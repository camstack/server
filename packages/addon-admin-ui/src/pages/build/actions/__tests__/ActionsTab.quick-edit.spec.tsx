/**
 * Quick edit on the Actions tab: the dialog still opens right after a NEW
 * action is saved; a row click opens the shared quick modal, whose inline save
 * goes through the section's own update carrying the steps, and whose Open
 * button leaves for the editor.
 */
import type { ActionEntry } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import { ActionsTab } from '../ActionsTab'

const ENTRY: ActionEntry = {
  id: 'internal:abc',
  name: 'Feed the dog',
  addonId: 'core-blocks',
  source: 'internal',
  readOnly: false,
  tags: ['Pets'],
  steps: [{ kind: 'wait', seconds: 42 }],
  variables: [],
  status: { isRunning: false, lastRunAt: null, lastError: null },
}

const updateMutate = vi.fn()

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useActionsList: () => ({ data: [ENTRY], error: null, refetch: vi.fn() }),
  useActionsRun: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useActionsGetTraces: () => ({ data: { traces: [] }, error: null }),
  useInstancesOfCap: () => ({ data: [] }),
  useActionsUpdate: () => ({
    mutate: updateMutate,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
}))
// The editor stands in for a successful create: it reports the saved id.
vi.mock('../ActionEditor', () => ({
  ActionEditor: ({ onSaved }: { onSaved: (id: string) => void }) => (
    <button type="button" onClick={() => onSaved('internal:abc')}>
      fake-save-new
    </button>
  ),
}))

function renderTab(url: string, createRequested = false) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <ActionsTab createRequested={createRequested} onCreateConsumed={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ActionsTab Quick edit', () => {
  beforeEach(() => {
    updateMutate.mockClear()
    window.history.replaceState(null, '', '/')
  })

  it('opens right after a new action is saved', () => {
    renderTab('/build?tab=actions', true)
    expect(screen.queryByTestId('quick-edit-dialog')).toBeNull()
    fireEvent.click(screen.getByText('fake-save-new'))
    expect(screen.getByTestId('quick-edit-dialog')).toBeTruthy()
    expect((screen.getByTestId('quick-edit-name') as HTMLInputElement).value).toBe('Feed the dog')
  })

  it('the row has no Quick edit button; a row click opens the quick modal, not the editor', () => {
    renderTab('/build?tab=actions')
    expect(screen.queryByTestId('action-quick-edit-internal:abc')).toBeNull()
    expect(screen.queryByTestId('build-quick-modal')).toBeNull()
    fireEvent.click(screen.getByText('Feed the dog'))
    expect(screen.getByTestId('build-quick-modal')).toBeTruthy()
    expect(screen.queryByText('fake-save-new')).toBeNull()
  })

  it('renaming in the modal saves name and tags and carries the steps untouched', () => {
    renderTab('/build?tab=actions')
    fireEvent.click(screen.getByText('Feed the dog'))
    const name = screen.getByTestId('quick-modal-name')
    fireEvent.change(name, { target: { value: 'Feed the cat' } })
    fireEvent.blur(name)
    expect(updateMutate).toHaveBeenCalledTimes(1)
    const call = updateMutate.mock.calls[0]?.[0]
    expect(call.actionId).toBe('internal:abc')
    expect(call.action.name).toBe('Feed the cat')
    expect(call.action.tags).toEqual(['Pets'])
    expect(call.action.steps).toEqual([{ kind: 'wait', seconds: 42 }])
  })

  it('the Open button closes the modal and opens the editor', () => {
    renderTab('/build?tab=actions')
    fireEvent.click(screen.getByText('Feed the dog'))
    fireEvent.click(screen.getByTestId('quick-modal-open'))
    expect(screen.queryByTestId('build-quick-modal')).toBeNull()
    expect(screen.getByText('fake-save-new')).toBeTruthy()
  })
})
