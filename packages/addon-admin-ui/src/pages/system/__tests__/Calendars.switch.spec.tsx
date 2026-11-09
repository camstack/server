/**
 * One Calendars list: a switched-off calendar stays in it (muted, with its switch), and "no
 * sources yet" is only for zero calendar records, never for "every calendar is off".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const st = vi.hoisted(() => ({ holders: [] as unknown[], state: 'ready' as string }))

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useCalendarsListCalendars: () => ({
    isPending: false,
    isError: false,
    isSuccess: true,
    data: [],
  }),
  useCalendarsGetPreferences: () => ({
    isSuccess: true,
    data: { calendars: {} },
    refetch: vi.fn(),
  }),
  useCalendarsSetCalendarPreference: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCalendarsListEvents: () => ({ isPending: false, isError: false, data: [] }),
}))
vi.mock('../../../components/instances/use-instances-data', () => ({
  HOLDER_QUERY_KEY: 'provider-instances-holder',
  useInstancesData: () => ({
    state: st.state,
    error: null,
    holders: st.holders,
    displayNames: new Map([['google-services', 'Google']]),
    rows: [],
    functionProviders: [],
    descriptions: new Map(),
    refetch: vi.fn(),
  }),
}))
vi.mock('../../../components/instances/InstanceSwitchCell', () => ({
  InstanceSwitchCell: ({ row }: { row: { id: string } }) => <i data-testid={`switch-${row.id}`} />,
}))
vi.mock('../../../components/AdminPage', () => ({
  AdminPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { CalendarsPage } from '../Calendars'

const holder = (enabled: boolean) => ({
  addonId: 'google-services',
  description: {},
  instances: [
    {
      id: 'cal_a',
      name: 'Work',
      configured: true,
      kind: 'calendar',
      enabled,
      formValues: { accountId: 'g1', calendarId: 'work@g' },
    },
  ],
})

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <CalendarsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('CalendarsPage with switched-off calendars', () => {
  beforeEach(() => {
    st.state = 'ready'
  })

  it('lists a switched-off calendar with its switch and does not claim there are no sources', () => {
    st.holders = [holder(false)]
    mount()
    expect(screen.getByTestId('calendars-row-instance:cal_a')).toBeTruthy()
    expect(screen.getByTestId('switch-cal_a')).toBeTruthy()
    expect(screen.queryByTestId('calendars-empty-sources')).toBeNull()
    expect(screen.getByTestId('calendars-empty-hidden')).toBeTruthy()
    expect(screen.queryByTestId('calendars-visible-instance:cal_a')).toBeNull()
  })

  it('says there are no sources only when there are no calendar records at all', () => {
    st.holders = []
    mount()
    expect(screen.getByTestId('calendars-empty-sources')).toBeTruthy()
  })

  it('an unanswered instance query is loading, not "no sources"', () => {
    st.holders = []
    st.state = 'pending'
    mount()
    expect(screen.queryByTestId('calendars-empty-sources')).toBeNull()
  })
})
