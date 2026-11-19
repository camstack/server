import type { AutomationRunTrace } from '@camstack/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import { RunsPanel } from '../RunsPanel'

const TRACE: AutomationRunTrace = {
  runId: 'r1',
  startedAt: 1,
  endedAt: 2,
  trigger: { kind: 'detection', outcome: 'pass', reason: 'animal seen', vars: { score: 0 } },
  conditions: [],
  steps: [
    { path: 'actions.0', kind: 'cap', outcome: 'ok' },
    { path: 'actions.1', kind: 'action', outcome: 'error', message: 'Feeder offline' },
  ],
  outcome: 'failed',
  repeat: 1,
  lastAt: 2,
}

function mockNarrow(narrow: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches: narrow && query.includes('max-width: 767px'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('RunsPanel', () => {
  it('keeps the list and one summary line, never the values (those live in the blocks)', () => {
    render(<RunsPanel traces={[TRACE]} selectedId="r1" onSelect={() => {}} />)
    expect(screen.queryByTestId('run-details')).toBeNull()
    const summary = within(screen.getByTestId('run-summary'))
    expect(summary.getByText('Failed')).toBeTruthy()
    expect(within(screen.getByTestId('run-failure')).getByText('Feeder offline')).toBeTruthy()
    expect(summary.getByText('1 of 2 steps ran')).toBeTruthy()
    // The trigger vars are not repeated in the panel.
    expect(screen.queryByText('score')).toBeNull()
  })

  it('selecting a run calls onSelect with its id', () => {
    const picked: (string | null)[] = []
    render(<RunsPanel traces={[TRACE]} selectedId={null} onSelect={(id) => picked.push(id)} />)
    fireEvent.click(screen.getByRole('button', { name: /animal seen/ }))
    expect(picked).toEqual(['r1'])
  })

  it('starts open on a wide screen, with a list that scrolls inside itself', () => {
    mockNarrow(false)
    render(<RunsPanel traces={[TRACE]} selectedId={null} onSelect={() => {}} />)
    expect(screen.getByTestId('runs-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('runs-panel').className).toMatch(/max-h-/)
    expect(screen.getByTestId('runs-panel').className).toMatch(/overflow-y-auto/)
  })

  it('starts COLLAPSED on a phone and opens on demand', () => {
    mockNarrow(true)
    render(<RunsPanel traces={[TRACE]} selectedId={null} onSelect={() => {}} />)
    expect(screen.getByTestId('runs-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('runs-panel')).toBeNull()
    fireEvent.click(screen.getByTestId('runs-toggle'))
    expect(screen.getByTestId('runs-panel')).toBeTruthy()
  })

  it('a collapsed panel still says what the selected run decided', () => {
    mockNarrow(true)
    render(<RunsPanel traces={[TRACE]} selectedId="r1" onSelect={() => {}} />)
    expect(screen.queryByTestId('runs-panel')).toBeNull()
    expect(screen.getByTestId('run-summary')).toBeTruthy()
  })

  it('shows the failure in an alert box, with the cause a block step hides', () => {
    const nested: AutomationRunTrace = {
      ...TRACE,
      steps: [
        {
          path: 'actions.0',
          kind: 'choose',
          outcome: 'error',
          message: 'a step of the branch failed',
          steps: [
            {
              path: 'actions.0.0',
              kind: 'action',
              outcome: 'error',
              message: 'pump refused: no provider',
            },
          ],
        },
      ],
    }
    render(<RunsPanel traces={[nested]} selectedId="r1" onSelect={() => {}} />)
    const alert = within(screen.getByTestId('run-failure'))
    expect(alert.getByText('pump refused: no provider')).toBeTruthy()
    expect(alert.getByRole('alert')).toBeTruthy()
  })

  it('lists ONE row for a hold episode: the pending row folds into its run', () => {
    const held = (
      id: string,
      phase: 'pending' | 'fired',
      outcome: AutomationRunTrace['outcome'],
    ) => ({
      ...TRACE,
      runId: id,
      outcome,
      steps: [],
      trigger: {
        ...TRACE.trigger,
        path: 'when.0',
        reason: phase === 'pending' ? 'hold pending' : 'held for 10 min',
        hold: { phase, ms: 600000, mode: 'held' as const, since: 100 },
      },
    })
    render(
      <RunsPanel
        traces={[held('p', 'pending', 'skipped-trigger'), held('r', 'fired', 'ran')]}
        selectedId={null}
        onSelect={() => {}}
      />,
    )
    expect(screen.getAllByRole('button', { name: /hold|held/ })).toHaveLength(1)
    expect(screen.queryByText('hold pending')).toBeNull()
  })

  it('lists every condition with what it read, what it wanted and the result', () => {
    const withConditions: AutomationRunTrace = {
      ...TRACE,
      outcome: 'ran',
      conditions: [
        { path: 'when', kind: 'all', outcome: 'pass', reason: '' },
        {
          path: 'when.0',
          kind: 'device-is',
          outcome: 'pass',
          reason: 'level 80, expected < 90 → pass',
          cap: 'sensor',
          fieldPath: 'level',
          operator: 'lt',
          deviceId: 5,
          expected: 90,
          observed: 80,
        },
        {
          path: 'when.1',
          kind: 'device-is',
          outcome: 'fail',
          reason: 'bowl value unknown → fail',
          cap: 'sensor',
          fieldPath: 'bowl',
          operator: 'eq',
          expected: 'empty',
          observed: null,
        },
      ],
      steps: [],
    }
    render(<RunsPanel traces={[withConditions]} selectedId="r1" onSelect={() => {}} />)
    const rows = screen.getAllByTestId('run-condition')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByTestId('trace-observed').textContent).toContain('80')
    expect(within(rows[0]!).getByTestId('trace-expected').textContent).toContain('90')
    expect(within(rows[0]!).getByText('Passed')).toBeTruthy()
    expect(within(rows[1]!).getByTestId('trace-value-unknown')).toBeTruthy()
    expect(within(rows[1]!).getByText('Failed')).toBeTruthy()
  })
})
