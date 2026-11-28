/**
 * The quick modal's tabs are lazy (nothing of Exporters or Last runs is
 * requested at modal open), and "Started by" names the caller of a run:
 * pending is a skeleton, an id that does not resolve says "unknown (id)".
 */
import type { AutomationRunTrace } from '@dominevo/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import { BuildQuickModal, type BuildQuickModalProps } from '../BuildQuickModal'
import { ActionLastRuns } from '../quick-bodies/QuickLastRuns'
import { QuickRunList } from '../QuickParts'
import { startedByOf } from '../quick-runs'

type BlockAnswer =
  | { readonly kind: 'pending' }
  | { readonly kind: 'error' }
  | { readonly kind: 'block'; readonly name: string | null }

const calls = { traces: 0, exporters: 0, block: 0 }
let blockAnswer: BlockAnswer = { kind: 'pending' }

function actionTrace(blockId: string | null): AutomationRunTrace {
  return {
    runId: 'r1',
    startedAt: 1000,
    endedAt: 1500,
    trigger: {
      kind: 'action',
      outcome: 'pass',
      reason: blockId === null ? 'started by the system' : `started by automation ${blockId}`,
      vars: blockId === null ? {} : { blockId },
    },
    conditions: [],
    steps: [],
    outcome: 'ran',
    repeat: 1,
    lastAt: 1500,
  }
}

vi.mock('@dominevo/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dominevo/ui-library')>()),
  useActionsGetTraces: () => {
    calls.traces += 1
    return { data: { traces: [actionTrace('blk-1')] }, error: null }
  },
  useCoreBlocksGet: () => {
    calls.block += 1
    switch (blockAnswer.kind) {
      case 'pending':
        return { isPending: true, data: undefined }
      case 'error':
        return { isPending: false, data: undefined, error: new Error('x') }
      default:
        return {
          isPending: false,
          data: {
            block: blockAnswer.name === null ? null : { name: blockAnswer.name },
          },
        }
    }
  },
}))

function Exporters(): React.ReactNode {
  calls.exporters += 1
  return <p data-testid="exporters-panel">exporters</p>
}

function shell(patch: Partial<BuildQuickModalProps> = {}): BuildQuickModalProps {
  return {
    subjectKey: 'a',
    name: 'Feed',
    tags: [],
    saving: false,
    error: null,
    onSave: vi.fn(),
    openLabel: 'Open',
    onOpen: vi.fn(),
    onClose: vi.fn(),
    children: <p>body</p>,
    ...patch,
  }
}

function wrap(node: React.ReactNode): React.ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  calls.traces = 0
  calls.exporters = 0
  calls.block = 0
  blockAnswer = { kind: 'pending' }
})

describe('lazy tabs', () => {
  it('mounts neither Exporters nor Last runs at open, each only when its tab opens', () => {
    render(
      wrap(
        <BuildQuickModal
          {...shell({
            exporters: <Exporters />,
            lastRuns: <ActionLastRuns actionId="internal:abc" />,
          })}
        />,
      ),
    )
    expect(screen.getByText('body')).toBeTruthy()
    expect(calls.exporters).toBe(0)
    expect(calls.traces).toBe(0)

    fireEvent.click(screen.getByTestId('quick-tab-exporters'))
    expect(calls.exporters).toBeGreaterThan(0)
    expect(calls.traces).toBe(0)
    expect(screen.queryByText('body')).toBeNull()

    fireEvent.click(screen.getByTestId('quick-tab-runs'))
    expect(calls.traces).toBeGreaterThan(0)
    expect(screen.queryByTestId('exporters-panel')).toBeNull()
  })

  it('draws no tab strip for a kind with neither panel', () => {
    render(wrap(<BuildQuickModal {...shell()} />))
    expect(screen.queryByTestId('quick-tab-settings')).toBeNull()
    expect(screen.getByText('body')).toBeTruthy()
  })
})

describe('started by', () => {
  it('reads the automation id off an action trace', () => {
    expect(startedByOf(actionTrace('blk-1'))).toEqual({
      kind: 'automation',
      blockId: 'blk-1',
    })
    expect(startedByOf(actionTrace(null))).toBeNull()
  })

  it('shows the automation name, never its id', () => {
    blockAnswer = { kind: 'block', name: 'Night lights' }
    render(
      wrap(
        <QuickRunList traces={[actionTrace('blk-1')]} failed={false} emptyLabel="-" kind="run" />,
      ),
    )
    const row = screen.getByTestId('quick-run-row')
    expect(screen.getByTestId('quick-started-by-name').textContent).toBe('Night lights')
    expect(row.textContent).not.toContain('blk-1')
  })

  it('shows a pending state, not the id, while the name is unanswered', () => {
    render(
      wrap(
        <QuickRunList traces={[actionTrace('blk-1')]} failed={false} emptyLabel="-" kind="run" />,
      ),
    )
    expect(screen.getByTestId('quick-started-by-pending')).toBeTruthy()
    expect(screen.getByTestId('quick-run-row').textContent).not.toContain('blk-1')
  })

  it('says "unknown (id)" for a block that is gone or a lookup that failed', () => {
    blockAnswer = { kind: 'block', name: null }
    const { unmount } = render(
      wrap(
        <QuickRunList traces={[actionTrace('blk-1')]} failed={false} emptyLabel="-" kind="run" />,
      ),
    )
    expect(screen.getByTestId('quick-started-by-unknown').textContent).toBe('unknown (blk-1)')
    unmount()
    blockAnswer = { kind: 'error' }
    render(
      wrap(
        <QuickRunList traces={[actionTrace('blk-1')]} failed={false} emptyLabel="-" kind="run" />,
      ),
    )
    expect(screen.getByTestId('quick-started-by-unknown').textContent).toBe('unknown (blk-1)')
  })
})
