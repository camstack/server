/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

const markReadMutate = vi.fn()

const { state } = vi.hoisted(() => ({
  state: {
    alerts: [] as readonly Record<string, unknown>[],
    isLoading: false,
  },
}))

vi.mock('@camstack/ui-library', () => ({
  Button: (props: { children?: string; onClick?: () => void }) =>
    createElement('button', { type: 'button', onClick: props.onClick }, props.children),
  IconButton: (props: { 'data-testid'?: string; 'aria-label'?: string; onClick?: () => void }) =>
    createElement('button', {
      type: 'button',
      'data-testid': props['data-testid'],
      'aria-label': props['aria-label'],
      onClick: props.onClick,
    }),
  useAlertsList: () => ({ data: state.alerts, isLoading: state.isLoading }),
  useAlertsMarkRead: () => ({ mutate: markReadMutate }),
}))

import { resetCriticalAlertsPanelDismissedForTests } from '../critical-alerts'
import { CriticalAlertsOnLoadPanel } from '../CriticalAlertsOnLoadPanel'

function renderPanel(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <CriticalAlertsOnLoadPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const criticalAlert = {
  id: 'crit-panel',
  category: 'google.broker-reconnect',
  severity: 'critical' as const,
  title: 'Google needs a new sign-in',
  message: 'Sign in again to restore sync.',
  status: 'active' as const,
  read: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

beforeEach(() => {
  markReadMutate.mockClear()
  resetCriticalAlertsPanelDismissedForTests()
  state.isLoading = false
  state.alerts = []
})

describe('CriticalAlertsOnLoadPanel', () => {
  it('shows for unread critical, stays on outside click, closes without markRead', () => {
    state.alerts = [criticalAlert]
    renderPanel()
    expect(screen.getByTestId('critical-alerts-on-load-panel')).toBeInTheDocument()
    expect(screen.getByText('Google needs a new sign-in')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.getByTestId('critical-alerts-on-load-panel')).toBeInTheDocument()
    expect(markReadMutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('critical-alerts-panel-close'))
    expect(screen.queryByTestId('critical-alerts-on-load-panel')).not.toBeInTheDocument()
    expect(markReadMutate).not.toHaveBeenCalled()
  })

  it('mark as read calls markRead and leaves the panel open', () => {
    state.alerts = [criticalAlert]
    renderPanel()
    fireEvent.click(screen.getByText('Mark as read'))
    expect(markReadMutate).toHaveBeenCalledWith({ alertId: 'crit-panel' })
    expect(screen.getByTestId('critical-alerts-on-load-panel')).toBeInTheDocument()
  })

  it('does not render when only non-critical alerts exist', () => {
    state.alerts = [
      {
        ...criticalAlert,
        id: 'warn-1',
        severity: 'warning',
        title: 'Heads up',
      },
    ]
    renderPanel()
    expect(screen.queryByTestId('critical-alerts-on-load-panel')).not.toBeInTheDocument()
  })

  it('does not render while alerts are still loading', () => {
    state.isLoading = true
    state.alerts = [criticalAlert]
    renderPanel()
    expect(screen.queryByTestId('critical-alerts-on-load-panel')).not.toBeInTheDocument()
  })
})
