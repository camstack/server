// @vitest-environment jsdom
/**
 * The History view lands on the values. Interactions (the actuation list) is a
 * section beside it, hidden until chosen, and absent when the device has no
 * actuation capability.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceTransition } from '@dominevo/types'
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
  useAddonsList: () => ({ data: undefined }),
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

  it('groups the interactions by day and draws each row as one line with no badge', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const noon = new Date(2026, 9, 9, 12, 0, 0).getTime()
    vi.setSystemTime(noon)
    const base = actuationFixturePage(undefined).transitions[0]
    if (base === undefined) throw new Error('fixture is empty')
    const at = (id: string, when: Date): DeviceTransition => ({ ...base, id, at: when.getTime() })
    gate.transitions = [
      at('a', new Date(2026, 9, 9, 11, 30, 5)),
      at('b', new Date(2026, 9, 9, 8, 0, 0)),
      at('c', new Date(2026, 9, 8, 23, 10, 9)),
      at('d', new Date(2026, 9, 4, 10, 0, 0)),
    ]
    try {
      renderHistory(201)
      chooseInteractions()
      const days = screen.getAllByTestId('dc-actuation-day')
      expect(days.map((d) => d.querySelector('h4')?.textContent)).toEqual([
        'Today',
        'Yesterday',
        new Date(2026, 9, 4).toLocaleDateString('en', { day: 'numeric', month: 'short' }),
      ])
      expect(days.map((d) => d.querySelectorAll('[data-testid=dc-actuation-row]').length)).toEqual([
        2, 1, 1,
      ])
      const rows = screen.getAllByTestId('dc-actuation-row')
      expect(screen.getAllByTestId('dc-actuation-clock').map((c) => c.textContent)).toEqual([
        '11:30:05',
        '08:00:00',
        '23:10:09',
        '10:00:00',
      ])
      for (const row of rows) {
        // one line: the time, the change and who, then the details button
        expect(row.querySelectorAll('[data-testid=dc-actuation-line]')).toHaveLength(1)
        expect(row.querySelector('[data-testid=dc-actuation-info]')).not.toBeNull()
        // no outcome badge and no relative time on the row
        expect(row.textContent).not.toMatch(/Confirmed|Failed|Unconfirmed|ago|just now/)
      }
      // the outcome stays in the details
      fireEvent.click(screen.getAllByTestId('dc-actuation-info')[0] as HTMLElement)
      expect(screen.getByTestId('dc-actuation-details').textContent).toContain('Outcome')
    } finally {
      vi.useRealTimers()
    }
  })
})
