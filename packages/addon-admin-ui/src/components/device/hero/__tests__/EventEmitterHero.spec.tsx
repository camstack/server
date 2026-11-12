// @vitest-environment jsdom
/**
 * The one thing this hero has to get right: a NEW press must replace what is
 * on screen. `seq` is the only field that distinguishes two identical presses
 * of the same button — an implementation that keyed the update on `eventType`
 * or `timestamp` would render the first press and then go quiet, which on a
 * pure-input device is indistinguishable from a dead radio.
 *
 * The ui-library boundary is mocked so the assertions are about THIS
 * component: the slice arrives, the component renders it, a changed slice
 * re-renders it.
 */

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface EventFire {
  readonly deviceId: number
  readonly eventType: string
  readonly sourceId?: string
  readonly data: Record<string, unknown> | null
  readonly timestamp: number
  readonly seq: number
}
interface VocabularyEntry {
  readonly id: string
  readonly source?: { readonly id: string; readonly label: string }
  readonly label: string
  readonly description?: string
  readonly kind?: string
}
interface EmitterSlice {
  readonly eventTypes: readonly string[]
  readonly vocabulary?: readonly VocabularyEntry[]
  readonly lastEvent: EventFire | null
  readonly eventCountSinceStart: number
}

const slice = vi.hoisted(() => ({ current: undefined as EmitterSlice | undefined }))
const refresh = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@camstack/ui-library', () => ({
  useSystem: () => ({ trpcClient: {} }),
  useDeviceProxy: () => ({ state: { eventEmitter: { refresh } } }),
  useDeviceStateSlice: () => slice.current,
}))

import { EventEmitterHero } from '../EventEmitterHero'

const heroProps = {
  deviceId: 1446,
  deviceName: 'Buttons',
  deviceType: 'event-emitter',
  provider: 'provider-homematic',
  isOnline: true,
  features: [] as readonly string[],
}

const fire = (seq: number, eventType: string, channel?: number): EventFire => ({
  deviceId: 1446,
  eventType,
  data: channel === undefined ? {} : { channel },
  timestamp: Date.now(),
  seq,
})

describe('EventEmitterHero', () => {
  beforeEach(() => {
    slice.current = undefined
    refresh.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the empty state when the device has never fired', () => {
    slice.current = { eventTypes: ['PRESS_SHORT'], lastEvent: null, eventCountSinceStart: 0 }
    render(<EventEmitterHero {...heroProps} />)
    expect(screen.getByTestId('event-emitter-headline').textContent).toBe('No press recorded')
  })

  it('seeds the slice on mount — the handle cache starts empty', () => {
    slice.current = { eventTypes: [], lastEvent: null, eventCountSinceStart: 0 }
    render(<EventEmitterHero {...heroProps} />)
    expect(refresh).toHaveBeenCalled()
  })

  it('shows the button index and the verbatim event type', () => {
    slice.current = {
      eventTypes: ['PRESS_SHORT', 'PRESS_LONG'],
      lastEvent: fire(1, 'PRESS_SHORT', 2),
      eventCountSinceStart: 1,
    }
    render(<EventEmitterHero {...heroProps} />)
    expect(screen.getByTestId('event-emitter-headline').textContent).toBe('Button 2 · PRESS_SHORT')
  })

  it('omits the channel when the device does not report one', () => {
    slice.current = {
      eventTypes: ['press_short'],
      lastEvent: fire(1, 'press_short'),
      eventCountSinceStart: 1,
    }
    render(<EventEmitterHero {...heroProps} />)
    expect(screen.getByTestId('event-emitter-headline').textContent).toBe('press_short')
  })

  it('renders the declared vocabulary as chips', () => {
    slice.current = {
      eventTypes: ['PRESS_SHORT', 'PRESS_LONG', 'PRESS_LONG_START'],
      lastEvent: null,
      eventCountSinceStart: 0,
    }
    render(<EventEmitterHero {...heroProps} />)
    expect(screen.getAllByTestId('event-emitter-chip').map((c) => c.textContent)).toEqual([
      'PRESS_SHORT',
      'PRESS_LONG',
      'PRESS_LONG_START',
    ])
  })

  it('shows a notice the vocabulary agrees on', () => {
    const notice = 'The CCU does not send these presses — enable button events on the CCU page'
    slice.current = {
      eventTypes: ['PRESS_SHORT'],
      vocabulary: [{ id: 'PRESS_SHORT', label: 'Short press', description: notice }],
      lastEvent: null,
      eventCountSinceStart: 0,
    }
    render(<EventEmitterHero {...heroProps} />)
    expect(screen.getByTestId('event-emitter-notice').textContent).toBe(notice)
  })

  it('a declared vocabulary shows one row per button with labelled presses, and names the last press by them', () => {
    const button = (n: string) => ({ id: n, label: `Button ${n} (channel ${n})` })
    slice.current = {
      eventTypes: ['PRESS_SHORT', 'PRESS_LONG'],
      vocabulary: ['1', '2', '3', '4', '5', '6'].flatMap((n) => [
        { id: 'PRESS_SHORT', source: button(n), label: 'Short press', kind: 'press' },
        { id: 'PRESS_LONG', source: button(n), label: 'Long press', kind: 'long-press' },
      ]),
      lastEvent: { ...fire(4, 'PRESS_LONG'), sourceId: '3', data: { channel: '3' } },
      eventCountSinceStart: 4,
    }
    render(<EventEmitterHero {...heroProps} />)
    const rows = screen.getAllByTestId('event-emitter-source-row')
    expect(rows).toHaveLength(6)
    expect(rows[2]?.textContent).toBe('Button 3 (channel 3)Short pressLong press')
    expect(screen.getByTestId('event-emitter-headline').textContent).toBe(
      'Button 3 (channel 3) · Long press',
    )
    const lit = screen
      .getAllByTestId('event-emitter-chip')
      .filter((chip) => chip.className.includes('text-primary'))
    expect(lit).toHaveLength(1)
    expect(rows[2]?.contains(lit[0] ?? null)).toBe(true)
  })

  // ── the discriminating test ────────────────────────────────────────────────
  it('replaces the displayed event when a new press advances seq', () => {
    slice.current = {
      eventTypes: ['PRESS_SHORT', 'PRESS_LONG'],
      lastEvent: fire(7, 'PRESS_SHORT', 1),
      eventCountSinceStart: 7,
    }
    const view = render(<EventEmitterHero {...heroProps} />)
    expect(screen.getByTestId('event-emitter-headline').textContent).toBe('Button 1 · PRESS_SHORT')

    // A SECOND press — different button, different type, higher seq.
    slice.current = {
      eventTypes: ['PRESS_SHORT', 'PRESS_LONG'],
      lastEvent: fire(8, 'PRESS_LONG', 2),
      eventCountSinceStart: 8,
    }
    view.rerender(<EventEmitterHero {...heroProps} />)
    expect(screen.getByTestId('event-emitter-headline').textContent).toBe('Button 2 · PRESS_LONG')
  })

  it('flashes on a new press and only on a new press', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    slice.current = {
      eventTypes: ['PRESS_SHORT'],
      lastEvent: fire(3, 'PRESS_SHORT', 1),
      eventCountSinceStart: 3,
    }
    const view = render(<EventEmitterHero {...heroProps} />)
    // First slice observed is a SEED, not a press that just happened.
    expect(screen.getByTestId('event-emitter-indicator').dataset.flashing).toBe('false')

    // Same seq re-delivered (a reconcile refresh) must not flash.
    view.rerender(<EventEmitterHero {...heroProps} />)
    expect(screen.getByTestId('event-emitter-indicator').dataset.flashing).toBe('false')

    // A real press.
    slice.current = {
      eventTypes: ['PRESS_SHORT'],
      lastEvent: fire(4, 'PRESS_SHORT', 1),
      eventCountSinceStart: 4,
    }
    view.rerender(<EventEmitterHero {...heroProps} />)
    expect(screen.getByTestId('event-emitter-indicator').dataset.flashing).toBe('true')

    // …and the flash is transient.
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(screen.getByTestId('event-emitter-indicator').dataset.flashing).toBe('false')
  })
})
