// @vitest-environment jsdom
/**
 * The History view lands on the values. Interactions (the actuation list) is a
 * section beside it, hidden until chosen, and absent when the device has no
 * actuation capability.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceTransition } from '@camstack/types'
import { actuationFixturePage } from '../../__fixtures__/actuations'
import type { CardHistory, CardState } from '../model'

const gate = vi.hoisted(() => ({
  presence: 'present' as 'present' | 'absent' | 'pending' | 'unknown',
  isPending: false,
  isError: false,
  transitions: [] as readonly DeviceTransition[],
  hasNextPage: false,
}))

vi.mock('../../../../hooks/use-capability-presence', () => ({
  useCapabilityPresence: () => gate.presence,
}))

vi.mock('../../../../generated/system-hooks', () => ({
  useActionsList: () => ({ data: undefined }),
}))

vi.mock('../../../../trpc-react', () => ({
  trpc: {
    deviceTransitions: {
      listTransitions: {
        useInfiniteQuery: () => ({
          data: { pages: [{ transitions: gate.transitions }] },
          isPending: gate.isPending,
          isError: gate.isError,
          hasNextPage: gate.hasNextPage,
          isFetchingNextPage: false,
          fetchNextPage: () => Promise.resolve(),
        }),
      },
    },
  },
}))

import { HistoryView } from '../Overlays'

const STATE: CardState = { label: 'Heating', since: null, tone: 'primary' }

function history(events: CardHistory['events']): CardHistory {
  return {
    charts: <p data-testid="dc-value-history">24 °C</p>,
    events,
  }
}

function renderHistory(deviceId: number | undefined, events: CardHistory['events'] = null): void {
  render(
    <HistoryView
      state={STATE}
      history={history(events)}
      onBack={() => undefined}
      {...(deviceId === undefined ? {} : { deviceId })}
    />,
  )
}

function chooseInteractions(): void {
  fireEvent.click(screen.getByTestId('dc-history-sections-interactions'))
}

afterEach(() => {
  cleanup()
  gate.presence = 'present'
  gate.isPending = false
  gate.isError = false
  gate.hasNextPage = false
  gate.transitions = []
})

describe('history sections', () => {
  it('lands on the values and keeps interactions hidden until chosen', () => {
    gate.transitions = actuationFixturePage(undefined).transitions
    renderHistory(201)
    expect(screen.getByTestId('dc-history-sections')).toBeTruthy()
    expect(screen.getByTestId('dc-history-sections-values').getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.getByTestId('dc-value-history')).toBeTruthy()
    expect(screen.queryByTestId('dc-actuations')).toBeNull()

    chooseInteractions()
    expect(
      screen.getByTestId('dc-history-sections-interactions').getAttribute('aria-checked'),
    ).toBe('true')
    expect(screen.queryByTestId('dc-value-history')).toBeNull()
    expect(screen.getAllByTestId('dc-actuation-row').length).toBeGreaterThan(0)
  })

  it('shows no switch and only the values when the device has no actuation capability', () => {
    gate.presence = 'absent'
    gate.transitions = actuationFixturePage(undefined).transitions
    renderHistory(201)
    expect(screen.queryByTestId('dc-history-sections')).toBeNull()
    expect(screen.getByTestId('dc-value-history')).toBeTruthy()
    expect(screen.queryByTestId('dc-actuations')).toBeNull()
  })

  it('keeps an unanswered read and an empty list inside Interactions', () => {
    gate.isError = true
    renderHistory(201)
    chooseInteractions()
    expect(screen.getByTestId('dc-actuations-unread')).toBeTruthy()
    expect(screen.queryByTestId('dc-actuations-empty')).toBeNull()
    cleanup()

    gate.isError = false
    gate.transitions = []
    renderHistory(201)
    chooseInteractions()
    expect(screen.getByTestId('dc-actuations-empty')).toBeTruthy()
  })

  it('shows a skeleton inside Interactions while the list is still loading', () => {
    gate.presence = 'pending'
    gate.isPending = true
    renderHistory(201)
    expect(screen.queryByTestId('dc-actuations')).toBeNull()
    chooseInteractions()
    expect(screen.getByTestId('dc-actuations-skeleton')).toBeTruthy()
  })

  it('still switches a card that only has recorded events', () => {
    renderHistory(undefined, [
      { id: 'e1', day: 'Today', actor: 'Ada', text: 'Turned on', time: '08:12' },
    ])
    expect(screen.getByTestId('dc-value-history')).toBeTruthy()
    expect(screen.queryByText('Turned on')).toBeNull()
    chooseInteractions()
    expect(screen.getByText('Turned on')).toBeTruthy()
    expect(screen.queryByTestId('dc-value-history')).toBeNull()
    expect(screen.queryByTestId('dc-actuations')).toBeNull()
  })
})
