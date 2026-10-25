/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

const markReadMutate = vi.fn()

const { state } = vi.hoisted(() => ({
  state: {
    alerts: [] as readonly Record<string, unknown>[],
  },
}))

vi.mock('@camstack/ui-library', () => ({
  useClusterNodes: () => ({ nodes: [], isLoading: false, isError: false }),
  useAlertsGetUnreadCount: () => ({ data: 1 }),
  useAlertsList: () => ({ data: state.alerts, isLoading: false }),
  useAlertsMarkRead: () => ({ mutate: markReadMutate }),
  useAlertsMarkAllRead: () => ({ mutate: vi.fn() }),
  useAlertsDismiss: () => ({ mutate: vi.fn() }),
  useLiveEvent: () => undefined,
}))

import { AlertBell } from '../AlertBell'

function renderBell(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AlertBell />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function openAlertsPanel(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Alerts' }))
}

const base = {
  category: 'test',
  status: 'active' as const,
  read: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

beforeEach(() => {
  markReadMutate.mockClear()
  state.alerts = []
})

describe('AlertBell critical / urgent section', () => {
  it('places an unread critical alert in Urgent, not an error alert', () => {
    state.alerts = [
      {
        id: 'crit-1',
        severity: 'critical',
        title: 'Google needs a new sign-in',
        message: 'Reconnect your broker.',
        ...base,
      },
      {
        id: 'err-1',
        severity: 'error',
        title: 'Something failed',
        message: 'Details here.',
        ...base,
      },
    ]
    renderBell()
    openAlertsPanel()
    expect(screen.getByText('Urgent')).toBeInTheDocument()
    expect(screen.getByText('Google needs a new sign-in')).toBeInTheDocument()
    expect(screen.getByText('Something failed')).toBeInTheDocument()
    const urgentHeader = screen.getByText('Urgent')
    const urgentSection = urgentHeader.parentElement?.parentElement
    expect(urgentSection).toBeTruthy()
    expect(urgentSection).toContainElement(screen.getByText('Google needs a new sign-in'))
    expect(urgentSection).not.toContainElement(screen.getByText('Something failed'))
  })
})
