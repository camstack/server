/**
 * The rules → History handoff, end to end through the tab host.
 *
 * The rules page never reaches for the router (its `onOpenHistory` prop is how
 * it asks); the host turns that into `?tab=history&ruleId=…`, and the History
 * tab opens on it. Every page but those two is stubbed — this pins the WIRING,
 * the pages have their own specs.
 */
import type { NcRule } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useSearchParams } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const RULE: Pick<NcRule, 'id' | 'name'> = { id: 'r-42', name: 'Front door' }

interface RulesStubProps {
  readonly onOpenHistory?: (rule: Pick<NcRule, 'id' | 'name'>) => void
}

vi.mock('../NotificationRules', () => ({
  NotificationRulesPage: ({ onOpenHistory }: RulesStubProps) => (
    <button type="button" onClick={() => onOpenHistory?.(RULE)}>
      open history
    </button>
  ),
}))

function HistoryStub() {
  const [params] = useSearchParams()
  return <div data-testid="history-stub">{params.get('ruleId') ?? 'none'}</div>
}

vi.mock('../NotificationHistory', () => ({ NotificationHistoryPage: HistoryStub }))
vi.mock('../NotificationTargets', () => ({ NotificationTargetsPage: () => null }))
vi.mock('../NotificationSimulate', () => ({ NotificationSimulatePage: () => null }))
vi.mock('../NotificationAlarm', () => ({ NotificationAlarmPage: () => null }))
vi.mock('../NotificationSummaries', () => ({ NotificationSummariesPage: () => null }))
vi.mock('../NotificationTimelapses', () => ({ NotificationTimelapsesPage: () => null }))
vi.mock('../NotificationTexts', () => ({ NotificationTextsPage: () => null }))
vi.mock('../NotificationSequences', () => ({
  NotificationSequencesPage: () => null,
  SEQUENCES_TAB_OWNED_PARAMS: ['sequence', 'new'] as const,
}))

import { NotificationsPage } from '../Notifications'

describe('Notifications — a rule row opens its own History', () => {
  it('switches to the History tab with that rule in the URL', () => {
    render(
      <MemoryRouter initialEntries={['/system/notifications?tab=rules']}>
        <NotificationsPage />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByText('open history'))
    expect(screen.getByTestId('history-stub').textContent).toBe('r-42')
  })

  it('leaving the History tab drops the rule, so the tab itself opens on every rule', () => {
    render(
      <MemoryRouter initialEntries={['/system/notifications?tab=rules']}>
        <NotificationsPage />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByText('open history'))
    expect(screen.getByTestId('history-stub').textContent).toBe('r-42')
    // Away and back through the tab strip — not through a rule row.
    fireEvent.click(screen.getByTestId('section-rules'))
    fireEvent.click(screen.getByTestId('section-history'))
    expect(screen.getByTestId('history-stub').textContent).toBe('none')
  })
})
