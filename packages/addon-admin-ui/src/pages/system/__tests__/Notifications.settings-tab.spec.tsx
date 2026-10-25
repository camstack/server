/**
 * Notifications → Settings mounts Alert Center global settings.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../NotificationRules', () => ({ NotificationRulesPage: () => null }))
vi.mock('../NotificationHistory', () => ({ NotificationHistoryPage: () => null }))
vi.mock('../NotificationTargets', () => ({ NotificationTargetsPage: () => null }))
vi.mock('../NotificationSimulate', () => ({ NotificationSimulatePage: () => null }))
vi.mock('../NotificationAlarm', () => ({ NotificationAlarmPage: () => null }))
vi.mock('../NotificationSequences', () => ({
  NotificationSequencesPage: () => null,
  SEQUENCES_TAB_OWNED_PARAMS: ['sequence', 'new'] as const,
}))
vi.mock('../NotificationTexts', () => ({ NotificationTextsPage: () => null }))
vi.mock('../NotificationSettings', () => ({
  NotificationSettingsPage: () => <div data-testid="notification-settings">settings</div>,
}))

import { NotificationsPage } from '../Notifications'

describe('Notifications — Settings tab', () => {
  it('exposes Settings and deep-links ?tab=settings', () => {
    render(
      <MemoryRouter initialEntries={['/system/notifications?tab=settings']}>
        <NotificationsPage />
      </MemoryRouter>,
    )
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByTestId('notification-settings')).toBeTruthy()
  })
})
