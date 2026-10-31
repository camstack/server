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
    expect(summary.getByText('Feeder offline')).toBeTruthy()
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
})
