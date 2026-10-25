// @vitest-environment jsdom
/**
 * Unanswered history is not "no history" (D315). The section appears only
 * after the series list answers with at least one series.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const series = vi.hoisted(() => ({
  presence: 'pending' as 'pending' | 'present' | 'absent' | 'unknown',
  list: { status: 'pending' } as
    | { status: 'pending' }
    | { status: 'error'; error: string }
    | { status: 'ok'; data: readonly { key: string; scope: string }[] },
}))

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useDeviceSeriesList: () => series,
  DeviceHistoryView: () => <div data-testid="history-view" />,
}))

import { DeviceQuickHistory } from '../DeviceQuickHistory'

function renderHistory(): void {
  render(
    <MemoryRouter>
      <DeviceQuickHistory deviceId={7} />
    </MemoryRouter>,
  )
}

describe('DeviceQuickHistory', () => {
  it('shows a skeleton while the list has not answered, and nothing when it answered empty', () => {
    series.presence = 'pending'
    series.list = { status: 'pending' }
    const pending = render(
      <MemoryRouter>
        <DeviceQuickHistory deviceId={7} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('generic', { busy: true })).toBeTruthy()
    expect(screen.queryByText('History')).toBeNull()
    pending.unmount()

    series.presence = 'present'
    series.list = { status: 'ok', data: [] }
    renderHistory()
    expect(screen.queryByText('History')).toBeNull()
    expect(screen.queryByTestId('history-view')).toBeNull()
  })

  it('shows one history view and a link once series exist', () => {
    series.presence = 'present'
    series.list = { status: 'ok', data: [{ key: 'cap:climate.temperature', scope: '' }] }
    renderHistory()
    expect(screen.getByTestId('history-view')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Open full history' })
    const href = link.getAttribute('href') ?? ''
    expect(href).toContain('/system/history')
    expect(decodeURIComponent(decodeURIComponent(href))).toContain('cap:climate.temperature')
  })
})
