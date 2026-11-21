/**
 * Section bodies of the quick modal: an automation lists its last runs (each
 * opens the full run) and an action runs from the modal and lists executions.
 */
import type { ActionEntry, AutomationRunTrace, CoreBlock } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import { ActionQuickBody } from '../quick-bodies/ActionQuickBody'
import { AutomationQuickBody } from '../quick-bodies/AutomationQuickBody'

const FAILED: AutomationRunTrace = {
  runId: 'r-failed',
  startedAt: 1000,
  endedAt: 3500,
  trigger: { kind: 'detection', outcome: 'pass', reason: 'animal seen', vars: {} },
  conditions: [],
  steps: [{ path: 'actions.0', kind: 'cap', outcome: 'error', message: 'Feeder offline' }],
  outcome: 'failed',
  repeat: 1,
  lastAt: 3500,
}

const runMutate = vi.fn()
let traces: readonly AutomationRunTrace[] = [FAILED]

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useCoreBlocksGetTraces: () => ({ data: { traces, lastError: null }, error: null }),
  useActionsGetTraces: () => ({ data: { traces }, error: null }),
  useActionsRun: () => ({ mutate: runMutate, isPending: false, error: null }),
}))

const BLOCK: CoreBlock = {
  id: 'b1',
  name: 'Feed',
  code: '// not a recipe',
  enabled: true,
  placement: 'hub',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'u',
  status: 'running',
  lastChangedAt: 1,
}

const ACTION: ActionEntry = {
  id: 'internal:abc',
  name: 'Feed the dog',
  addonId: 'core-blocks',
  source: 'internal',
  readOnly: false,
  tags: [],
  steps: [{ kind: 'wait', seconds: 5 }],
  variables: [],
  status: { isRunning: false, lastRunAt: null, lastError: null },
}

function wrap(node: React.ReactNode): React.ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe('AutomationQuickBody', () => {
  it('lists the last runs with outcome and reason, and each opens the full run', () => {
    const onOpenRun = vi.fn()
    render(wrap(<AutomationQuickBody block={BLOCK} onOpenRun={onOpenRun} />))
    const row = screen.getByTestId('quick-run-row')
    expect(row.textContent).toContain('Feeder offline')
    fireEvent.click(screen.getByTestId('quick-run-open'))
    expect(onOpenRun).toHaveBeenCalledWith('r-failed')
  })

  it('says "never ran" when the ledger answered with no run', () => {
    traces = []
    render(wrap(<AutomationQuickBody block={BLOCK} onOpenRun={vi.fn()} />))
    expect(screen.queryByTestId('quick-run-row')).toBeNull()
    expect(screen.getByText('Never ran')).toBeTruthy()
    traces = [FAILED]
  })
})

describe('ActionQuickBody', () => {
  it('runs the action from the modal and lists its executions without a run link', () => {
    render(wrap(<ActionQuickBody entry={ACTION} />))
    expect(screen.getByTestId('quick-run-row')).toBeTruthy()
    expect(screen.queryByTestId('quick-run-open')).toBeNull()
    fireEvent.click(screen.getByTestId('quick-action-run'))
    expect(runMutate).toHaveBeenCalledWith({ actionId: 'internal:abc' })
  })

  it('does not offer a run while it is already running', () => {
    render(
      wrap(
        <ActionQuickBody
          entry={{ ...ACTION, status: { isRunning: true, lastRunAt: 1, lastError: null } }}
        />,
      ),
    )
    expect((screen.getByTestId('quick-action-run') as HTMLButtonElement).disabled).toBe(true)
  })
})
