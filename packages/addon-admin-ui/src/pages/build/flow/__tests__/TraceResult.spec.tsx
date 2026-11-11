import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '../../../../i18n'
import { ConditionResult, StepResult } from '../TraceResult'
import type { ConditionNodeView, StepDetailView } from '../trace-view'

const NODE: ConditionNodeView = {
  path: 'when.1',
  depth: 1,
  kind: 'device-is',
  outcome: 'fail',
  reason: 'weight below 10 g',
  subject: 'scale.weight',
  operator: 'gt',
  deviceId: 5,
  expected: null,
  observed: null,
}

describe('ConditionResult', () => {
  it('shows the outcome, the reason and observed against expected inside the row', () => {
    render(
      <ConditionResult
        node={NODE}
        expected={{ kind: 'value', text: '10 g' }}
        observed={{ kind: 'value', text: '40 g' }}
      />,
    )
    const box = within(screen.getByTestId('trace-result'))
    expect(box.getByText('Failed')).toBeTruthy()
    expect(box.getByText('weight below 10 g')).toBeTruthy()
    expect(within(screen.getByTestId('trace-expected')).getByText('10 g')).toBeTruthy()
    expect(within(screen.getByTestId('trace-observed')).getByText('40 g')).toBeTruthy()
  })

  it('shows an unread value as unknown', () => {
    render(
      <ConditionResult
        node={NODE}
        expected={{ kind: 'value', text: '10 g' }}
        observed={{ kind: 'unknown' }}
      />,
    )
    expect(screen.getByTestId('trace-value-unknown').textContent).toBe('unknown')
  })

  it('carries the trigger vars on the event row', () => {
    render(
      <ConditionResult
        node={{ ...NODE, kind: 'detection', outcome: 'pass' }}
        expected={null}
        observed={null}
        vars={[
          { name: 'className', value: { kind: 'value', text: 'animal' } },
          { name: 'score', value: { kind: 'value', text: '0' } },
        ]}
      />,
    )
    const vars = within(screen.getByTestId('trace-vars'))
    expect(vars.getByText('className')).toBeTruthy()
    expect(vars.getByText('animal')).toBeTruthy()
    // A real zero stays a zero.
    expect(vars.getByText('0')).toBeTruthy()
  })
})

describe('StepResult', () => {
  const STEP: StepDetailView = {
    index: 0,
    kind: 'cap',
    tone: 'fail',
    message: 'Feeder offline',
    args: [{ name: 'grams', value: { kind: 'value', text: '30' } }],
    devices: [
      { deviceId: 1, tone: 'pass', message: null },
      { deviceId: 2, tone: 'fail', message: 'timeout' },
    ],
    chose: null,
    nested: [],
    rounds: null,
  }

  it('a choose step names the branch that ran and lists its steps (#500)', () => {
    render(
      <StepResult
        step={{
          ...STEP,
          kind: 'choose',
          tone: 'pass',
          message: null,
          args: [],
          devices: [],
          chose: { kind: 'branch', index: 1 },
          nested: [
            { kind: 'wait', tone: 'pass', message: null },
            { kind: 'cap', tone: 'fail', message: 'Lamp offline' },
          ],
        }}
        deviceName={(id) => `#${String(id)}`}
      />,
    )
    expect(screen.getByTestId('step-chose').textContent).toContain('2')
    const nested = within(screen.getByTestId('step-nested'))
    expect(nested.getByText('Lamp offline')).toBeTruthy()
    expect(nested.getAllByRole('listitem')).toHaveLength(2)
  })

  it('a step that is not a choose shows no branch line', () => {
    render(<StepResult step={STEP} deviceName={(id) => `#${String(id)}`} />)
    expect(screen.queryByTestId('step-chose')).toBeNull()
    expect(screen.queryByTestId('step-nested')).toBeNull()
  })

  it('shows outcome, message, args and the per-device outcome inside the card', () => {
    render(<StepResult step={STEP} deviceName={(id) => (id === 1 ? 'Feeder' : `#${String(id)}`)} />)
    const box = within(screen.getByTestId('step-result'))
    expect(box.getByText('Error')).toBeTruthy()
    expect(box.getByText('Feeder offline')).toBeTruthy()
    expect(within(screen.getByTestId('step-args')).getByText('30')).toBeTruthy()
    const devices = within(screen.getByTestId('step-devices'))
    expect(devices.getByText('Feeder')).toBeTruthy()
    expect(devices.getByText('#2')).toBeTruthy()
    expect(devices.getByText('timeout')).toBeTruthy()
  })
})
