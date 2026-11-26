import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const state = vi.hoisted(() => ({
  query: { data: undefined, isError: false } as { data: unknown; isError: boolean },
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDaylightPhaseGetPhase: () => state.query,
    useDaylightPhaseSetSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
    DeviceValuePicker: () => <div data-testid="picker" />,
  }
})
vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }
})

import { DaylightPhaseCard } from '../DaylightPhaseCard'

const SENSOR = {
  source: 'sensor',
  deviceId: 7,
  cap: 'ambient-light-sensor',
  fieldPath: 'illuminance',
  darkBelow: 20,
  hysteresis: 10,
  minDwellMin: 15,
} as const

function answer(data: unknown): void {
  state.query = { data, isError: false }
}

describe('DaylightPhaseCard', () => {
  it('a failed query says the phase could not be read, never day or night', () => {
    state.query = { data: undefined, isError: true }
    render(<DaylightPhaseCard />)
    expect(screen.getByText(/could not be read/i)).toBeTruthy()
    expect(screen.queryByText('Day')).toBeNull()
    expect(screen.queryByText('Night')).toBeNull()
  })

  it('a pending query shows loading', () => {
    state.query = { data: undefined, isError: false }
    render(<DaylightPhaseCard />)
    expect(screen.getByText(/Reading the current phase/i)).toBeTruthy()
  })

  it('a null phase is Unknown, with the no-location line only for the sun source', () => {
    answer({ phase: null, configured: { source: 'sun' }, fallbackReason: null, checkedAt: 1 })
    const { unmount } = render(<DaylightPhaseCard />)
    expect(screen.getByText('Unknown')).toBeTruthy()
    expect(screen.getByText(/site has no location/i)).toBeTruthy()
    expect(screen.queryByText('Day')).toBeNull()
    unmount()
    answer({ phase: null, configured: SENSOR, fallbackReason: null, checkedAt: 1 })
    render(<DaylightPhaseCard />)
    expect(screen.queryByText(/site has no location/i)).toBeNull()
  })

  it('a sensor with a sun fallback shows the sun verdict and the reason', () => {
    answer({
      phase: { phase: 'night', since: 1, source: 'sun' },
      configured: SENSOR,
      fallbackReason: 'Porch sensor did not answer.',
      checkedAt: 1,
    })
    render(<DaylightPhaseCard />)
    expect(screen.getByText('Night')).toBeTruthy()
    expect(screen.getByText(/Decided by the sun/i)).toBeTruthy()
    expect(screen.getByTestId('daylight-fallback').textContent).toContain(
      'Porch sensor did not answer.',
    )
  })

  it('a refetch with the same values keeps an edit in progress', () => {
    const make = () => ({
      phase: { phase: 'day', since: 1, source: 'sensor' },
      configured: { ...SENSOR },
      fallbackReason: null,
      checkedAt: 1,
    })
    answer(make())
    const { rerender } = render(<DaylightPhaseCard />)
    const night = () => screen.getByLabelText('Night below') as HTMLInputElement
    const saveBar = () => screen.queryByRole('button', { name: /^save$/i })
    expect(saveBar()).toBeNull()
    fireEvent.change(night(), { target: { value: '55' } })
    expect(saveBar()).not.toBeNull()
    answer(make())
    rerender(<DaylightPhaseCard />)
    expect(saveBar()).not.toBeNull()
  })
})
