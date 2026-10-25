/**
 * The simulator's answer panel.
 *
 * The property under test is the one the panel exists for: a run that produced
 * NO notification must read as an answer. An empty box would send the operator
 * looking for a bug in a rule that is behaving exactly as written.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { NotificationSimulateResultPanel } from '../NotificationSimulateResult'
import { parseSimulateResult, type NcSimulateResult } from '../notification-simulate.helpers'

function result(overrides: Record<string, unknown> = {}): NcSimulateResult {
  const parsed = parseSimulateResult({
    recordId: 'synthetic:abc',
    origin: 'synthetic',
    delivery: 'immediate',
    candidates: 0,
    outcomes: [],
    still: 'live',
    notes: [],
    ...overrides,
  })
  if (parsed === null) throw new Error('fixture is not a valid result')
  return parsed
}

const targetName = (id: string): string => (id === 't1' ? 'Alerts' : id)

describe('NotificationSimulateResultPanel', () => {
  it('states WHY nothing was evaluated instead of rendering an empty list', () => {
    render(<NotificationSimulateResultPanel result={result()} targetName={targetName} />)
    expect(screen.getByText(/No enabled rule declares the "immediate" delivery/)).toBeTruthy()
    expect(screen.getByText(/No rule was evaluated/)).toBeTruthy()
  })

  it('shows the record id — the grep key — and every note verbatim', () => {
    render(
      <NotificationSimulateResultPanel
        result={result({ notes: ['A still was taken.', 'The rule was muted.'] })}
        targetName={targetName}
      />,
    )
    expect(screen.getByText('synthetic:abc')).toBeTruthy()
    expect(screen.getByText('A still was taken.')).toBeTruthy()
    expect(screen.getByText('The rule was muted.')).toBeTruthy()
  })

  it('names the FIRST failing condition on a rule that did not match', () => {
    render(
      <NotificationSimulateResultPanel
        result={result({
          candidates: 1,
          outcomes: [
            {
              ruleId: 'r1',
              ruleName: 'Front door',
              matched: false,
              failedCondition: 'minConfidence',
              cooldown: 'n/a',
              enqueued: 0,
              targetIds: [],
            },
          ],
        })}
        targetName={targetName}
      />,
    )
    expect(screen.getByText('minConfidence')).toBeTruthy()
    expect(screen.getByText(/cooldown: n\/a/)).toBeTruthy()
  })

  it('reports the enqueued rows and the targets they went to', () => {
    render(
      <NotificationSimulateResultPanel
        result={result({
          candidates: 1,
          outcomes: [
            {
              ruleId: 'r1',
              ruleName: 'Front door',
              matched: true,
              cooldown: 'bypassed',
              enqueued: 2,
              targetIds: ['t1', 't9'],
            },
          ],
        })}
        targetName={targetName}
      />,
    )
    expect(screen.getByText(/2 outbox rows enqueued → Alerts, t9/)).toBeTruthy()
    expect(screen.getByText(/cooldown: bypassed/)).toBeTruthy()
  })

  it('says a matched rule with no target will deliver nothing', () => {
    render(
      <NotificationSimulateResultPanel
        result={result({
          candidates: 1,
          outcomes: [
            {
              ruleId: 'r1',
              ruleName: 'Front door',
              matched: true,
              cooldown: 'clear',
              enqueued: 0,
              targetIds: [],
            },
          ],
        })}
        targetName={targetName}
      />,
    )
    expect(screen.getByText(/no target resolved, so nothing will be delivered/)).toBeTruthy()
  })

  it('surfaces a drop that happened before any rule was consulted', () => {
    render(
      <NotificationSimulateResultPanel
        result={result({ droppedBy: 'muted' })}
        targetName={targetName}
      />,
    )
    expect(screen.getByText(/Dropped before evaluation \(muted\)/)).toBeTruthy()
    expect(screen.getByText(/dropped: muted/)).toBeTruthy()
  })
})
