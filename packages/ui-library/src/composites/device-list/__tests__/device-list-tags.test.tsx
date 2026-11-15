// @vitest-environment jsdom
/**
 * Tags on the device list (D1054): the search matches a tag name, each row
 * shows its tags, and the by-tag view lists a device with two tags under both,
 * untagged last.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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

const DEVICES = [
  dev(1, { name: 'Porch cam', tags: ['Garden', 'Night'] }),
  dev(2, { name: 'Shed cam', tags: ['Garden'] }),
  dev(3, { name: 'Hall cam' }),
]

function renderList(devices: readonly DeviceItemDevice[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <DeviceList devices={devices} trpc={mockTrpc} />
    </QueryClientProvider>,
  )
}

describe('<DeviceList> — tags', () => {
  it('the search matches a tag name, and a row shows its tags', () => {
    renderList(DEVICES)
    fireEvent.change(screen.getByLabelText('Search devices by name, stableId or tag'), {
      target: { value: 'night' },
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(screen.getByText('Porch cam')).toBeTruthy()
    expect(screen.queryByText('Shed cam')).toBeNull()
    expect(screen.queryByText('Hall cam')).toBeNull()
    expect(screen.getAllByText('Night').length).toBeGreaterThan(0)
  })

  it('by tag: a device with two tags is under both, untagged last', () => {
    renderList(DEVICES)
    fireEvent.click(screen.getByRole('radio', { name: 'By tag' }))
    const groups = within(screen.getByTestId('tag-groups-devices')).getAllByRole('region')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Garden', 'Night', 'No tag'])
    expect(within(groups[0] as HTMLElement).getByText('Porch cam')).toBeTruthy()
    expect(within(groups[1] as HTMLElement).getByText('Porch cam')).toBeTruthy()
    expect(within(groups[2] as HTMLElement).getByText('Hall cam')).toBeTruthy()
  })

  it('by tag: the pager stays, and a page holds only its window of grouped rows', () => {
    const many = [
      ...Array.from({ length: 40 }, (_, i) =>
        dev(i + 1, { name: `Garden ${i + 1}`, tags: ['Garden'] }),
      ),
      ...Array.from({ length: 20 }, (_, i) => dev(i + 41, { name: `Plain ${i + 41}` })),
    ]
    renderList(many)
    fireEvent.click(screen.getByRole('radio', { name: 'By tag' }))
    // 60 grouped rows, 50 per page: Garden 40 + the first 10 untagged.
    expect(screen.getByText('Showing 1–50 of 60 devices')).toBeTruthy()
    expect(screen.getByLabelText('Devices per page')).toBeTruthy()
    expect(screen.getByText('Plain 50')).toBeTruthy()
    expect(screen.queryByText('Plain 51')).toBeNull()
    fireEvent.click(screen.getByLabelText('Next page'))
    expect(screen.queryByText('Garden 1')).toBeNull()
    expect(screen.getByText('Plain 51')).toBeTruthy()
    // The group header counts the whole group, not the page's slice.
    const groups = within(screen.getByTestId('tag-groups-devices')).getAllByRole('region')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['No tag'])
    expect(within(groups[0] as HTMLElement).getByText('20')).toBeTruthy()
  })
})
