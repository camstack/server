import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstancesData } from '../../instances/use-instances-data'
import type { SetInstanceEnabledInput } from '../../instances/use-set-instance-enabled'

const state = vi.hoisted(() => ({
  data: null as unknown,
  mutate: null as unknown,
  onError: null as unknown,
}))

vi.mock('../../instances/use-instances-data', () => ({
  HOLDER_QUERY_KEY: 'provider-instances-holder',
  useInstancesData: () => state.data,
}))
vi.mock('../../instances/use-set-instance-enabled', () => ({
  useSetInstanceEnabled: (o: { onError: (m: string) => void }) => {
    state.onError = o.onError
    return { mutate: state.mutate, isPending: false }
  },
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d: string, v?: Record<string, string>) =>
      Object.entries(v ?? {}).reduce((s, [k, x]) => s.replace(`{{${k}}}`, x), d),
  }),
}))

import { CalendarSourceSwitches } from '../CalendarSourceSwitches'

function data(patch: Partial<InstancesData>): InstancesData {
  return {
    state: 'ready',
    error: null,
    functionProviders: [],
    rows: [],
    holders: [],
    displayNames: new Map(),
    descriptions: new Map(),
    refetch: vi.fn(),
    ...patch,
  }
}
const row = (id: string, name: string, enabled: boolean) => ({
  kind: 'instance' as const,
  key: id,
  addonId: 'google-services',
  providerName: 'Google',
  id,
  name,
  configured: true,
  enabled,
  status: undefined,
  canTest: false,
})

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CalendarSourceSwitches />
    </QueryClientProvider>,
  )
}

describe('CalendarSourceSwitches', () => {
  beforeEach(() => {
    state.mutate = vi.fn()
  })

  it('shows each record at its answered state, off ones included', () => {
    state.data = data({ rows: [row('a', 'Family', true), row('b', 'Work', false)] })
    mount()
    expect(screen.getByTestId('calendar-switch-a').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('calendar-switch-b').getAttribute('aria-checked')).toBe('false')
  })

  it('writes the instance switch through the one door with the flipped value', () => {
    state.data = data({ rows: [row('b', 'Work', false)] })
    mount()
    fireEvent.click(screen.getByTestId('calendar-switch-b'))
    const expected: SetInstanceEnabledInput = { addonId: 'google-services', id: 'b', enabled: true }
    expect(state.mutate).toHaveBeenCalledWith(expected)
  })

  it('a failed write leaves the switch where the record is and says why', () => {
    state.data = data({ rows: [row('b', 'Work', false)] })
    const { rerender } = mount()
    fireEvent.click(screen.getByTestId('calendar-switch-b'))
    act(() => (state.onError as (m: string) => void)('forbidden'))
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <CalendarSourceSwitches />
      </QueryClientProvider>,
    )
    expect(screen.getByTestId('calendar-switch-b').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('alert').textContent).toContain('forbidden')
  })

  it('an unanswered query is pending, never an empty list', () => {
    state.data = data({ state: 'pending' })
    mount()
    expect(screen.getByTestId('calendar-switches-pending')).toBeTruthy()
    expect(screen.queryByTestId('calendar-switches')).toBeNull()
  })

  it('a failed query is an error, not an empty list', () => {
    state.data = data({ state: 'error', error: 'boom' })
    mount()
    expect(screen.getByText('boom')).toBeTruthy()
  })
})
