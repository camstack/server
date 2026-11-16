/**
 * Quick edit on the Actions tab: it opens right after a NEW action is saved,
 * and its save goes through the section's own update carrying the steps.
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

  it('the row action saves name and tags and carries the steps untouched', () => {
    renderTab('/build?tab=actions')
    fireEvent.click(screen.getByTestId('action-quick-edit-internal:abc'))
    fireEvent.change(screen.getByTestId('quick-edit-name'), { target: { value: 'Feed the cat' } })
    fireEvent.click(screen.getByTestId('quick-edit-save'))
    expect(updateMutate).toHaveBeenCalledTimes(1)
    const call = updateMutate.mock.calls[0]?.[0]
    expect(call.actionId).toBe('internal:abc')
    expect(call.action.name).toBe('Feed the cat')
    expect(call.action.tags).toEqual(['Pets'])
    expect(call.action.steps).toEqual([{ kind: 'wait', seconds: 42 }])
  })
})
