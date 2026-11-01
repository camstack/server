/**
 * Run now with variables: an action with a required variable and no default
 * used to have a disabled Run button. It now asks for the variable first, and
 * `actions.run` receives what was typed.
 */
import { type ActionEntry, ActionEntrySchema } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionEditor } from '../ActionEditor'
import { missingRunValues, needsRunInput, runVariablesOf } from '../run-variables'

const runMutate = vi.fn()

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useActionsRun: () => ({ mutate: runMutate, isPending: false, error: null }),
  useActionsCreate: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useActionsUpdate: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useActionsDelete: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useActionsGetTraces: () => ({ data: { traces: [] } }),
  useConfirm: () => vi.fn(),
}))
vi.mock('../../automation/automation-data', () => ({
  useAutomationDevices: () => ({ devices: [], state: { kind: 'ready' } }),
}))

const PORTION = { name: 'grams', label: 'Portion', type: 'number', required: true } as const

function entryWith(variables: ActionEntry['variables']): ActionEntry {
  return ActionEntrySchema.parse({
    id: 'internal:3f2a9c1e-0000-4000-8000-000000000001',
    name: 'Feed the cat',
    addonId: 'actions',
    source: 'internal',
    readOnly: false,
    status: { isRunning: false, lastRunAt: null, lastError: null },
    steps: [{ kind: 'wait', seconds: 1 }],
    variables,
  })
}

function renderEditor(entry: ActionEntry) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ActionEditor entry={entry} onClose={vi.fn()} onSaved={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('run-variables', () => {
  it('a required variable without a default needs input; only answers are sent', () => {
    expect(needsRunInput([PORTION])).toBe(true)
    expect(needsRunInput([{ ...PORTION, default: 5 }])).toBe(false)
    expect(missingRunValues([PORTION], {})).toEqual(['grams'])
    expect(missingRunValues([PORTION], { grams: Number.NaN })).toEqual(['grams'])
    expect(
      runVariablesOf([PORTION, { name: 'note', type: 'string' }], { grams: 30, note: '' }),
    ).toEqual({
      grams: 30,
    })
  })
})

describe('Run now on an action with a required variable', () => {
  beforeEach(() => runMutate.mockClear())

  it('opens a dialog, keeps Run off until it is filled, then runs with the value', () => {
    renderEditor(entryWith([PORTION]))
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }))
    expect(runMutate).not.toHaveBeenCalled()
    const form = screen.getByTestId('run-variables-form')
    const dialogRun = screen.getAllByRole('button', { name: /Run now/ }).at(-1)
    if (dialogRun === undefined) throw new Error('no dialog button')
    expect((dialogRun as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(form.querySelector('input') as HTMLInputElement, { target: { value: '30' } })
    expect((dialogRun as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(dialogRun)
    expect(runMutate).toHaveBeenCalledWith({
      actionId: 'internal:3f2a9c1e-0000-4000-8000-000000000001',
      variables: { grams: 30 },
    })
  })

  it('an action that needs nothing runs straight away', () => {
    renderEditor(entryWith([{ ...PORTION, default: 5 }]))
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }))
    expect(runMutate).toHaveBeenCalledWith({
      actionId: 'internal:3f2a9c1e-0000-4000-8000-000000000001',
    })
    expect(screen.queryByTestId('run-variables-form')).toBeNull()
  })
})
