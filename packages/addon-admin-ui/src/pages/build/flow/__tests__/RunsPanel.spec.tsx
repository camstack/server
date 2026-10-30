import type { AutomationRunTrace } from '@camstack/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '../../../../i18n'
import { RunsPanel } from '../RunsPanel'

const TRACE: AutomationRunTrace = {
  runId: 'r1',
  startedAt: 1,
  endedAt: 2,
  trigger: { kind: 'detection', outcome: 'pass', reason: 'animal seen', vars: { score: 0 } },
  conditions: [
    {
      path: 'when.0',
      kind: 'device-is',
      outcome: 'fail',
      reason: 'hopperLevel is unknown',
      cap: 'pet-feeder',
      fieldPath: 'hopperLevel',
      operator: 'gt',
      expected: 10,
      observed: null,
    },
  ],
  steps: [
    {
      path: 'actions.0',
      kind: 'action',
      outcome: 'error',
      message: 'Feeder offline',
      args: { grams: 30 },
    },
  ],
  outcome: 'failed',
  repeat: 1,
  lastAt: 2,
}

describe('RunsPanel', () => {
  it('expands the selected run to its values and shows an unread value as unknown', () => {
    const { rerender } = render(
      <RunsPanel traces={[TRACE]} selectedId={null} onSelect={() => {}} />,
    )
    expect(screen.queryByTestId('run-details')).toBeNull()

    rerender(<RunsPanel traces={[TRACE]} selectedId="r1" onSelect={() => {}} />)
    const details = within(screen.getByTestId('run-details'))
    // A real zero stays a zero; a missing reading is not one.
    expect(details.getByText('score')).toBeTruthy()
    expect(details.getByText('0')).toBeTruthy()
    expect(details.getByText('10')).toBeTruthy()
    expect(details.getByTestId('trace-value-unknown').textContent).toBe('unknown')
    expect(details.getByText('Feeder offline')).toBeTruthy()
    // What the step sent sits next to it.
    const args = within(details.getByTestId('step-args'))
    expect(args.getByText('grams')).toBeTruthy()
    expect(args.getByText('30')).toBeTruthy()
  })

  it('selecting a run calls onSelect with its id', () => {
    const picked: (string | null)[] = []
    render(<RunsPanel traces={[TRACE]} selectedId={null} onSelect={(id) => picked.push(id)} />)
    fireEvent.click(screen.getByRole('button', { name: /animal seen/ }))
    expect(picked).toEqual(['r1'])
  })
})
