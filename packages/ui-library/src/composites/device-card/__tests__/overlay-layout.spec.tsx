// @vitest-environment jsdom
/**
 * An overlay (History) is a pinned top and ONE scrolling region, in the box
 * of the detail it replaces: the admin keeps that detail's measured height,
 * a host that sized the card (the viewer's sheet) gets the overlay filling it.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockupCommon } from '../__fixtures__/common'
import { DeviceCard, DeviceCardFrameProvider } from '../shell/DeviceCard'

vi.mock('../../../hooks/use-capability-presence', () => ({
  useCapabilityPresence: () => 'absent',
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const COMMON = {
  ...mockupCommon({
    name: 'Washer plug',
    integration: 'Homematic (Casa)',
    watts: 38,
    supplyName: 'Laundry',
    consumables: [],
    remote: [],
  }),
  history: { charts: <p data-testid="dc-value-history">24 °C</p>, events: null },
}

function card() {
  return (
    <DeviceCard
      kind="plug"
      common={COMMON}
      state={{ label: 'On', since: null, tone: 'primary' }}
      scene={{ image: <span>scene</span> }}
    />
  )
}

function scrollers(root: HTMLElement): readonly Element[] {
  return [...root.querySelectorAll('*')].filter((el) =>
    el.className.toString().includes('overflow-y-auto'),
  )
}

function openHistory(): void {
  fireEvent.click(screen.getByTestId('dc-state'))
}

describe('overlay layout', () => {
  it('has a pinned top and exactly one scrolling region inside the card', () => {
    render(card())
    openHistory()
    const article = screen.getByTestId('device-card')
    expect(scrollers(article)).toHaveLength(1)
    const scroller = screen.getByTestId('dc-overlay-scroll')
    expect(scrollers(article)[0]).toBe(scroller)
    const top = screen.getByTestId('dc-overlay-top')
    expect(scroller.contains(top)).toBe(false)
    expect(top.contains(screen.getByTestId('dc-back'))).toBe(true)
    expect(scroller.contains(screen.getByTestId('dc-value-history'))).toBe(true)
  })

  it('keeps the height of the detail it replaces', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      height: 321,
      width: 300,
      top: 0,
      left: 0,
      right: 300,
      bottom: 321,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    render(card())
    openHistory()
    const overlay = screen.getByTestId('dc-history')
    expect(overlay.getAttribute('data-locked')).toBe('true')
    expect((overlay as HTMLElement).style.height).toBe('321px')
  })

  it('fills the host height when the host sized the card, with no locked height', () => {
    render(
      <DeviceCardFrameProvider frame="bare" fill>
        {card()}
      </DeviceCardFrameProvider>,
    )
    openHistory()
    const overlay = screen.getByTestId('dc-history')
    expect(overlay.className).toContain('flex-1')
    expect((overlay as HTMLElement).style.height).toBe('')
    expect(screen.getByTestId('device-card').className).toContain('h-full')
    expect(scrollers(screen.getByTestId('device-card'))).toHaveLength(1)
  })
})
