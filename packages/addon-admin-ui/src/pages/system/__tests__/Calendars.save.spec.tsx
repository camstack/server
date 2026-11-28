/**
 * The legend's visibility and colour edits are one draft with one Save (planning#675). A save
 * that fails keeps the draft and names the reason.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const st = vi.hoisted(() => ({ setPref: vi.fn() }))

vi.mock('@dominevo/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dominevo/ui-library')>()),
  useCalendarsListCalendars: () => ({
    isPending: false,
    isError: false,
    isSuccess: true,
    data: [
      {
        id: 'google-services:g1:work@g',
        providerAddonId: 'google-services',
        instanceId: 'cal_a',
        name: 'Work',
        source: 'addon',
        enabled: true,
        visible: true,
        defaultColor: '#3B82F6',
        color: '#3B82F6',
      },
    ],
  }),
  useCalendarsGetPreferences: () => ({
    isSuccess: true,
    data: { calendars: {} },
    refetch: vi.fn(),
  }),
  useCalendarsSetCalendarPreference: () => ({ mutateAsync: st.setPref, isPending: false }),
  useCalendarsListEvents: () => ({ isPending: false, isError: false, data: [] }),
}))
vi.mock('../../../components/instances/use-instances-data', () => ({
  HOLDER_QUERY_KEY: 'provider-instances-holder',
  useInstancesData: () => ({
    state: 'ready',
    error: null,
    holders: [],
    displayNames: new Map(),
    rows: [],
    functionProviders: [],
    descriptions: new Map(),
    refetch: vi.fn(),
  }),
}))
vi.mock('../../../components/AdminPage', () => ({
  AdminPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { CalendarsPage } from '../Calendars'

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <CalendarsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function visibleToggle(): HTMLElement {
  const toggle = screen
    .getAllByTestId(/^calendars-visible-/)
    .find((el) => el.tagName === 'INPUT' || el.getAttribute('role') === 'checkbox')
  if (toggle === undefined) throw new Error('no visibility toggle')
  return toggle
}

describe('Calendars legend save', () => {
  beforeEach(() => {
    st.setPref.mockReset()
  })

  it('a failed save keeps the draft and shows the reason', async () => {
    st.setPref.mockImplementation(async () => {
      throw new Error('provider refused')
    })
    mount()
    fireEvent.click(visibleToggle())
    expect(st.setPref).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.getByTestId('calendars-save-error').textContent).toContain('provider refused'),
    )
    // The draft is still pending: Save is still offered.
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('Discard drops the draft and the error', async () => {
    st.setPref.mockImplementation(async () => {
      throw new Error('provider refused')
    })
    mount()
    fireEvent.click(visibleToggle())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByTestId('calendars-save-error')
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByTestId('calendars-save-error')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })
})
