/**
 * Page-header Add / New rule must follow the Rules area strip (`?section=`),
 * even though the strip writes via `useUrlQueryParam` and the host used to
 * read react-router `searchParams` (stale → stuck on "New rule").
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { useUrlQueryParam } from '@camstack/ui-library'

vi.mock('../NotificationRules', () => ({
  NotificationRulesPage: () => {
    const [, setSection] = useUrlQueryParam('section')
    return (
      <div data-testid="rules-stub">
        <button type="button" onClick={() => setSection('detection')}>
          go detection
        </button>
        <button type="button" onClick={() => setSection('summaries')}>
          go summaries
        </button>
        <button type="button" onClick={() => setSection(null)}>
          go all
        </button>
      </div>
    )
  },
}))

vi.mock('../NotificationHistory', () => ({ NotificationHistoryPage: () => null }))
vi.mock('../NotificationTargets', () => ({ NotificationTargetsPage: () => null }))
vi.mock('../NotificationSimulate', () => ({ NotificationSimulatePage: () => null }))
vi.mock('../NotificationAlarm', () => ({ NotificationAlarmPage: () => null }))
vi.mock('../NotificationSequences', () => ({
  NotificationSequencesPage: () => null,
  SEQUENCES_TAB_OWNED_PARAMS: ['sequence', 'new'] as const,
}))
vi.mock('../NotificationTexts', () => ({ NotificationTextsPage: () => null }))
vi.mock('../NotificationSettings', () => ({ NotificationSettingsPage: () => null }))

import { NotificationsPage } from '../Notifications'

describe('Notifications — header create follows Rules area', () => {
  it('retargets New rule → New detection rule → New summary when section changes', async () => {
    render(
      <MemoryRouter initialEntries={['/system/notifications?tab=rules']}>
        <NotificationsPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('rules-new-menu')).toBeTruthy()
    expect(screen.getByRole('button', { name: /New rule/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'go detection' }))
    await waitFor(() => expect(screen.getByTestId('rules-new-detection')).toBeTruthy())
    expect(screen.getByRole('button', { name: /New detection rule/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'go summaries' }))
    await waitFor(() => expect(screen.getByTestId('summary-new')).toBeTruthy())
    expect(screen.getByRole('button', { name: /New summary/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'go all' }))
    await waitFor(() => expect(screen.getByTestId('rules-new-menu')).toBeTruthy())
  })

  it('shows Add target on the Targets tab, not a Rules create', () => {
    render(
      <MemoryRouter initialEntries={['/system/notifications?tab=targets']}>
        <NotificationsPage />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('notifications-add-target')).toBeTruthy()
    expect(screen.queryByTestId('rules-new-menu')).toBeNull()
  })
})
