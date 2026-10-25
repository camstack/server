// @vitest-environment jsdom
/**
 * A search NARROWS the device table; it never opens a parent row.
 *
 * It used to: every parent one of whose accessories matched the term was
 * forced open, and on a fleet where accessories carry their parent's name
 * ("Kitchen cam siren") the term that finds a container matches all of its
 * children — three hits became a wall of accessory rows. The other half of
 * the same bug: the forced state OVERWROTE what the operator had opened, so a
 * row opened by hand snapped shut when the search ended.
 *
 * Two claims, asserted through the DOM the operator sees:
 *   1. a search leaves every chevron closed;
 *   2. what the operator opened stays open — through a search that hides
 *      the row and through the clearing that brings it back.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'
import type { DeviceItemDevice } from '../../device-item/helpers'
import { DeviceList } from '../index'

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { writable: true, value: RO })
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

beforeEach(() => {
  vi.useFakeTimers()
  window.history.replaceState(null, '', '/devices')
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

const mockTrpc = {
  deviceManager: { getBindings: { query: async () => ({ deviceId: 0, entries: [] }) } },
} as unknown as UseDeviceProxyTrpc

const dev = (id: number, overrides: Partial<DeviceItemDevice> = {}): DeviceItemDevice => ({
  id,
  stableId: `s-${id}`,
  addonId: 'rtsp',
  type: 'camera',
  name: `Cam ${id}`,
  online: true,
  disabled: false,
  parentDeviceId: null,
  role: null,
  ...overrides,
})

/** A camera whose accessories carry its name — the shape that turned a search
 *  into a wall of rows. */
const KITCHEN = [
  dev(1, { name: 'Kitchen cam' }),
  dev(2, { name: 'Kitchen cam siren', role: 'siren', parentDeviceId: 1, type: 'siren' }),
  dev(3, { name: 'Kitchen cam floodlight', role: 'floodlight', parentDeviceId: 1, type: 'light' }),
]
const LIVING_ROOM = dev(4, { name: 'Hall cam' })

function renderList(devices: readonly DeviceItemDevice[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <DeviceList devices={devices} trpc={mockTrpc} />
    </QueryClientProvider>,
  )
}

/** Type a term and let the 300 ms debounce push it into the list state. */
function search(term: string): void {
  fireEvent.change(screen.getByLabelText('Search devices by name or stableId'), {
    target: { value: term },
  })
  act(() => {
    vi.advanceTimersByTime(300)
  })
}

function bodyRowCount(container: HTMLElement): number {
  return container.querySelectorAll('tbody tr').length
}

describe('<DeviceList> — a search never opens a parent', () => {
  it('leaves the parent closed when the term matches its accessories', () => {
    const { container } = renderList([...KITCHEN, LIVING_ROOM])
    search('kitchen')

    // The parent matched and is the only row — its accessories stay folded.
    expect(bodyRowCount(container)).toBe(1)
    // The accessory row renders its name with the parent prefix stripped.
    expect(screen.queryByText(/siren/)).toBeNull()
    expect(screen.getByLabelText('Expand children').getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps a parent the operator opened open across a search that hides it', () => {
    const { container } = renderList([...KITCHEN, LIVING_ROOM])

    fireEvent.click(screen.getByLabelText('Expand children'))
    expect(bodyRowCount(container)).toBe(4) // kitchen + 2 accessories + hall

    // The search hides the kitchen row entirely …
    search('hall')
    expect(bodyRowCount(container)).toBe(1)
    expect(screen.queryByText('Kitchen cam')).toBeNull()

    // … and clearing it brings the row back STILL OPEN. State owned by the
    // row would have died with it and the operator's click with it.
    search('')
    expect(bodyRowCount(container)).toBe(4)
    expect(screen.getAllByText(/siren/).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Collapse children').getAttribute('aria-expanded')).toBe('true')
  })

  it('a search does not close a parent the operator opened, and clearing it does not either', () => {
    const { container } = renderList([...KITCHEN, LIVING_ROOM])

    fireEvent.click(screen.getByLabelText('Expand children'))
    search('kitchen')
    // Still open: the parent still matches, and the search wrote nothing.
    expect(bodyRowCount(container)).toBe(3)

    search('')
    expect(bodyRowCount(container)).toBe(4)
    expect(screen.getByLabelText('Collapse children')).toBeDefined()
  })
})
